// Focused persist invariants for the task lifecycle helpers. These pin
// contracts that other features quietly depend on — in particular the
// Aurora-parity pin/freeze reuse path, whose executor short-circuit only works
// because `setTaskPending` (the rewind/fork move) preserves the prior
// `output_json` instead of clearing it. A one-line `output_json = NULL` in
// setTaskPending would silently break pin/freeze; this test guards against it.
import { describe, it, expect } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  insertTask,
  setTaskCompleted,
  setTaskPending,
} from '../../src/db/persist.js';
import type { Workflow, Task } from '../../src/types/index.js';

function setup(): Database.Database {
  const db = initDb(':memory:');
  insertWorkflow(db, {
    id: 'wf1', workspace: 'test', objective: 'o', pattern_id: null, status: 'executing',
    started_at: Date.now(), completed_at: null, created_at: Date.now(), created_by: null,
    estimated_cost_usd: null, actual_cost_usd: null, metadata: null,
  } as unknown as Workflow);
  return db;
}

function makeTask(over: Partial<Task>): Task {
  return {
    id: 't1', workflow_id: 'wf1', name: 'T', kind: 'llm_call', input_json: null, output_json: null,
    status: 'pending', depends_on: [], executor_hint: null, timeout_seconds: 30, max_retries: 0,
    retry_count: 0, retry_policy: 'none', started_at: null, completed_at: null, created_at: Date.now(),
    acceptance_criteria: null, refine_count: 0, max_refine: 0, refine_feedback: null, model: null,
    hitl: false, execution_mode: 'ephemeral', tool_name: null,
    ...over,
  } as unknown as Task;
}

describe('setTaskPending — rewind preserves output_json', () => {
  it('does NOT clear output_json when rewinding a completed task to pending', () => {
    const db = setup();
    insertTask(db, makeTask({ id: 't1' }));

    setTaskCompleted(db, 't1', 'COMPLETED OUTPUT');
    {
      const row = db.prepare("SELECT status, output_json, started_at FROM tasks WHERE id='t1'").get() as {
        status: string; output_json: string; started_at: number | null;
      };
      expect(row.status).toBe('completed');
      expect(row.output_json).toBe('COMPLETED OUTPUT');
    }

    setTaskPending(db, 't1');
    const after = db.prepare("SELECT status, output_json, started_at FROM tasks WHERE id='t1'").get() as {
      status: string; output_json: string; started_at: number | null;
    };
    // Status reset to pending and started_at cleared (so the re-run takes a
    // fresh lease)...
    expect(after.status).toBe('pending');
    expect(after.started_at).toBeNull();
    // ...but the prior output is intact — the pin/freeze reuse contract.
    expect(after.output_json).toBe('COMPLETED OUTPUT');

    db.close();
  });

  it('round-trips a completed -> pending -> completed cycle without losing output between rewinds', () => {
    const db = setup();
    insertTask(db, makeTask({ id: 't1' }));

    setTaskCompleted(db, 't1', 'FIRST');
    setTaskPending(db, 't1');
    expect(
      (db.prepare("SELECT output_json FROM tasks WHERE id='t1'").get() as { output_json: string }).output_json,
    ).toBe('FIRST');

    // A second real completion overwrites the stored output as expected.
    setTaskCompleted(db, 't1', 'SECOND');
    setTaskPending(db, 't1');
    expect(
      (db.prepare("SELECT output_json FROM tasks WHERE id='t1'").get() as { output_json: string }).output_json,
    ).toBe('SECOND');

    db.close();
  });
});
