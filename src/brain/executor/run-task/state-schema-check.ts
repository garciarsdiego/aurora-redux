import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import type { ReviewerRuntimeContext } from '../../../v2/reviewer/outcome.js';
import { insertEvent } from '../../../db/persist.js';

/**
 * Runs the state_schema runtime validation block that fires immediately
 * after a task's executor output is captured.
 *
 * Returns the list of violations (when any) so the caller can pipe them
 * into the reviewer runtime context. Pure observability — never throws.
 */
export async function runStateSchemaCheck(
  db: Database.Database,
  task: Task,
  wfId: string,
  output: string,
): Promise<ReviewerRuntimeContext['stateSchemaViolations']> {
  // B9.2 — state_schema runtime validation. When the task declared a
  // state_schema, check the output shape against it. Best-effort,
  // non-blocking: violations emit a state_schema_violation event for
  // observability but do NOT fail the task (reviewer + failover already
  // cover semantic correctness; this catches shape drift between the
  // decomposer's contract and the worker's actual output).
  const declaredSchema = (() => {
    // Use the audited helper — but route the malformed-input event to a
    // dedicated `state_schema_parse_failed` type (also pre-registered) so
    // operators can spot state-schema drift specifically, not just any
    // input_json malformation. Falls back to safeParseJson's standard
    // `task_input_json_malformed` if direct emission fails.
    let ctx: Record<string, unknown> | null = null;
    if (task.input_json) {
      try {
        ctx = JSON.parse(task.input_json) as Record<string, unknown>;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          insertEvent(db, {
            workflow_id: wfId,
            task_id: task.id,
            type: 'state_schema_parse_failed',
            payload: {
              task_id: task.id,
              error: message,
              raw_length: task.input_json.length,
            },
          });
        } catch { /* observability is best-effort */ }
      }
    }
    if (!ctx) return null;
    const schema = ctx['state_schema'];
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      return schema as import('../../../v2/observability/state-schema.js').StateSchema;
    }
    return null;
  })();
  let stateSchemaViolations: ReviewerRuntimeContext['stateSchemaViolations'];
  if (declaredSchema && Object.keys(declaredSchema).length > 0) {
    try {
      const { validateOutputAgainstStateSchema } = await import('../../../v2/observability/state-schema.js');
      const validation = validateOutputAgainstStateSchema(output, declaredSchema);
      if (!validation.valid) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'state_schema_violation',
          payload: {
            violations: validation.violations,
            schema_field_count: Object.keys(declaredSchema).length,
          },
        });
        // Wave 2.C — feed violations to the reviewer downstream as
        // structured shape feedback. Persist them in the runtime context
        // so the next reviewAndRefine call surfaces them in the prompt.
        stateSchemaViolations = validation.violations.map((v) => ({
          field: v.field,
          expected: v.expected,
          actual: v.actual,
          reason: v.reason,
        }));
      }
    } catch { /* validation must never throw — pure observability */ }
  }
  return stateSchemaViolations;
}

/**
 * Wave 2.C — fold any prior-cycle violations into the reviewer context
 * so refines see the full drift history. The freshly-validated set
 * already gets a row in the events table above, so this single DB read
 * covers both this attempt and any earlier refine attempts.
 */
export async function loadReviewerStateSchemaViolations(
  db: Database.Database,
  task: Task,
  freshViolations: ReviewerRuntimeContext['stateSchemaViolations'],
): Promise<ReviewerRuntimeContext['stateSchemaViolations']> {
  if (freshViolations) return freshViolations;
  try {
    const { getStateSchemaViolationsForTask } = await import('../../../v2/observability/state-schema.js');
    const persisted = getStateSchemaViolationsForTask(db, task.id);
    if (persisted.length > 0) {
      return persisted.map((v) => ({
        field: v.field,
        expected: v.expected,
        actual: v.actual,
        reason: v.reason,
      }));
    }
  } catch { /* observability is best-effort */ }
  return undefined;
}
