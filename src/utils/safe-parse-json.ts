/**
 * Silent JSON helper (M1 B9 — gap-closure 2026-05-12).
 *
 * The codebase had ~14+ occurrences of
 *
 *   try { JSON.parse(task.input_json ?? '{}') } catch { /* ignore *\/ }
 *
 * which is the F-D1-2 antipattern CLAUDE.md explicitly bans: operators have no
 * way to tell when a task's input_json is malformed because the parse failure
 * is swallowed.  This helper exposes a single audited entry point that:
 *
 *   - returns `T | null` on parse error (callers decide on the default to
 *     substitute, preserving the existing semantics);
 *   - emits a `task_input_json_malformed` event into the workflow audit trail
 *     with `{ task_id, where, error, raw_length }` so the operator can spot
 *     the drift in the dashboard / SSE feed;
 *   - NEVER throws — observability that breaks the executor is worse than
 *     a missing event, so the insertEvent path itself is wrapped.
 *
 * The event type is pre-registered in `src/runtime/event-types.ts`
 * (`task_input_json_malformed`) so the registry test does not regress.
 *
 * Usage:
 *
 *   const ctx = safeParseJson<Record<string, unknown>>(
 *     task.input_json,
 *     { db, workflowId: wfId, taskId: task.id, where: 'collect_upstream' },
 *   ) ?? {};
 *
 * The `db` / `workflowId` fields are optional so legacy callers without a
 * workflow context (unit tests, REPL, ad-hoc scripts) still get the null
 * fallback without the event side-effect.
 */

import type Database from 'better-sqlite3';
import { insertEvent } from '../db/persist.js';

export interface SafeParseJsonContext {
  /** Database handle — required to emit the audit event. */
  readonly db?: Database.Database;
  /** Workflow ID — required to emit the audit event. */
  readonly workflowId?: string;
  /** Task ID — embedded in payload (defensively serialized to null if absent). */
  readonly taskId?: string;
  /** Site label for the audit event (e.g. 'collect_upstream'). */
  readonly where: string;
}

/**
 * Parse `raw` as JSON, returning the parsed value typed as `T` or `null`
 * when parsing fails. On failure, emit a `task_input_json_malformed` event
 * with the supplied context so operators can audit the drift.
 *
 * Behavior:
 *   - `raw === null | undefined | ''` → returns `null` (treated as "absent",
 *     no audit event — callers handle "no input" without alarm noise);
 *   - `raw` parses → returns `JSON.parse(raw) as T`;
 *   - `raw` is malformed → emits the audit event and returns `null`.
 *
 * The event is emitted via `insertEvent` which already redacts secrets in
 * the payload — we do NOT include `raw` itself for that reason. Only the
 * length and the parser's own error message ship to the audit row.
 */
export function safeParseJson<T = unknown>(
  raw: string | null | undefined,
  ctx: SafeParseJsonContext,
): T | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    emitMalformedEvent(ctx, message, raw.length);
    return null;
  }
}

function emitMalformedEvent(
  ctx: SafeParseJsonContext,
  errorMessage: string,
  rawLength: number,
): void {
  if (!ctx.db || !ctx.workflowId) {
    // No workflow context — caller is a unit test / REPL script / etc.
    // Skip the audit event entirely (writing to a null db would throw).
    return;
  }
  try {
    insertEvent(ctx.db, {
      workflow_id: ctx.workflowId,
      task_id: ctx.taskId ?? null,
      type: 'task_input_json_malformed',
      payload: {
        task_id: ctx.taskId ?? null,
        where: ctx.where,
        error: errorMessage,
        raw_length: rawLength,
      },
    });
  } catch {
    // F-D1-2 escape hatch: the event is best-effort observability. If
    // insertEvent itself fails (FK constraint on a transient task row,
    // a closed db handle), we MUST NOT throw — the caller already has
    // a `null` return and a fallback strategy; cascading a failure here
    // would be worse than the missing event.
  }
}
