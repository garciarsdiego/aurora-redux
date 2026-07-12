// FASE 1B Bloco A.1 — Steer / kill / cleanup control layer.
//
// Module-level AbortController registry: process-local, intentionally not
// persisted. On process death any in-flight rows left in 'running' are
// handled by orphan-recovery on the next startup sweep.
//
// Constraints:
//   - No imports from registry.ts / spawn.ts / outbox.ts / inbox.ts (parallel
//     agents, not yet written).
//   - insertEvent from src/db/persist.ts is the only persist helper needed.
//   - All SQL is fully parameterized.
//   - No silent catch blocks.

import type Database from 'better-sqlite3';
import { insertEvent } from '../../db/persist.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import { cancelPendingForTask } from './outbox.js';

// ─── Module-level registry ─────────────────────────────────────────────────

const _controllerMap = new Map<string, AbortController>();

// ─── Registry API ──────────────────────────────────────────────────────────

export function registerAbortController(taskId: string, ac: AbortController): void {
  _controllerMap.set(taskId, ac);
}

export function unregisterAbortController(taskId: string): void {
  _controllerMap.delete(taskId);
}

export function hasAbortController(taskId: string): boolean {
  return _controllerMap.has(taskId);
}

/** Test helper — clears the registry between test cases. */
export function _resetControlRegistry(): void {
  _controllerMap.clear();
}

// ─── Internal helpers ──────────────────────────────────────────────────────

type TaskStatusRow = { status: string; workflow_id: string } | undefined;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function readTaskRow(
  db: Database.Database,
  taskId: string,
): TaskStatusRow {
  return db
    .prepare('SELECT status, workflow_id FROM tasks WHERE id = ?')
    .get(taskId) as TaskStatusRow;
}

/** Aborts the AbortController registered for `id`, if any. Returns whether one was found. */
function abortIfRegistered(id: string): boolean {
  const ac = _controllerMap.get(id);
  if (ac === undefined) return false;
  ac.abort();
  return true;
}

/**
 * Shared terminal-state transition used by both kill() and
 * broadcastCancelToWorkflow(): aborts the task's controller if registered,
 * flips tasks.status to a terminal value, marks any still-active
 * subagent_runs 'killed', and cancels pending mailbox messages for the
 * task. Callers remain responsible for their own insertEvent calls — kill()
 * and broadcastCancelToWorkflow() emit different event types/payloads, one
 * of which needs the message count this function returns.
 */
function terminateTaskState(
  db: Database.Database,
  taskId: string,
  taskStatus: 'failed' | 'cancelled',
  errorMsg: string,
  now: number,
): { had_controller: boolean; messages_cancelled: number } {
  const had_controller = abortIfRegistered(taskId);

  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?`,
    ).run(taskStatus, now, taskId),
  );

  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE subagent_runs
        SET status = 'killed', error_msg = ?, ended_at = ?
      WHERE task_id = ? AND status IN ('pending', 'running')`,
    ).run(errorMsg, now, taskId),
  );

  const messages_cancelled = cancelPendingForTask(db, taskId);

  return { had_controller, messages_cancelled };
}

// ─── steer ─────────────────────────────────────────────────────────────────

export function steer(
  db: Database.Database,
  taskId: string,
  instruction: string,
): 'accepted' | 'not_found' | 'already_done' {
  const row = readTaskRow(db, taskId);
  if (row === undefined) return 'not_found';
  if (TERMINAL_STATUSES.has(row.status)) return 'already_done';

  withSqliteRetrySync(() =>
    db.prepare('UPDATE tasks SET steer_instruction = ? WHERE id = ?').run(
      instruction,
      taskId,
    ),
  );

  insertEvent(db, {
    workflow_id: row.workflow_id,
    task_id: taskId,
    type: 'task_steer_received',
    payload: { instruction, source: 'control_api' },
  });

  abortIfRegistered(taskId);

  return 'accepted';
}

// ─── kill ──────────────────────────────────────────────────────────────────

export function kill(
  db: Database.Database,
  taskId: string,
  reason: string,
): 'killed' | 'not_found' | 'already_done' {
  const row = readTaskRow(db, taskId);
  if (row === undefined) return 'not_found';
  if (TERMINAL_STATUSES.has(row.status)) return 'already_done';

  const now = Date.now();
  const { messages_cancelled } = terminateTaskState(db, taskId, 'failed', reason, now);

  insertEvent(db, {
    workflow_id: row.workflow_id,
    task_id: taskId,
    type: 'task_killed',
    payload: { reason },
  });

  // Killed tasks must not leave dangling messages in the queue (R-HIGH-4).
  // Cancel both outbound (from_task_id=killedTaskId) and inbound
  // (to_task_id=killedTaskId) — the consumer is dead, the producer's
  // results no longer feed anything downstream.
  if (messages_cancelled > 0) {
    insertEvent(db, {
      workflow_id: row.workflow_id,
      task_id: taskId,
      type: 'subagent_messages_cancelled',
      payload: { count: messages_cancelled, cause: 'task_killed' },
    });
  }

  return 'killed';
}

// ─── broadcast cancel to workflow (Sprint 2.1, F-REL-1) ───────────────────

