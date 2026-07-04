// FASE 1B Bloco A.1 — A2A inbox: dequeue, count pending, peek.
// The delivery-row insert SQL here mirrors markDelivered() in outbox.ts and
// is intentionally duplicated so the inbox path is atomic in a single
// transaction; both writes are idempotent (`INSERT OR IGNORE` + status=pending
// guard) so calling outbox.markDelivered separately remains a safe no-op.
//
// SQL parameters use named bindings (`@taskId`, `@workflowId`) — better-sqlite3
// supports them and they prevent positional-bind ordering bugs (R-MED-2).

import type Database from 'better-sqlite3';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import {
  SubagentMessageRowSchema,
  type SubagentMessageRow,
} from './messages.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DeliveredMessage {
  /** The raw DB row. */
  row: SubagentMessageRow;
  /** Pre-fenced text (ready for prompt injection). Extracted from payload_json. */
  fenced: string;
  /** Validated typed payload. Extracted from payload_json. */
  raw: unknown;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * WHERE fragment shared by dequeueFor, pendingFor, and peekFor.
 *
 * Selects messages that:
 *   - Belong to the given workflowId
 *   - Are either directed to taskId OR are a broadcast (to_task_id IS NULL)
 *   - Were NOT sent by taskId itself (no self-delivery)
 *   - Are in 'pending' status
 *   - Have NOT already been delivered to taskId per subagent_message_deliveries
 *
 * Bindings are named (@taskId, @workflowId). Order in the binding object
 * does not matter — eliminates the positional-confusion risk previous SQL
 * had with four `?` placeholders that all pointed to taskId or workflowId.
 */
const PENDING_FOR_SQL = `
  FROM subagent_messages m
  LEFT JOIN subagent_message_deliveries d
    ON d.message_id = m.id AND d.task_id = @taskId
  WHERE m.workflow_id = @workflowId
    AND (m.to_task_id = @taskId OR m.to_task_id IS NULL)
    AND m.from_task_id != @taskId
    AND m.status = 'pending'
    AND d.task_id IS NULL
`;

/**
 * Parse payload_json and return { fenced, raw }.
 * On parse error, logs to stderr and returns safe fallback values.
 */
function parsePayloadJson(
  id: string,
  payloadJson: string,
): { fenced: string; raw: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (err) {
    process.stderr.write(
      `[inbox] JSON.parse failed for message ${id}: ${(err as Error).message}\n`,
    );
    return { fenced: '', raw: null };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('fenced' in parsed) ||
    !('raw' in parsed)
  ) {
    process.stderr.write(
      `[inbox] payload_json missing fenced/raw fields for message ${id}\n`,
    );
    return { fenced: '', raw: parsed };
  }

  const obj = parsed as { fenced: unknown; raw: unknown };
  const fenced = typeof obj.fenced === 'string' ? obj.fenced : '';
  return { fenced, raw: obj.raw };
}

/**
 * Validate a raw DB row against SubagentMessageRowSchema.
 * Returns the typed row or null on validation failure (with stderr log).
 */
function parseRow(row: unknown): SubagentMessageRow | null {
  const result = SubagentMessageRowSchema.safeParse(row);
  if (!result.success) {
    process.stderr.write(
      `[inbox] row schema mismatch: ${result.error.message}\n`,
    );
    return null;
  }
  return result.data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Atomically fetch all undelivered messages for taskId within workflowId,
 * record delivery rows, and return the parsed results.
 *
 * Broadcast messages stay 'pending' on the root row (so other tasks can
 * still consume them); only a per-task delivery row is written.
 * Directed messages: this function flips the root status to 'delivered' AND
 * writes the per-task delivery row in the same transaction. The same flip
 * logic also lives in outbox.markDelivered for callers that don't go
 * through the inbox; both paths are idempotent (`status='pending'` guard
 * + `INSERT OR IGNORE`).
 */
export function dequeueFor(
  db: Database.Database,
  taskId: string,
  workflowId: string,
): DeliveredMessage[] {
  const now = Date.now();

  // Note: `results` is rebuilt inside the transaction closure so that, on a
  // SQLITE_BUSY retry, we do not carry rows from a partially-aborted prior
  // attempt. better-sqlite3 transactions are atomic from SQLite's perspective,
  // but our JS-side accumulator needs to be reset per attempt as well.
  let results: DeliveredMessage[] = [];

  const dequeueTx = db.transaction(() => {
    results = [];

    const rawRows = db.prepare(
      `SELECT m.id, m.workflow_id, m.from_task_id, m.to_task_id,
              m.message_type, m.payload_json, m.status, m.created_at, m.delivered_at
       ${PENDING_FOR_SQL}`,
    ).all({ taskId, workflowId }) as unknown[];

    const insertDelivery = db.prepare(
      `INSERT OR IGNORE INTO subagent_message_deliveries
         (message_id, task_id, delivered_at)
       VALUES (?, ?, ?)`,
    );

    const updateDirected = db.prepare(
      `UPDATE subagent_messages
       SET status = 'delivered', delivered_at = ?
       WHERE id = ? AND status = 'pending' AND to_task_id IS NOT NULL`,
    );

    for (const rawRow of rawRows) {
      const row = parseRow(rawRow);
      if (row === null) continue;

      // Write delivery tracking row (idempotent via INSERT OR IGNORE).
      insertDelivery.run(row.id, taskId, now);

      // Flip root status for directed messages only.
      if (row.to_task_id !== null) {
        updateDirected.run(now, row.id);
      }

      const { fenced, raw } = parsePayloadJson(row.id, row.payload_json);
      results.push({ row, fenced, raw });
    }
  });
  withSqliteRetrySync(() => dequeueTx());

  return results;
}

/**
 * Count pending undelivered messages for taskId without consuming them.
 */
export function pendingFor(
  db: Database.Database,
  taskId: string,
  workflowId: string,
): number {
  const result = db.prepare(
    `SELECT COUNT(*) AS cnt ${PENDING_FOR_SQL}`,
  ).get({ taskId, workflowId }) as { cnt: number } | undefined;

  return result?.cnt ?? 0;
}

/**
 * Return pending undelivered messages for taskId without recording delivery.
 * Used for observability / debugging — does not advance inbox state.
 */
export function peekFor(
  db: Database.Database,
  taskId: string,
  workflowId: string,
): SubagentMessageRow[] {
  const rawRows = db.prepare(
    `SELECT m.id, m.workflow_id, m.from_task_id, m.to_task_id,
            m.message_type, m.payload_json, m.status, m.created_at, m.delivered_at
     ${PENDING_FOR_SQL}`,
  ).all({ taskId, workflowId }) as unknown[];

  const rows: SubagentMessageRow[] = [];
  for (const rawRow of rawRows) {
    const row = parseRow(rawRow);
    if (row !== null) rows.push(row);
  }
  return rows;
}
