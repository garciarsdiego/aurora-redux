import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { DagSchema } from '../../src/types/schemas.js';
import { insertPattern } from '../../src/db/persist.js';
import { listPatterns } from '../../src/patterns/store.js';
import type Database from 'better-sqlite3';

function makeDb(): Database.Database {
  return initDb(':memory:');
}

const validDag = {
  tasks: [
    { id: 't1', name: 'Draft outline', kind: 'llm_call', depends_on: [], acceptance_criteria: 'Has 5 sections' },
    { id: 't2', name: 'Write body', kind: 'llm_call', depends_on: ['t1'], model: 'kimi-coding/kimi-k2.5-thinking' },
  ],
};

describe('DagSchema — model? field', () => {
  it('accepts task with model set', () => {
    const result = DagSchema.safeParse(validDag);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[1].model).toBe('kimi-coding/kimi-k2.5-thinking');
    }
  });

  it('accepts task with model: null', () => {
    const dag = { tasks: [{ id: 't1', name: 'Do thing', kind: 'llm_call', depends_on: [], model: null }] };
    expect(DagSchema.safeParse(dag).success).toBe(true);
  });

  it('accepts task with model omitted', () => {
    const dag = { tasks: [{ id: 't1', name: 'Do thing', kind: 'llm_call', depends_on: [] }] };
    const result = DagSchema.safeParse(dag);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasks[0].model).toBeUndefined();
    }
  });

  it('rejects task with model: 42 (wrong type)', () => {
    const dag = { tasks: [{ id: 't1', name: 'X', kind: 'llm_call', depends_on: [], model: 42 }] };
    expect(DagSchema.safeParse(dag).success).toBe(false);
  });
});

describe('import pattern — insertPattern with source=imported', () => {
  it('stores pattern and retrieves it via listPatterns', () => {
    const db = makeDb();
    insertPattern(db, {
      id: 'pt_test1',
      workspace: 'internal',
      name: 'my-imported',
      source: 'imported',
      objective_sample: 'write a blog post',
      dag_json: JSON.stringify(validDag),
      usage_count: 0,
      success_count: 0,
      avg_duration_ms: null,
      last_used_at: null,
      created_at: Date.now(),
    });

    const patterns = listPatterns(db, 'internal');
    expect(patterns).toHaveLength(1);
    expect(patterns[0].name).toBe('my-imported');
    expect(patterns[0].source).toBe('imported');

    const dag = DagSchema.parse(JSON.parse(patterns[0].dag_json));
    expect(dag.tasks[1].model).toBe('kimi-coding/kimi-k2.5-thinking');
  });

  it('preserves model: null in round-trip', () => {
    const db = makeDb();
    const dag = { tasks: [{ id: 't1', name: 'Task', kind: 'llm_call' as const, depends_on: [], model: null }] };
    insertPattern(db, {
      id: 'pt_test2',
      workspace: 'internal',
      name: 'null-model',
      source: 'imported',
      objective_sample: 'something',
      dag_json: JSON.stringify(dag),
      usage_count: 0,
      success_count: 0,
      avg_duration_ms: null,
      last_used_at: null,
      created_at: Date.now(),
    });

    const [p] = listPatterns(db, 'internal');
    const restored = DagSchema.parse(JSON.parse(p.dag_json));
    expect(restored.tasks[0].model).toBeNull();
  });

  it('rejects duplicate name in same workspace', () => {
    const db = makeDb();
    const base = {
      workspace: 'internal', name: 'dup', source: 'imported' as const,
      objective_sample: 'x', dag_json: JSON.stringify(validDag),
      usage_count: 0, success_count: 0, avg_duration_ms: null, last_used_at: null, created_at: Date.now(),
    };
    insertPattern(db, { id: 'pt_a', ...base });
    expect(() => insertPattern(db, { id: 'pt_b', ...base })).toThrow();
  });

  it('allows same name in different workspaces', () => {
    const db = makeDb();
    const base = {
      name: 'shared-name', source: 'imported' as const,
      objective_sample: 'x', dag_json: JSON.stringify(validDag),
      usage_count: 0, success_count: 0, avg_duration_ms: null, last_used_at: null, created_at: Date.now(),
    };
    expect(() => {
      insertPattern(db, { id: 'pt_ws1', workspace: 'ws1', ...base });
      insertPattern(db, { id: 'pt_ws2', workspace: 'ws2', ...base });
    }).not.toThrow();
  });

  it('invalid JSON schema returns Zod error (not inserted)', () => {
    const badDag = { tasks: [] }; // min(1) fails
    const result = DagSchema.safeParse(badDag);
    expect(result.success).toBe(false);
  });
});