/**
 * Hard-cancel every in-flight task of a workflow.
 *
 * Iterates over tasks whose status is in ('running', 'pending', 'ready',
 * 'waiting'), aborts any registered AbortController (which propagates to
 * Omniroute fetches via signal AND to spawned CLI children via tree-kill
 * in `runCliTask:458-470`), marks the task row as 'cancelled', cancels
 * pending mailbox messages, and emits a `task_cancelled_by_workflow` event
 * per task. Returns aggregate counts.
 *
 * Difference from `kill()`: kill is per-task with explicit reason and uses
 * status='failed'. This broadcast variant uses status='cancelled' to
 * preserve the operator's intent in audit (cancel != failure).
 *
 * Operator semantics: this is what the Studio "Cancel run" button must call
 * to actually terminate work. Before Sprint 2 the cancel was "soft" — DB
 * rows flipped but processes kept running until timeout (F-REL-1).
 */
export function broadcastCancelToWorkflow(
  db: Database.Database,
  workflowId: string,
  reason: string | null,
): { tasks_cancelled: number; controllers_aborted: number; messages_cancelled: number } {
  type TaskRow = { id: string; status: string };
  const rows = db
    .prepare(
      `SELECT id, status FROM tasks
        WHERE workflow_id = ?
          AND status IN ('running', 'pending', 'ready', 'waiting')`,
    )
    .all(workflowId) as TaskRow[];

  const now = Date.now();
  let tasksCancelled = 0;
  let controllersAborted = 0;
  let messagesCancelled = 0;

  for (const row of rows) {
    const { had_controller, messages_cancelled } = terminateTaskState(
      db,
      row.id,
      'cancelled',
      reason ?? 'workflow_cancelled',
      now,
    );
    if (had_controller) controllersAborted++;
    tasksCancelled++;
    messagesCancelled += messages_cancelled;

    insertEvent(db, {
      workflow_id: workflowId,
      task_id: row.id,
      type: 'task_cancelled_by_workflow',
      payload: {
        reason: reason ?? null,
        had_controller,
        prior_status: row.status,
        messages_cancelled,
      },
    });
  }

  // Wave 2 security-review H1: when cancelling a parent workflow that has
  // an in-flight remediation child (W2), recursively broadcast the cancel
  // to the child so it doesn't keep running unsupervised. FK CASCADE only
  // fires on DELETE — cancel is a soft state flip, not a row delete.
  // The query is bounded by the live child set; loop terminates because
  // children cannot be their own parents (FK + app-level invariant).
  try {
    type ChildRow = { id: string };
    const children = db
      .prepare(
        `SELECT id FROM workflows
          WHERE parent_workflow_id = ?
            AND status IN ('pending', 'executing', 'paused', 'awaiting_remediation')`,
      )
      .all(workflowId) as ChildRow[];
    for (const child of children) {
      const childResult = broadcastCancelToWorkflow(db, child.id, reason ?? 'parent_cancelled');
      tasksCancelled += childResult.tasks_cancelled;
      controllersAborted += childResult.controllers_aborted;
      messagesCancelled += childResult.messages_cancelled;
    }
  } catch (err) {
    // Cascade failure must NOT prevent the parent cancel from succeeding.
    // Audit the failure but let the caller observe the parent-level cancel
    // as completed. Operator can manually cancel the orphan child via
    // the dashboard.
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'workflow_cancel_requested',
      payload: {
        scope: 'child_cascade_failed',
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  return {
    tasks_cancelled: tasksCancelled,
    controllers_aborted: controllersAborted,
    messages_cancelled: messagesCancelled,
  };
}

// ─── cleanup ───────────────────────────────────────────────────────────────

/**
 * Mark all still-active subagent_runs for `taskId` as administratively closed
 * because the parent task ended. Does NOT use status='complete' — that would
 * lie to downstream metrics about successful subagent outcomes (R-HIGH-2/3).
 * Instead, status='killed' with a discriminator error_msg so observers can
 * distinguish parent-cleanup from a real completion.
 *
 * Skips runs whose run_id is in the AbortController map (those are actively
 * dispatching and own their own terminal write).
 */
export function cleanup(
  db: Database.Database,
  taskId: string,
): { runs_marked: number } {
  // Resolve workflow_id once and scope the SELECT to it. Today task_id is a
  // PK so it is 1:1 with workflow_id, but explicit scoping keeps cleanup
  // safe under any future schema relaxation (R-MED-4).
  const taskRow = db
    .prepare('SELECT workflow_id FROM tasks WHERE id = ?')
    .get(taskId) as { workflow_id: string } | undefined;
  if (taskRow === undefined) return { runs_marked: 0 };

  type RunRow = { run_id: string };
  const rows = db
    .prepare(
      `SELECT run_id FROM subagent_runs
       WHERE task_id = ? AND workflow_id = ? AND status IN ('pending', 'running')`,
    )
    .all(taskId, taskRow.workflow_id) as RunRow[];

  const now = Date.now();
  let runs_marked = 0;

  for (const r of rows) {
    // Skip runs with an active in-flight controller — they own their own
    // terminal write via run-task / executor.
    if (_controllerMap.has(r.run_id)) continue;

    withSqliteRetrySync(() =>
      db.prepare(
        `UPDATE subagent_runs
          SET status    = 'killed',
              error_msg = 'parent_task_cleanup',
              ended_at  = ?
        WHERE run_id = ?`,
      ).run(now, r.run_id),
    );
    runs_marked++;
  }

  if (runs_marked > 0) {
    insertEvent(db, {
      workflow_id: taskRow.workflow_id,
      task_id: taskId,
      type: 'task_cleaned_up',
      payload: { runs_marked, cause: 'parent_task_cleanup' },
    });
  }

  return { runs_marked };
}
