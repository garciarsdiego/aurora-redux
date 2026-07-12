/**
 * Tolerant JSON-object parse shared across the db package.
 *
 * Several modules persist ad-hoc key/value blobs in TEXT columns
 * (workflows.metadata, hitl_gates.context_json) and must never throw on a
 * corrupted or missing blob — a bad row degrades to `{}` and the caller
 * merges fresh keys on top. Previously copied verbatim in
 * workflow-cli-permission.ts, workflow-mode.ts and hitl-orphan-recovery.ts;
 * consolidated here so the three parse paths cannot drift.
 */
export function safeJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
