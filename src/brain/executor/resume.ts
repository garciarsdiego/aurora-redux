import type Database from 'better-sqlite3';
import type { Workflow } from '../../types/index.js';
import { initDb } from '../../db/client.js';
import {
  insertEvent,
  loadWorkflowById,
  setTaskSkipped,
} from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';
import { loadWorkspaceEnv } from '../../utils/workspace.js';
import type { ExecuteWorkflowOpts } from './types.js';
import { continueWorkflowExecution } from './orchestrate.js';

export type ResumeWorkflowOptions = ExecuteWorkflowOpts & {
  /** When true, convert all failed tasks to skipped instead of re-running the latest failure. */
  skipFailedSteps?: boolean;
  /**
   * When provided (e.g. REPL), resume uses this connection instead of opening
   * `getDbPath()` so in-process callers stay on the same DB.
   */
  db?: Database.Database;
};

function safeJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * For paused / interrupted workflows: if a HITL gate was already resolved
 * (dashboard/API) while the executor died, apply that outcome so we do not
 * open a second gate for the same pending task.
 */
function applyResolvedHitlGatesForResume(db: Database.Database, workflowId: string): void {
  const rows = db
    .prepare(
      `SELECT g.task_id, g.status, g.context_json
         FROM hitl_gates g
         INNER JOIN tasks t ON t.id = g.task_id AND t.workflow_id = g.workflow_id
        WHERE g.workflow_id = ?
          AND g.task_id IS NOT NULL
          AND g.status != 'pending'
          AND t.status = 'pending'
          AND t.hitl = 1
        ORDER BY g.decided_at DESC NULLS LAST, g.created_at DESC`,
    )
    .all(workflowId) as Array<{ task_id: string; status: string; context_json: string | null }>;

  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.task_id || seen.has(row.task_id)) continue;
    seen.add(row.task_id);

    if (row.status === 'approved') {
      db.prepare('UPDATE tasks SET hitl = 0 WHERE id = ?').run(row.task_id);
      continue;
    }

    if (row.status === 'modify') {
      const ctx = safeJson(row.context_json);
      const modified = ctx['modified_input'];
      if (modified !== undefined) {
        const taskRow = db
          .prepare('SELECT input_json FROM tasks WHERE id = ?')
          .get(row.task_id) as { input_json: string | null } | undefined;
        const base = safeJson(taskRow?.input_json ?? null);
        const merged =
          modified && typeof modified === 'object' && !Array.isArray(modified)
            ? { ...base, ...(modified as Record<string, unknown>) }
            : { ...base, modified_input: modified };
        db.prepare('UPDATE tasks SET input_json = ?, hitl = 0 WHERE id = ?').run(
          JSON.stringify(merged),
          row.task_id,
        );
      } else {
        db.prepare('UPDATE tasks SET hitl = 0 WHERE id = ?').run(row.task_id);
      }
    }
  }
}

function clearStaleCancelMetadata(db: Database.Database, wf: Workflow): void {
  if (!wf.metadata) return;
  const meta = safeJson(wf.metadata);
  if (
    meta['cancelled_at'] === undefined &&
    meta['cancelled_reason'] === undefined &&
    meta['cancel_propagation'] === undefined &&
    meta['cancel_requested'] === undefined
  ) {
    return;
  }
  const next = { ...meta };
  delete next['cancelled_at'];
  delete next['cancelled_reason'];
  delete next['cancel_propagation'];
  delete next['cancel_requested'];
  next['resume_cleared_cancel_at'] = Date.now();
  db.prepare('UPDATE workflows SET metadata = ? WHERE id = ?').run(JSON.stringify(next), wf.id);
}

/**
 * Mutates DB so `continueWorkflowExecution` can drive the workflow forward.
 */
export function prepareWorkflowForResume(
  db: Database.Database,
  workflowId: string,
  options: Pick<ResumeWorkflowOptions, 'skipFailedSteps'>,
): Workflow {
  // Wave-1.5 triage #3 — run the multi-write prep (cancel-metadata clear, task
  // re-pend, workflow status flip, resume event) in ONE transaction so a failure
  // partway can't leave a half-prepared workflow (e.g. tasks re-pended but the
  // workflow never flipped to executing). The body issues plain statements (no
  // nested transactions); a throw rolls the whole prep back and propagates.
  return db.transaction(() => prepareWorkflowForResumeInTxn(db, workflowId, options))();
}

