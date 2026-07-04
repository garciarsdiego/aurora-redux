// FASE 1B Bloco A.1 — A2A outbox: enqueue, mark-delivered, cancel, fetch.
// All SQL is parameterized; no string-interpolated queries.
// Transaction pattern follows src/db/client.ts line 40 (`db.transaction(...)()`)

import type Database from 'better-sqlite3';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import {
  validatePayload,
  wrapInMemoryFence,
  newSubagentMessageId,
  type SubagentMessageInput,
  type SubagentMessageRow,
  SubagentMessageRowSchema,
} from './messages.js';

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Extract the primary user-facing string from a validated payload for memory
 * fencing. Returns the string we want to fence, per the spec:
 *   announcement → summary
 *   query        → question
 *   steer        → instruction
 *   complete     → result_text ?? error_msg ?? '(no body)'
 */
function fenceBody(
  type: SubagentMessageInput['type'],
  payload: unknown,
): string {
  if (typeof payload !== 'object' || payload === null) return '(no body)';
  const p = payload as Record<string, unknown>;
  switch (type) {
    case 'announcement':
      return typeof p['summary'] === 'string' ? p['summary'] : '(no body)';
    case 'query':
      return typeof p['question'] === 'string' ? p['question'] : '(no body)';
    case 'steer':
      return typeof p['instruction'] === 'string' ? p['instruction'] : '(no body)';
    case 'complete': {
      if (typeof p['result_text'] === 'string') return p['result_text'];
      if (typeof p['error_msg'] === 'string') return p['error_msg'];
      return '(no body)';
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate and write one message to `subagent_messages` in a transaction.
 * On validation failure returns `{ ok: false, error }` without touching the DB.
 *
 * Self-directed messages (`toTaskId === fromTaskId`) are rejected — the inbox
 * `from_task_id != ?` filter would never deliver them, so they would just
 * accumulate as eternal-pending rows.
 */
export function enqueue(
  db: Database.Database,
  input: SubagentMessageInput,
): { ok: true; id: string } | { ok: false; error: string } {
  if (input.toTaskId != null && input.toTaskId === input.fromTaskId) {
    return { ok: false, error: 'self-directed message rejected' };
  }

  const validation = validatePayload(input.type, input.payload);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const id = newSubagentMessageId();
  const now = Date.now();
  const body = fenceBody(input.type, validation.data);
  const fenced = wrapInMemoryFence(body, input.fromTaskId, input.type);
  const payloadJson = JSON.stringify({ fenced, raw: validation.data });

  const enqueueTx = db.transaction(() => {
    db.prepare(
      `INSERT INTO subagent_messages
         (id, workflow_id, from_task_id, to_task_id, message_type,
          payload_json, status, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    ).run(
      id,
      input.workflowId,
      input.fromTaskId,
      input.toTaskId ?? null,
      input.type,
      payloadJson,
      now,
    );
  });
  withSqliteRetrySync(() => enqueueTx());

  return { ok: true, id };
}

/**
 * Record delivery of `messageId` to `toTaskId` and, for directed messages,
 * flip the root row status to 'delivered'.
 * Broadcast messages (to_task_id IS NULL) intentionally stay 'pending' on the
 * root row so that other tasks can still consume them via `dequeueFor`.
 * The INSERT OR IGNORE makes this idempotent: a second call is a no-op.
 */
export function markDelivered(
  db: Database.Database,
  messageId: string,
  toTaskId: string,
): void {
  const now = Date.now();

  const deliveryTx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO subagent_message_deliveries
         (message_id, task_id, delivered_at)
       VALUES (?, ?, ?)`,
    ).run(messageId, toTaskId, now);

    // Only flip the root status for directed messages.
    db.prepare(
      `UPDATE subagent_messages
       SET status = 'delivered', delivered_at = ?
       WHERE id = ? AND status = 'pending' AND to_task_id IS NOT NULL`,
    ).run(now, messageId);
  });
  withSqliteRetrySync(() => deliveryTx());
}

/**
 * Cancel all pending messages for a workflow (e.g., when the workflow
 * completes or is killed). Leaves delivered/cancelled rows untouched.
 * Returns the number of rows changed.
 */
export function cancelPendingForWorkflow(
  db: Database.Database,
  workflowId: string,
): number {
  const info = withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE subagent_messages
     SET status = 'cancelled'
     WHERE workflow_id = ? AND status = 'pending'`,
    ).run(workflowId),
  );

  return info.changes;
}

/**
 * Cancel pending messages tied to a specific task — both messages it sent
 * (from_task_id) and messages addressed to it (to_task_id). Used by
 * control.kill() so a killed task does not leave dangling work in the queue.
 * Returns the number of rows changed.
 */
export function cancelPendingForTask(
  db: Database.Database,
  taskId: string,
): number {
  const info = withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE subagent_messages
     SET status = 'cancelled'
     WHERE status = 'pending'
       AND (from_task_id = ? OR to_task_id = ?)`,
    ).run(taskId, taskId),
  );

  return info.changes;
}

/**
 * Fetch a single message row by id. Returns null if not found.
 */
export function getMessageById(
  db: Database.Database,
  messageId: string,
): SubagentMessageRow | null {
  const row = db.prepare(
    `SELECT id, workflow_id, from_task_id, to_task_id,
            message_type, payload_json, status, created_at, delivered_at
     FROM subagent_messages
     WHERE id = ?`,
  ).get(messageId);

  if (row === undefined) return null;

  const parsed = SubagentMessageRowSchema.safeParse(row);
  if (!parsed.success) {
    process.stderr.write(
      `[outbox] getMessageById parse error for ${messageId}: ${parsed.error.message}\n`,
    );
    return null;
  }
  return parsed.data;
}
