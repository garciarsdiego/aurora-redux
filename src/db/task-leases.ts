import type Database from 'better-sqlite3';
import { withSqliteRetrySync } from './sqlite-retry.js';

export interface TaskLease {
  task_id: string;
  workflow_id: string;
  lease_owner: string;
  status: 'running' | 'completed' | 'failed' | 'expired';
  attempt: number;
  idempotency_key: string;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  released_at: number | null;
}

export interface AcquireTaskLeaseInput {
  workflowId: string;
  taskId: string;
  owner: string;
  ttlMs: number;
  now?: number;
}

export interface StartTaskLeaseHeartbeatInput {
  taskId: string;
  ttlMs: number;
  intervalMs?: number;
  onError?: (err: unknown) => void;
}

export interface TaskLeaseHeartbeatHandle {
  stop(): void;
}

export const DEFAULT_TASK_LEASE_HEARTBEAT_INTERVAL_MS = 20_000;

export function acquireTaskLease(
  db: Database.Database,
  input: AcquireTaskLeaseInput,
): TaskLease {
  const now = input.now ?? Date.now();

  // Read attempt + upsert inside a single IMMEDIATE transaction so two
  // concurrent acquirers (daemon + HTTP + REPL sharing the same DB) cannot
  // read the same attempt and mint a duplicate idempotency_key. A losing
  // writer surfaces SQLITE_BUSY, which the retry wrapper re-runs from the
  // fresh read.
  const acquire = db.transaction(() => {
    const existing = db
      .prepare('SELECT attempt FROM workflow_task_leases WHERE task_id = ?')
      .get(input.taskId) as { attempt: number } | undefined;
    const attempt = (existing?.attempt ?? 0) + 1;
    const idempotencyKey = `${input.workflowId}:${input.taskId}:${attempt}`;

    db.prepare(
      `INSERT INTO workflow_task_leases
       (task_id, workflow_id, lease_owner, status, attempt, idempotency_key,
        acquired_at, heartbeat_at, expires_at, released_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(task_id) DO UPDATE SET
       workflow_id = excluded.workflow_id,
       lease_owner = excluded.lease_owner,
       status = 'running',
       attempt = excluded.attempt,
       idempotency_key = excluded.idempotency_key,
       acquired_at = excluded.acquired_at,
       heartbeat_at = excluded.heartbeat_at,
       expires_at = excluded.expires_at,
       released_at = NULL`,
    ).run(
      input.taskId,
      input.workflowId,
      input.owner,
      attempt,
      idempotencyKey,
      now,
      now,
      now + input.ttlMs,
    );
  });
  withSqliteRetrySync(() => acquire.immediate());

  return loadTaskLease(db, input.taskId)!;
}

export function completeTaskLease(
  db: Database.Database,
  taskId: string,
  status: 'completed' | 'failed',
  now = Date.now(),
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE workflow_task_leases
        SET status = ?, heartbeat_at = ?, released_at = ?
      WHERE task_id = ?`,
    ).run(status, now, now, taskId),
  );
}

export function heartbeatTaskLease(
  db: Database.Database,
  taskId: string,
  ttlMs: number,
  now = Date.now(),
): void {
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE workflow_task_leases
        SET heartbeat_at = ?, expires_at = ?
      WHERE task_id = ? AND status = 'running'`,
    ).run(now, now + ttlMs, taskId),
  );
}

export function startTaskLeaseHeartbeat(
  db: Database.Database,
  input: StartTaskLeaseHeartbeatInput,
): TaskLeaseHeartbeatHandle {
  const intervalMs = Math.max(
    1_000,
    input.intervalMs ?? DEFAULT_TASK_LEASE_HEARTBEAT_INTERVAL_MS,
  );
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      heartbeatTaskLease(db, input.taskId, input.ttlMs);
    } catch (err) {
      try { input.onError?.(err); } catch { /* heartbeat observers must not crash the timer */ }
    }
  }, intervalMs);

  const maybeTimer = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeTimer.unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function recoverExpiredTaskLeases(
  db: Database.Database,
  now = Date.now(),
): TaskLease[] {
  const expired = db
    .prepare(
      `SELECT * FROM workflow_task_leases
        WHERE status = 'running' AND expires_at <= ?
        ORDER BY expires_at ASC`,
    )
    .all(now) as TaskLease[];
  if (expired.length === 0) return [];

  const mark = db.prepare(
    `UPDATE workflow_task_leases
        SET status = 'expired', released_at = ?, heartbeat_at = ?
      WHERE task_id = ? AND status = 'running'`,
  );
  const tx = db.transaction((rows: TaskLease[]) => {
    for (const row of rows) mark.run(now, now, row.task_id);
  });
  withSqliteRetrySync(() => tx(expired));

  return expired.map((row) => ({ ...row, status: 'expired' as const, released_at: now, heartbeat_at: now }));
}

export function loadTaskLease(db: Database.Database, taskId: string): TaskLease | null {
  const row = db
    .prepare('SELECT * FROM workflow_task_leases WHERE task_id = ?')
    .get(taskId) as TaskLease | undefined;
  return row ?? null;
}
