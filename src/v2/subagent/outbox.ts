// FASE 1B Bloco A.1 — A2A outbox: enqueue, mark-delivered, cancel, fetch.
// All SQL is parameterized; no string-interpolated queries.
// Transaction pattern follows src/db/client.ts line 40 (`db.transaction(...)()`)

import type Database from 'better-sqlite3';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import {
  validatePayload,
  wrapInMemoryFence,
  newSubagentMessageId,
  MESSAGE_COLUMNS,
  parseMessageRow,
  type SubagentMessageInput,
  type SubagentMessageRow,
  type SubagentMessageType,
  type AnnouncementPayload,
  type QueryPayload,
  type SteerPayload,
  type CompletePayload,
} from './messages.js';

// ─── Internal helpers ────────────────────────────────────────────────────────

// Tagged union mirroring the per-type Zod payload schemas in messages.ts.
// `validatePayload`'s public signature returns `data: unknown` (frozen —
// it's the shared validation entry point), so `toFenceableMessage` below is
// the single, explicit bridge from that `unknown` into this proper union,
// instead of fenceBody re-deriving the shape via manual typeof checks.
type FenceableMessage =
  | { type: 'announcement'; payload: AnnouncementPayload }
  | { type: 'query'; payload: QueryPayload }
  | { type: 'steer'; payload: SteerPayload }
  | { type: 'complete'; payload: CompletePayload };

function toFenceableMessage(type: SubagentMessageType, data: unknown): FenceableMessage {
  return { type, payload: data } as FenceableMessage;
}

/**
 * Extract the primary user-facing string from a validated payload for memory
 * fencing, per the spec:
 *   announcement → summary
 *   query        → question
 *   steer        → instruction
 *   complete     → result_text ?? error_msg ?? '(no body)'
 *
 * summary/question/instruction are `z.string().min(1)` in messages.ts, so
 * once `msg` has passed validatePayload, those fields are guaranteed
 * present — no fallback needed for them. result_text/error_msg are both
 * optional, so 'complete' keeps its fallback chain.
 */
function fenceBody(msg: FenceableMessage): string {
  switch (msg.type) {
    case 'announcement':
      return msg.payload.summary;
    case 'query':
      return msg.payload.question;
    case 'steer':
      return msg.payload.instruction;
    case 'complete':
      return msg.payload.result_text ?? msg.payload.error_msg ?? '(no body)';
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
  const body = fenceBody(toFenceableMessage(input.type, validation.data));
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
    `SELECT ${MESSAGE_COLUMNS}
     FROM subagent_messages
     WHERE id = ?`,
  ).get(messageId);

  if (row === undefined) return null;

  return parseMessageRow(row, `outbox.getMessageById(id=${messageId})`);
}