function prepareWorkflowForResumeInTxn(
  db: Database.Database,
  workflowId: string,
  options: Pick<ResumeWorkflowOptions, 'skipFailedSteps'>,
): Workflow {
  const wf = loadWorkflowById(db, workflowId);
  if (!wf) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }

  const terminalBlocked = new Set(['completed']);
  if (terminalBlocked.has(wf.status)) {
    throw new Error(`Workflow ${workflowId} is completed and cannot be resumed`);
  }

  const prior = wf.status;
  clearStaleCancelMetadata(db, wf);

  const meta = safeJson(loadWorkflowById(db, workflowId)?.metadata ?? null);
  const anchorStep =
    typeof meta['current_step_id'] === 'string' ? meta['current_step_id'] : null;

  if (prior === 'failed') {
    if (options.skipFailedSteps) {
      const failedRows = db
        .prepare(
          `SELECT id FROM tasks WHERE workflow_id = ? AND status = 'failed'`,
        )
        .all(workflowId) as { id: string }[];
      const now = Date.now();
      for (const r of failedRows) {
        setTaskSkipped(
          db,
          r.id,
          JSON.stringify({ skip_reason: 'resume_skip_failed', at: now }),
        );
      }
    } else {
      const row = db
        .prepare(
          `SELECT id FROM tasks
            WHERE workflow_id = ? AND status = 'failed'
            ORDER BY completed_at DESC NULLS LAST, rowid DESC
            LIMIT 1`,
        )
        .get(workflowId) as { id: string } | undefined;
      if (row) {
        db.prepare(
          `UPDATE tasks
              SET status = 'pending',
                  started_at = NULL,
                  completed_at = NULL,
                  output_json = NULL
            WHERE id = ?`,
        ).run(row.id);
      }
    }
  }

  if (prior === 'cancelled') {
    // Re-pend every cancelled task, but when an anchor step is known, scope
    // the re-pend to tasks created at/after the anchor (tasks cancelled
    // before the resume point stay cancelled). Falls back to the unscoped
    // UPDATE when there is no anchor, or the anchor row itself vanished.
    const anchor = anchorStep
      ? (db
          .prepare(`SELECT created_at FROM tasks WHERE workflow_id = ? AND id = ?`)
          .get(workflowId, anchorStep) as { created_at: number } | undefined)
      : undefined;
    const anchorClause = anchor ? ' AND created_at >= ?' : '';
    const params = anchor ? [workflowId, anchor.created_at] : [workflowId];
    db.prepare(
      `UPDATE tasks
          SET status = 'pending',
              started_at = NULL,
              completed_at = NULL
        WHERE workflow_id = ?
          AND status = 'cancelled'${anchorClause}`,
    ).run(...params);
  }

  if (prior === 'paused' || prior === 'executing') {
    applyResolvedHitlGatesForResume(db, workflowId);
  }

  db.prepare(
    `UPDATE workflows SET status = 'executing', completed_at = NULL WHERE id = ?`,
  ).run(workflowId);

  insertEvent(db, {
    workflow_id: workflowId,
    type: 'workflow_resume_prepared',
    payload: {
      prior_status: prior,
      skip_failed_steps: options.skipFailedSteps === true,
      current_step_id: anchorStep,
    },
  });

  const refreshed = loadWorkflowById(db, workflowId);
  if (!refreshed) {
    throw new Error(`Workflow vanished during resume prep: ${workflowId}`);
  }
  return { ...refreshed, status: 'executing', completed_at: null };
}

/**
 * High-level resume entry: restore workflow/tasks after failed / cancelled /
 * paused runs, then re-inject into the orchestrator loop.
 */
export async function resumeWorkflow(
  workflowId: string,
  options: ResumeWorkflowOptions = {},
): Promise<Workflow> {
  const { db: injectedDb, skipFailedSteps, ...execOpts } = options;
  const db = injectedDb ?? initDb(getDbPath());
  const shouldClose = injectedDb === undefined;
  try {
    const wfProbe = loadWorkflowById(db, workflowId);
    if (!wfProbe) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }
    loadWorkspaceEnv(wfProbe.workspace);
    const workflow = prepareWorkflowForResume(db, workflowId, { skipFailedSteps });
    return await continueWorkflowExecution(db, workflow, execOpts);
  } finally {
    if (shouldClose) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}
