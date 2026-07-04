// FASE 1B Bloco A.1 — Subagent run registry.
// Pure DB-backed CRUD over `subagent_runs`. No in-memory cache — the DB is
// the single source of truth, which also makes orphan-recovery trivial.
//
// Pattern: parameterized prepare + run/get/all everywhere (matches persist.ts).

import type Database from 'better-sqlite3';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import type {
  SubagentRunRow,
  RegisterSubagentRunParams,
  SubagentStatus,
  SubagentOutcome,
} from './types.js';

// ─── Write helpers ────────────────────────────────────────────────────────────

export function registerSubagentRun(
  db: Database.Database,
  params: RegisterSubagentRunParams,
): SubagentRunRow {
  const now = Date.now();
  const cleanup = params.cleanup ?? 'delete';
  const spawnMode = params.spawnMode ?? 'run';
  const parentRunId = params.parentRunId ?? null;
  const model = params.model ?? null;
  const timeoutSeconds = params.timeoutSeconds ?? null;

  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO subagent_runs
       (run_id, task_id, workflow_id, parent_run_id, depth, model,
        task_text, status, result_text, error_msg,
        cleanup, spawn_mode, timeout_seconds,
        created_at, started_at, ended_at, archive_after_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      params.runId,
      params.taskId,
      params.workflowId,
      parentRunId,
      params.depth,
      model,
      params.taskText,
      cleanup,
      spawnMode,
      timeoutSeconds,
      now,
    ),
  );

  // Return the canonical row rather than constructing from params so callers
  // always see what is actually stored (type coercions, defaults, etc.).
  return getRunById(db, params.runId) as SubagentRunRow;
}

export function markRunStarted(db: Database.Database, runId: string): void {
  // Idempotent: only flip to 'running' when still pending.
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE subagent_runs
        SET status = 'running', started_at = ?
      WHERE run_id = ? AND status = 'pending'`,
    ).run(Date.now(), runId),
  );
}

/**
 * Persist a terminal outcome on a subagent run. Returns `true` when the row
 * actually transitioned (was pending/running) and `false` when the row was
 * already terminal (no-op). Callers can use the boolean to detect a logic
 * bug (e.g. completing a killed run) and log accordingly.
 */
export function markRunComplete(
  db: Database.Database,
  runId: string,
  outcome: SubagentOutcome,
): boolean {
  // Map outcome.status to SubagentStatus. 'ok' → 'complete'; the rest are
  // identical string values between the two union types.
  const rowStatus: SubagentStatus =
    outcome.status === 'ok' ? 'complete' : outcome.status;

  // No-op if already terminal (complete / error / killed / timeout).
  // Only update when status is 'pending' or 'running'.
  const info = withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE subagent_runs
        SET status      = ?,
            result_text = ?,
            error_msg   = ?,
            ended_at    = ?
      WHERE run_id = ? AND status IN ('pending', 'running')`,
    ).run(
      rowStatus,
      outcome.resultText ?? null,
      outcome.errorMsg ?? null,
      Date.now(),
      runId,
    ),
  );

  return info.changes > 0;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export function getRunById(
  db: Database.Database,
  runId: string,
): SubagentRunRow | null {
  return (
    db
      .prepare(`SELECT * FROM subagent_runs WHERE run_id = ?`)
      .get(runId) as SubagentRunRow | undefined
  ) ?? null;
}

export function listRunsForTask(
  db: Database.Database,
  taskId: string,
): SubagentRunRow[] {
  return db
    .prepare(`SELECT * FROM subagent_runs WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as SubagentRunRow[];
}

export function listRunsForWorkflow(
  db: Database.Database,
  workflowId: string,
  filter?: { status?: SubagentStatus | SubagentStatus[] },
): SubagentRunRow[] {
  if (filter?.status === undefined) {
    return db
      .prepare(`SELECT * FROM subagent_runs WHERE workflow_id = ? ORDER BY created_at ASC`)
      .all(workflowId) as SubagentRunRow[];
  }

  const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
  // Build a parameterized IN clause — no string interpolation of user values.
  const placeholders = statuses.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT * FROM subagent_runs
        WHERE workflow_id = ?
          AND status IN (${placeholders})
        ORDER BY created_at ASC`,
    )
    .all(workflowId, ...statuses) as SubagentRunRow[];
}

export function countActiveRunsForTask(
  db: Database.Database,
  taskId: string,
): number {
  // active = pending OR running
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM subagent_runs
        WHERE task_id = ? AND status IN ('pending', 'running')`,
    )
    .get(taskId) as { cnt: number };
  return row.cnt;
}

export function countActiveDescendants(
  db: Database.Database,
  parentRunId: string,
): number {
  // Recursive CTE that walks the tree rooted at parentRunId.
  // The anchor selects direct children; the recursive part extends to all
  // descendants. We then count only the active (pending/running) ones.
  const row = db
    .prepare(
      `WITH RECURSIVE descendants(run_id) AS (
         -- anchor: direct children
         SELECT run_id FROM subagent_runs WHERE parent_run_id = ?
         UNION ALL
         -- recursive: children of children
         SELECT sr.run_id
           FROM subagent_runs sr
           JOIN descendants d ON sr.parent_run_id = d.run_id
       )
       SELECT COUNT(*) AS cnt
         FROM subagent_runs
        WHERE run_id IN (SELECT run_id FROM descendants)
          AND status IN ('pending', 'running')`,
    )
    .get(parentRunId) as { cnt: number };
  return row.cnt;
}
