import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertWorkflow, insertTask, loadWorkflowTasks } from '../../src/db/persist.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'file_scope persistence test',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(id: string, workflowId: string): Task {
  return {
    id,
    workflow_id: workflowId,
    name: 'test task',
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

describe('task file_scope persistence (S12 hotfix)', () => {
  it('round-trips file_scope through insertTask + loadWorkflowTasks', () => {
    const db = initDb(':memory:');
    const wfId = 'wf_test_fs_01';
    insertWorkflow(db, makeWorkflow(wfId));
    insertTask(db, {
      ...makeTask('tk_fs_01', wfId),
      file_scope: ['src/foo.ts', 'src/bar.ts'],
    });

    const tasks = loadWorkflowTasks(db, wfId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].file_scope).toEqual(['src/foo.ts', 'src/bar.ts']);
    db.close();
  });

  it('persists undefined file_scope as null and round-trips back to undefined', () => {
    const db = initDb(':memory:');
    const wfId = 'wf_test_fs_02';
    insertWorkflow(db, makeWorkflow(wfId));
    insertTask(db, makeTask('tk_fs_02', wfId));

    const tasks = loadWorkflowTasks(db, wfId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].file_scope).toBeUndefined();
    db.close();
  });

  it('round-trips an empty file_scope array as []', () => {
    const db = initDb(':memory:');
    const wfId = 'wf_test_fs_03';
    insertWorkflow(db, makeWorkflow(wfId));
    insertTask(db, {
      ...makeTask('tk_fs_03', wfId),
      file_scope: [],
    });

    const tasks = loadWorkflowTasks(db, wfId);
    expect(tasks).toHaveLength(1);
    // [] is truthy so it serializes as '[]' and parses back as []
    expect(tasks[0].file_scope).toEqual([]);
    db.close();
  });
});
