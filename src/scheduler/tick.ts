import type Database from 'better-sqlite3';
import { initDb } from '../db/client.js';
import { insertEvent } from '../db/persist.js';
import { withSqliteRetrySync } from '../db/sqlite-retry.js';
import { getDbPath } from '../utils/config.js';

interface StaleHeartbeatRow {
  task_id: string;
  workflow_id: string;
  heartbeat_at: number;
}

interface ExpiredRunningTaskRow {
  task_id: string;
  workflow_id: string;
  task_name: string;
  lease_owner: string;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
  timeout_seconds: number;
}

const STALE_THRESHOLD_MS = 60_000;

export function emitTaskHungEvents(): { emitted: number; tasks: Array<{ task_id: string; age_ms: number }> } {
  const db = initDb(getDbPath());
  const now = Date.now();
  const cutoff = now - STALE_THRESHOLD_MS;

  try {
    const rows = db.prepare(
      `SELECT t.id AS task_id, t.workflow_id, l.heartbeat_at
         FROM tasks t
         JOIN workflow_task_leases l ON l.task_id = t.id
        WHERE t.status = 'running'
          AND l.heartbeat_at < ?`,
    ).all(cutoff) as StaleHeartbeatRow[];

    const emitted: Array<{ task_id: string; age_ms: number }> = [];

    for (const row of rows) {
      const alreadyHung = db.prepare(
        `SELECT 1 FROM events WHERE task_id = ? AND type = 'task_hung' LIMIT 1`,
      ).get(row.task_id) as { 1: number } | undefined;

      if (alreadyHung) {
        continue;
      }

      const ageMs = now - row.heartbeat_at;

      insertEvent(db, {
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        type: 'task_hung',
        payload: {
          age_ms: ageMs,
          last_heartbeat_at: row.heartbeat_at,
        },
      });

      emitted.push({ task_id: row.task_id, age_ms: ageMs });
    }

    return { emitted: emitted.length, tasks: emitted };
  } finally {
    db.close();
  }
}

export interface ExpiredRunningTask {
  task_id: string;
  workflow_id: string;
  age_ms: number;
}

export function expireTimedOutRunningTasks(
  db: Database.Database,
  now = Date.now(),
): { expired: ExpiredRunningTask[] } {
  const rows = db.prepare(
    `SELECT t.id AS task_id,
            t.workflow_id,
            t.name AS task_name,
            t.timeout_seconds,
            l.lease_owner,
            l.acquired_at,
            l.heartbeat_at,
            l.expires_at
       FROM tasks t
       JOIN workflow_task_leases l ON l.task_id = t.id
      WHERE t.status = 'running'
        AND l.status = 'running'
        AND l.expires_at <= ?
      ORDER BY l.expires_at ASC`,
  ).all(now) as ExpiredRunningTaskRow[];

  if (rows.length === 0) return { expired: [] };

  const expired: ExpiredRunningTask[] = [];

  const markTaskFailed = db.prepare(
    `UPDATE tasks
        SET status = 'failed',
            completed_at = ?,
            output_json = ?
      WHERE id = ?
        AND status = 'running'`,
  );
  const markLeaseExpired = db.prepare(
    `UPDATE workflow_task_leases
        SET status = 'expired',
            released_at = ?,
            heartbeat_at = ?
      WHERE task_id = ?
        AND status = 'running'`,
  );
  const markWorkflowFailed = db.prepare(
    `UPDATE workflows
        SET status = 'failed',
            completed_at = COALESCE(completed_at, ?)
      WHERE id = ?
        AND status IN ('pending', 'approved', 'executing')`,
  );

  const tx = db.transaction((items: ExpiredRunningTaskRow[]) => {
    // Reset accumulator so a SQLITE_BUSY retry does not double-count
    // expired rows from a partially-aborted prior attempt.
    expired.length = 0;
    for (const row of items) {
      const ageMs = Math.max(0, now - row.heartbeat_at);
      const overdueMs = Math.max(0, now - row.expires_at);
      const overdueSeconds = Math.round(overdueMs / 1000);
      const message =
        `Lease expired before task completed (${overdueSeconds}s past deadline). ` +
        'The worker stopped heartbeating before it produced a terminal task state.';
      const structuredError = {
        code: 'task_lease_expired',
        origin: `task:${row.task_id}`,
        message,
        suggested_action:
          'Open the task Terminal/Activity tabs, inspect the last runtime event, then retry the task or cancel the workflow.',
        context: {
          task_id: row.task_id,
          workflow_id: row.workflow_id,
          task_name: row.task_name,
          lease_owner: row.lease_owner,
          acquired_at: row.acquired_at,
          last_heartbeat_at: row.heartbeat_at,
          expires_at: row.expires_at,
          expired_at: now,
          heartbeat_age_ms: ageMs,
          overdue_ms: overdueMs,
          timeout_seconds: row.timeout_seconds,
        },
      };
      const outputJson = JSON.stringify({
        ok: false,
        error: structuredError,
      });

      const taskResult = markTaskFailed.run(now, outputJson, row.task_id);
      const leaseResult = markLeaseExpired.run(now, now, row.task_id);
      if (taskResult.changes === 0 || leaseResult.changes === 0) {
        continue;
      }

      insertEvent(db, {
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        type: 'task_lease_expired',
        payload: structuredError,
      });
      insertEvent(db, {
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        type: 'workflow_background_error',
        payload: {
          source: 'task_liveness_tick',
          error: `Task '${row.task_name}' [${row.task_id}] failed: ${message}`,
          structured_error: structuredError,
        },
      });
      markWorkflowFailed.run(now, row.workflow_id);
      expired.push({ task_id: row.task_id, workflow_id: row.workflow_id, age_ms: ageMs });
    }
  });

  withSqliteRetrySync(() => tx(rows));
  return { expired };
}

export function expireTimedOutRunningTasksFromDefaultDb(): { expired: ExpiredRunningTask[] } {
  const db = initDb(getDbPath());
  try {
    return expireTimedOutRunningTasks(db);
  } finally {
    db.close();
  }
}
