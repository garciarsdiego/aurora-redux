// Tier 0 / P-05 regression — atomic workflow + tasks insert.
//
// `insertWorkflowWithTasks` must either commit the workflow row AND every
// task row, or none of them. The race we are guarding against is:
//
//   1. insertWorkflow → commits
//   2. insertTask (task #1) → throws on a CHECK constraint
//   3. Workflow row remains in the DB with zero children — the dashboard
//      surfaces a zombie workflow that can never make progress.
//
// Production call sites (orchestrate.ts, remediation.ts) already wrap the
// inserts in db.transaction(); this test pins the helper so future callers
// don't have to re-implement the pattern.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflowWithTasks,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import { getDbPath } from '../../src/utils/config.js';
import type { Workflow, Task } from '../../src/types/index.js';

const workspace = 'integration_test_atomic_insert';

function makeWorkflow(id: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective: 'atomicity regression test',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: 'atomicity_test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(id: string, workflowId: string, kind: string): Task {
  return {
    id,
    workflow_id: workflowId,
    name: `task ${id}`,
    // Cast wide — for the invalid-kind case we deliberately violate the union.
    kind: kind as Task['kind'],
    input_json: '{}',
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 1,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: 'exit code equals 0',
    refine_count: 0,
    max_refine: 1,
    refine_feedback: null,
    model: null,
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

describe('insertWorkflowWithTasks — atomicity', () => {
  let db: ReturnType<typeof initDb>;
  const ids: string[] = [];

  beforeEach(() => {
    db = initDb(getDbPath());
  });

  afterEach(() => {
    // Clean up any rows our tests landed.
    for (const id of ids) {
      db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(id);
      db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    }
    ids.length = 0;
    db.close();
  });

  it('commits workflow + all tasks together on the happy path', () => {
    const wfId = newWorkflowId();
    ids.push(wfId);
    const wf = makeWorkflow(wfId);
    const tasks = [
      makeTask(newTaskId(), wfId, 'llm_call'),
      makeTask(newTaskId(), wfId, 'llm_call'),
    ];

    insertWorkflowWithTasks(db, wf, tasks);

    const workflowCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM workflows WHERE id = ?')
        .get(wfId) as { c: number }
    ).c;
    const taskCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM tasks WHERE workflow_id = ?')
        .get(wfId) as { c: number }
    ).c;
    expect(workflowCount).toBe(1);
    expect(taskCount).toBe(2);
  });

  it('rolls back the workflow row when a task insert violates a constraint', () => {
    const wfId = newWorkflowId();
    ids.push(wfId);
    const wf = makeWorkflow(wfId);
    // Force a PRIMARY KEY violation on the second task — same id as the first.
    const dupId = newTaskId();
    const tasks = [
      makeTask(dupId, wfId, 'llm_call'),
      makeTask(dupId, wfId, 'llm_call'),
    ];

    expect(() => insertWorkflowWithTasks(db, wf, tasks)).toThrow(/UNIQUE|PRIMARY/i);

    const workflowCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM workflows WHERE id = ?')
        .get(wfId) as { c: number }
    ).c;
    const taskCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM tasks WHERE workflow_id = ?')
        .get(wfId) as { c: number }
    ).c;
    // The whole transaction is rolled back — no orphan workflow, no partial tasks.
    expect(workflowCount).toBe(0);
    expect(taskCount).toBe(0);
  });

  it('rejects mismatched task.workflow_id before any DB write', () => {
    const wfId = newWorkflowId();
    const otherWfId = newWorkflowId();
    ids.push(wfId);
    const wf = makeWorkflow(wfId);
    const tasks = [
      makeTask(newTaskId(), otherWfId, 'llm_call'),
    ];

    expect(() => insertWorkflowWithTasks(db, wf, tasks)).toThrow(/workflow_id/);

    // Nothing should have landed — the guard runs before the transaction starts.
    const workflowCount = (
      db
        .prepare('SELECT COUNT(*) as c FROM workflows WHERE id = ?')
        .get(wfId) as { c: number }
    ).c;
    expect(workflowCount).toBe(0);
  });
});
