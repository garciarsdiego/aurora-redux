// FASE 1B Bloco A.1 — A2A messaging schemas + memory fencing.
// 4 message types per docs/09-H2-ROADMAP-DETAILED.md § FASE 1B Bloco A.1.
// Memory fencing per D-H2.016: any subagent-sourced content reaching an LLM
// prompt MUST be wrapped in <subagent-message ...> tags so the consumer's
// system prompt can teach the model to treat it as untrusted-data, not as
// an instruction.

import { z } from 'zod';

export const SubagentMessageTypeSchema = z.enum([
  'announcement', // broadcast: "I discovered X"
  'query',        // peer asks for info
  'steer',        // supervisor redirects a running subagent
  'complete',     // finalize with outcome
]);
export type SubagentMessageType = z.infer<typeof SubagentMessageTypeSchema>;

export const SubagentMessageStatusSchema = z.enum([
  'pending',
  'delivered',
  'cancelled',
]);
export type SubagentMessageStatus = z.infer<typeof SubagentMessageStatusSchema>;

// ─── Per-type payload schemas ──────────────────────────────────────────

export const AnnouncementPayloadSchema = z.object({
  topic: z.string().min(1),
  summary: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AnnouncementPayload = z.infer<typeof AnnouncementPayloadSchema>;

export const QueryPayloadSchema = z.object({
  question: z.string().min(1),
  context: z.string().optional(),
  reply_to_task_id: z.string().optional(),
});
export type QueryPayload = z.infer<typeof QueryPayloadSchema>;

export const SteerPayloadSchema = z.object({
  instruction: z.string().min(1),
  reason: z.string().optional(),
});
export type SteerPayload = z.infer<typeof SteerPayloadSchema>;

export const CompletePayloadSchema = z.object({
  status: z.enum(['ok', 'error', 'timeout', 'killed']),
  result_text: z.string().optional(),
  error_msg: z.string().optional(),
});
export type CompletePayload = z.infer<typeof CompletePayloadSchema>;

// ─── Row shape (mirrors subagent_messages table) ────────────────────────

export const SubagentMessageRowSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),
  from_task_id: z.string(),
  to_task_id: z.string().nullable(),
  message_type: SubagentMessageTypeSchema,
  payload_json: z.string(),
  status: SubagentMessageStatusSchema,
  created_at: z.number().int(),
  delivered_at: z.number().int().nullable(),
});
export type SubagentMessageRow = z.infer<typeof SubagentMessageRowSchema>;

// ─── Input contract for outbox.enqueue ─────────────────────────────────

export interface SubagentMessageInput {
  workflowId: string;
  fromTaskId: string;
  toTaskId?: string | null; // null/undefined = broadcast within workflow
  type: SubagentMessageType;
  payload: unknown; // validated against the per-type schema in enqueue()
}

export function newSubagentMessageId(): string {
  return `sm_${crypto.randomUUID()}`;
}

// ─── Per-type validation dispatch ───────────────────────────────────────

export function validatePayload(
  type: SubagentMessageType,
  payload: unknown,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const schema = (
    type === 'announcement' ? AnnouncementPayloadSchema
    : type === 'query'      ? QueryPayloadSchema
    : type === 'steer'      ? SteerPayloadSchema
    :                         CompletePayloadSchema
  );
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, data: parsed.data };
}

// ─── Memory fencing helpers ─────────────────────────────────────────────
// Tightened post-Opus-review (R-MED-1):
//   - Strip zero-width / BOM characters before the regex pass so payloads
//     like "<\u200Bsubagent-message>" can't slip through `\s*`.
//   - Entity-encode `<` and `&` in the body so any surviving angle-bracket
//     sequence (or HTML entity smuggle like `&lt;subagent-message&gt;`)
//     can't be rendered/interpreted as a sub-fence by an LLM that decodes
//     entities. This is defense-in-depth; the regex strip is still the
//     primary barrier.

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const FENCE_OPEN_RE = /<\s*subagent-message\b[^>]*>/gi;
const FENCE_CLOSE_RE = /<\s*\/\s*subagent-message\s*>/gi;

function stripFenceTags(body: string): string {
  return body
    .replace(ZERO_WIDTH_RE, '')
    .replace(FENCE_OPEN_RE, '')
    .replace(FENCE_CLOSE_RE, '');
}

function encodeBodyEntities(body: string): string {
  // Encode `&` first (otherwise it would double-encode entities introduced
  // by the `<` replacement). Standard XML/HTML escaping subset.
  return body.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * Wrap content in a memory-fence tag before exposing it to an LLM prompt.
 * Strips any pre-existing fence tags + zero-width chars, then entity-encodes
 * angle brackets in the body to prevent payload smuggling (an attacker-
 * controlled string that closes the fence early and then writes free-form
 * instructions outside the fence).
 *
 * Format:
 *   <subagent-message source="task_X" type="announcement">
 *   ...body (entity-encoded)...
 *   </subagent-message>
 */
export function wrapInMemoryFence(
  body: string,
  fromTaskId: string,
  type: SubagentMessageType,
): string {
  const stripped = stripFenceTags(body);
  const safeBody = encodeBodyEntities(stripped);
  const safeId = fromTaskId.replace(/"/g, '&quot;');
  return `<subagent-message source="${safeId}" type="${type}">\n${safeBody}\n</subagent-message>`;
}
