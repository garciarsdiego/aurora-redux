/**
 * Wave 2.C: state_schema violations → reviewer pipeline.
 *
 * Covers:
 *   - getStateSchemaViolationsForTask flattens events.payload_json into a
 *     well-typed list, ordered newest-first, capped at the limit.
 *   - getStateSchemaViolationsForTask drops malformed events (missing
 *     fields, invalid reason) without throwing.
 *   - buildReviewerInputFromTask threads ctx.stateSchemaViolations through
 *     so the reviewer persona's input schema receives the field.
 *   - ReviewerInputSchema accepts the new optional field; the reviewer
 *     prompt template surfaces it as a dedicated section.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  REVIEWER_PERSONA,
  ReviewerInputSchema,
} from '../../src/v2/agents/personas/reviewer.js';
import { buildReviewerInputFromTask } from '../../src/v2/reviewer/outcome.js';
import { getStateSchemaViolationsForTask } from '../../src/v2/observability/state-schema.js';
import type { Task } from '../../src/types/index.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT,
      task_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
  `);
  return db;
}

function emitViolations(
  db: Database.Database,
  taskId: string,
  violations: unknown[],
): void {
  db.prepare(
    `INSERT INTO events(workflow_id, task_id, type, payload_json) VALUES (?,?,?,?)`,
  ).run('wf_z', taskId, 'state_schema_violation', JSON.stringify({ violations }));
}

describe('getStateSchemaViolationsForTask', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns [] when no violation events exist', () => {
    expect(getStateSchemaViolationsForTask(db, 'tk_missing')).toEqual([]);
  });

  it('flattens violations across multiple events, newest first', () => {
    emitViolations(db, 'tk_z', [
      { field: 'count', expected: 'number', actual: 'string', reason: 'wrong_type' },
    ]);
    emitViolations(db, 'tk_z', [
      { field: 'name', expected: 'string', actual: 'undefined', reason: 'missing' },
    ]);

    const result = getStateSchemaViolationsForTask(db, 'tk_z');
    expect(result).toHaveLength(2);
    // Newest event first → 'name' missing comes before 'count' wrong_type.
    expect(result[0]?.field).toBe('name');
    expect(result[1]?.field).toBe('count');
  });

  it('drops malformed entries (missing field / invalid reason)', () => {
    emitViolations(db, 'tk_z', [
      { field: 'good', expected: 'string', actual: 'number', reason: 'wrong_type' },
      { field: 'bad-reason', expected: 'string', actual: 'number', reason: 'unsupported' },
      { expected: 'string', actual: 'number', reason: 'missing' }, // no field
      null,
      'not-an-object',
    ]);
    const result = getStateSchemaViolationsForTask(db, 'tk_z');
    expect(result).toEqual([
      { field: 'good', expected: 'string', actual: 'number', reason: 'wrong_type' },
    ]);
  });

  it('survives malformed JSON payloads without throwing', () => {
    db.prepare(`INSERT INTO events(workflow_id, task_id, type, payload_json) VALUES (?,?,?,?)`)
      .run('wf_z', 'tk_z', 'state_schema_violation', '{not-json');
    expect(() => getStateSchemaViolationsForTask(db, 'tk_z')).not.toThrow();
    expect(getStateSchemaViolationsForTask(db, 'tk_z')).toEqual([]);
  });

  it('honours the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      emitViolations(db, 'tk_z', [
        { field: `f${i}`, expected: 'string', actual: 'undefined', reason: 'missing' },
      ]);
    }
    const limited = getStateSchemaViolationsForTask(db, 'tk_z', 2);
    expect(limited).toHaveLength(2);
    // Newest two — f4, f3.
    expect(limited[0]?.field).toBe('f4');
    expect(limited[1]?.field).toBe('f3');
  });
});

describe('buildReviewerInputFromTask + ReviewerInputSchema integration', () => {
  const baseTask: Task = {
    id: 'tk_z',
    workflow_id: 'wf_z',
    name: 'Implement login flow',
    kind: 'llm_call',
    status: 'completed',
    depends_on: [],
    model: null,
    model_route: null,
    tool_name: null,
    executor_hint: null,
    acceptance_criteria: 'Output JSON with username and email fields.',
    timeout_seconds: null,
    retry_count: 0,
    refine_count: 0,
    started_at: 0,
    completed_at: 0,
    created_at: 0,
    duration_ms: null,
    input_json: '{}',
    output_json: '{"username":"di"}',
    workspace: 'internal',
  } as unknown as Task;

  it('forwards stateSchemaViolations from ctx into the reviewer input', () => {
    const input = buildReviewerInputFromTask(baseTask, '{"username":"di"}', {
      stateSchemaViolations: [
        { field: 'email', expected: 'string', actual: 'undefined', reason: 'missing' },
      ],
    });
    expect(input.state_schema_violations).toEqual([
      { field: 'email', expected: 'string', actual: 'undefined', reason: 'missing' },
    ]);
  });

  it('omits state_schema_violations when ctx does not provide them', () => {
    const input = buildReviewerInputFromTask(baseTask, '{"username":"di"}', {});
    expect(input.state_schema_violations).toBeUndefined();
  });

  it('ReviewerInputSchema accepts the new optional field', () => {
    const sample = {
      task_id: 'tk_z',
      workflow_id: 'wf_z',
      task_kind: 'llm_call',
      acceptance_criteria: 'Output JSON.',
      worker_output: { username: 'di' },
      workspace_dir: process.cwd(),
      state_schema_violations: [
        { field: 'email', expected: 'string', actual: 'undefined', reason: 'missing' as const },
      ],
    };
    const parsed = ReviewerInputSchema.safeParse(sample);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.state_schema_violations?.[0]?.field).toBe('email');
    }
  });

  it('rejects state_schema_violations entries with unsupported reason values', () => {
    const sample = {
      task_id: 'tk_z',
      workflow_id: 'wf_z',
      task_kind: 'llm_call',
      acceptance_criteria: 'Output JSON.',
      worker_output: { username: 'di' },
      workspace_dir: process.cwd(),
      state_schema_violations: [
        { field: 'email', expected: 'string', actual: 'undefined', reason: 'soft_drift' },
      ],
    };
    const parsed = ReviewerInputSchema.safeParse(sample);
    expect(parsed.success).toBe(false);
  });
});

describe('reviewer system prompt surfaces state_schema drift', () => {
  it('declares a dedicated section for state_schema_violations', () => {
    const tpl = REVIEWER_PERSONA.systemPromptTemplate;
    expect(tpl).toContain('State schema drift');
    expect(tpl).toContain('${INPUT.state_schema_violations|json}');
  });
});
