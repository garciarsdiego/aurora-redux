import type Database from 'better-sqlite3';

export type WorkflowMode = 'standard' | 'existing_code_feature';

function safeJsonObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string' || !input.trim()) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Read the workflow_mode tag persisted on a workflow's metadata column.
 *
 * Wave 2.2 (F2-4) introduced this helper so the runtime gate inside
 * brain/executor/run-task.ts can decide whether the persistent runtime pool
 * should be consulted for a given task. We only opt-in when the workflow was
 * planned/run with workflow_mode === 'existing_code_feature' because that is
 * the path the architect-scout + reviewer overlay already understands.
 *
 * The metadata column is JSON-encoded; mirror the parsing strategy used in
 * src/db/workflow-cli-permission.ts to avoid pulling in a heavier serializer.
 *
 * Defensive design:
 *   * Returns 'standard' on missing workflow row, malformed JSON, or any DB
 *     error. The runtime gate must NEVER throw — a failed read collapses to
 *     "no persistent pool acquisition" and the legacy ephemeral path runs.
 *   * Only the explicit literal 'existing_code_feature' opts the workflow in;
 *     unknown strings collapse to 'standard'.
 */
export function readWorkflowMode(db: Database.Database, workflowId: string): WorkflowMode {
  try {
    const row = db
      .prepare('SELECT metadata FROM workflows WHERE id = ?')
      .get(workflowId) as { metadata: string | null } | undefined;
    if (!row) return 'standard';
    const meta = safeJsonObject(row.metadata);
    const mode = typeof meta['workflow_mode'] === 'string' ? meta['workflow_mode'] : null;
    if (mode === 'existing_code_feature') return 'existing_code_feature';
    return 'standard';
  } catch {
    return 'standard';
  }
}
