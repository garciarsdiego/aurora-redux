import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  saveWorkflowAsPattern,
  loadPattern,
  listPatterns,
  deletePattern,
  bumpPatternUsage,
} from '../../src/patterns/store.js';
import {
  newWorkflowId,
  newTaskId,
  insertWorkflow,
  insertTask,
  setTaskCompleted,
} from '../../src/db/persist.js';
import type { Workflow, Task } from '../../src/types/index.js';

function makeCompletedWorkflow(id: string, workspace: string, objective: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective,
    pattern_id: null,
    status: 'completed',
    started_at: now - 1000,
    completed_at: now,
    created_at: now - 1000,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    metadata: null,
  };
}

function makeTask(id: string, wfId: string, name: string, deps: string[]): Task {
  return {
    id,
    workflow_id: wfId,
    name,
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'completed',
    depends_on: deps,
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: null,
    completed_at: Date.now(),
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
  };
}

describe('pattern store — CRUD', () => {
  it('saveWorkflowAsPattern inserts pattern; load returns correct data', () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const aId = newTaskId();
    const bId = newTaskId();

    insertWorkflow(db, makeCompletedWorkflow(wfId, 'internal', 'Build landing page'));
    insertTask(db, makeTask(aId, wfId, 'Design layout', []));
    insertTask(db, makeTask(bId, wfId, 'Write copy', [aId]));
    setTaskCompleted(db, aId, 'layout done');
    setTaskCompleted(db, bId, 'copy done');

    const pattern = saveWorkflowAsPattern(db, wfId, 'landing-page');

    expect(pattern.id).toMatch(/^pt_/);
    expect(pattern.workspace).toBe('internal');
    expect(pattern.name).toBe('landing-page');
    expect(pattern.source).toBe('generated');
    expect(pattern.objective_sample).toBe('Build landing page');
    expect(pattern.usage_count).toBe(0);

    // DAG round-trip
    const dag = JSON.parse(pattern.dag_json) as { tasks: Array<{ id: string; name: string; depends_on: string[] }> };
    expect(dag.tasks).toHaveLength(2);
    const taskA = dag.tasks.find((t) => t.name === 'Design layout');
    const taskB = dag.tasks.find((t) => t.name === 'Write copy');
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
    // depends_on uses task names as stable IDs, not UUIDs
    expect(taskB!.depends_on).toContain('Design layout');
    expect(taskA!.depends_on).toHaveLength(0);

    // loadPattern round-trip
    const loaded = loadPattern(db, pattern.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('landing-page');
    expect(loaded!.dag_json).toBe(pattern.dag_json);

    db.close();
  });

  it('saveWorkflowAsPattern throws when workflow is not completed', () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    insertWorkflow(db, {
      ...makeCompletedWorkflow(wfId, 'internal', 'test'),
      status: 'executing',
    });

    expect(() => saveWorkflowAsPattern(db, wfId, 'my-pattern')).toThrow(/completed/);

    db.close();
  });

  it('saveWorkflowAsPattern throws when workflow_id not found', () => {
    const db = initDb(':memory:');
    expect(() => saveWorkflowAsPattern(db, 'wf_nonexistent', 'test')).toThrow(/not found/);
    db.close();
  });

  it('listPatterns filters by workspace', () => {
    const db = initDb(':memory:');

    for (const ws of ['internal', 'internal', 'globex']) {
      const wfId = newWorkflowId();
      insertWorkflow(db, makeCompletedWorkflow(wfId, ws, `obj ${ws}`));
      const tid = newTaskId();
      insertTask(db, makeTask(tid, wfId, 'Task A', []));
      setTaskCompleted(db, tid, 'done');
      saveWorkflowAsPattern(db, wfId, `pattern-${wfId.slice(0, 8)}`);
    }

    const internal = listPatterns(db, 'internal');
    const globex = listPatterns(db, 'globex');

    expect(internal).toHaveLength(2);
    expect(globex).toHaveLength(1);
    expect(internal.every((p) => p.workspace === 'internal')).toBe(true);

    db.close();
  });

  it('deletePattern removes the row; returns false when not found', () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    insertWorkflow(db, makeCompletedWorkflow(wfId, 'internal', 'test'));
    const tid = newTaskId();
    insertTask(db, makeTask(tid, wfId, 'Task A', []));
    setTaskCompleted(db, tid, 'done');

    const pattern = saveWorkflowAsPattern(db, wfId, 'to-delete');

    expect(deletePattern(db, pattern.id)).toBe(true);
    expect(loadPattern(db, pattern.id)).toBeNull();
    expect(deletePattern(db, pattern.id)).toBe(false); // already gone

    db.close();
  });

  it('bumpPatternUsage increments usage_count and sets last_used_at', () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    insertWorkflow(db, makeCompletedWorkflow(wfId, 'internal', 'test'));
    const tid = newTaskId();
    insertTask(db, makeTask(tid, wfId, 'Task A', []));
    setTaskCompleted(db, tid, 'done');

    const pattern = saveWorkflowAsPattern(db, wfId, 'bump-test');
    expect(pattern.usage_count).toBe(0);
    expect(pattern.last_used_at).toBeNull();

    bumpPatternUsage(db, pattern.id);
    bumpPatternUsage(db, pattern.id);

    const updated = loadPattern(db, pattern.id);
    expect(updated!.usage_count).toBe(2);
    expect(updated!.last_used_at).not.toBeNull();
    expect(updated!.last_used_at).toBeGreaterThan(0);

    db.close();
  });
});
