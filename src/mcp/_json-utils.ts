/**
 * _json-utils.ts
 *
 * Internal helpers shared across the dashboard data/ops modules.
 *
 * The dashboard-* files were split from larger modules and each split kept a
 * private copy of the same tolerant JSON/preview helpers (safeJsonObject vs
 * parseJsonObject vs payloadObject, previewValue, taskMapKey, durationMs).
 * Consolidated here so the copies cannot drift. Internal to src/mcp — not
 * part of the public dashboard API surface.
 */

/**
 * Tolerant JSON-object parse: returns `{}` for null/corrupted/non-object
 * payloads so a bad TEXT column never throws in a dashboard query path.
 */
export function safeJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Pretty-printed, truncated preview of a (possibly JSON) TEXT column.
 */
export function previewValue(raw: string | null, max = 1_000): string | null {
  if (!raw) return null;
  let text = raw;
  try {
    text = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    text = raw;
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Composite `workflowId::taskId` key used by the task card maps; null when
 * the row carries no task_id.
 */
export function taskMapKey(workflowId: string, taskId: string | null): string | null {
  return taskId ? `${workflowId}::${taskId}` : null;
}

/**
 * Elapsed time for a task/workflow row; open-ended runs measure against `now`.
 */
export function durationMs(startedAt: number | null, completedAt: number | null, now: number): number | null {
  if (!startedAt) return null;
  return (completedAt ?? now) - startedAt;
}
