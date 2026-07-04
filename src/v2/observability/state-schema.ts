/**
 * Runtime validation of a task's output against its declared `state_schema`
 * (audit §13 P3 #19, B9.2).
 *
 * Behaviour: best-effort, non-blocking. Violations emit a
 * `state_schema_violation` event for observability so the operator + future
 * reviewer can see drift between the contract the decomposer promised and
 * what the worker actually produced. The wire does NOT fail the task —
 * the audit explicitly framed this as enforcement-without-coercion (the
 * worker's verdict already covers semantic correctness; this catches
 * shape drift independently).
 *
 * Field type enum (from DagStateSchemaFieldSchema):
 *   'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'unknown'
 * The 'unknown' type passes any JS value (escape hatch).
 */

export interface StateSchemaField {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'unknown';
  default?: unknown;
  description?: string;
}

export type StateSchema = Record<string, StateSchemaField>;

export interface StateSchemaViolation {
  /** Field name from state_schema that failed. */
  field: string;
  /** Expected type from the schema declaration. */
  expected: StateSchemaField['type'];
  /** Actual JS typeof / shape detected (string, number, array, null, etc.). */
  actual: string;
  /** Human-readable issue (missing | wrong_type | parse_error). */
  reason: 'missing' | 'wrong_type' | 'parse_error';
}

export interface ValidateStateSchemaResult {
  valid: boolean;
  violations: StateSchemaViolation[];
}

/**
 * Cheap classification — "what's this JS value?" mapped to the same labels
 * the schema uses. Distinguishes array from object (which `typeof` does
 * not) and null from object (same).
 */
function classify(value: unknown): StateSchemaField['type'] {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  return 'unknown';
}

function fieldMatchesType(value: unknown, expected: StateSchemaField['type']): boolean {
  if (expected === 'unknown') return true;
  return classify(value) === expected;
}

/**
 * Walk `schema` against `output`. For each declared field, check it exists
 * (or has a default) AND its type matches. Returns a structured result the
 * caller can emit as an event.
 *
 * Output shapes accepted:
 *   - `Record<string, unknown>`: direct lookup by field name
 *   - JSON-serialised string: parsed first; on parse failure, returns one
 *     `parse_error` violation against the entire schema (not per-field).
 *   - Any other type (number, array, etc.): treated as a parse-error too —
 *     state_schema requires an object-like surface to introspect.
 */
export function validateOutputAgainstStateSchema(
  rawOutput: unknown,
  schema: StateSchema,
): ValidateStateSchemaResult {
  if (!schema || Object.keys(schema).length === 0) {
    return { valid: true, violations: [] };
  }

  let output: Record<string, unknown> | null = null;
  if (typeof rawOutput === 'string') {
    try {
      const parsed = JSON.parse(rawOutput) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        output = parsed as Record<string, unknown>;
      }
    } catch {
      // fall through — parse_error reported below
    }
  } else if (rawOutput && typeof rawOutput === 'object' && !Array.isArray(rawOutput)) {
    output = rawOutput as Record<string, unknown>;
  }

  if (output === null) {
    return {
      valid: false,
      violations: [
        {
          field: '<root>',
          expected: 'object',
          actual: classify(rawOutput),
          reason: 'parse_error',
        },
      ],
    };
  }

  const violations: StateSchemaViolation[] = [];
  for (const [field, def] of Object.entries(schema)) {
    if (!(field in output)) {
      // Missing fields with a default are OK — they'll be filled later.
      if (def.default !== undefined) continue;
      violations.push({
        field,
        expected: def.type,
        actual: 'undefined',
        reason: 'missing',
      });
      continue;
    }
    const value = output[field];
    if (!fieldMatchesType(value, def.type)) {
      violations.push({
        field,
        expected: def.type,
        actual: classify(value),
        reason: 'wrong_type',
      });
    }
  }

  return { valid: violations.length === 0, violations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2.C — DB read consumer.
// The reviewer pipeline pulls these violations into the per-task context so
// the LLM sees shape drift as feedback (rather than the violation only being
// surfaced through the SSE event stream).
// ─────────────────────────────────────────────────────────────────────────────

interface SqlReader {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

/**
 * Read every `state_schema_violation` event for a task, newest first, and
 * flatten into a single ordered violation list.
 *
 * The validator runs once per task completion, but a refine cycle may emit
 * multiple events — most recent wins for the reviewer's context. We cap
 * the result at `limit` to avoid runaway prompts.
 */
export function getStateSchemaViolationsForTask(
  db: SqlReader,
  taskId: string,
  limit = 32,
): StateSchemaViolation[] {
  const rows = db
    .prepare(
      `SELECT payload_json FROM events
        WHERE task_id = ? AND type = 'state_schema_violation'
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(taskId, limit) as Array<{ payload_json: string | null }>;

  const out: StateSchemaViolation[] = [];
  for (const row of rows) {
    if (!row.payload_json) continue;
    try {
      const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      const list = parsed['violations'];
      if (!Array.isArray(list)) continue;
      for (const v of list) {
        if (!v || typeof v !== 'object') continue;
        const obj = v as Record<string, unknown>;
        const field = typeof obj['field'] === 'string' ? obj['field'] : null;
        const expected = typeof obj['expected'] === 'string' ? obj['expected'] : null;
        const actual = typeof obj['actual'] === 'string' ? obj['actual'] : null;
        const reason = typeof obj['reason'] === 'string' ? obj['reason'] : null;
        if (!field || !expected || !actual || !reason) continue;
        if (
          reason !== 'missing' &&
          reason !== 'wrong_type' &&
          reason !== 'parse_error'
        ) continue;
        out.push({
          field,
          expected: expected as StateSchemaField['type'],
          actual,
          reason,
        });
      }
    } catch { /* malformed event payload — skip */ }
  }
  return out;
}
