import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  insertTask,
  insertWorkflow,
  newTaskId,
  newWorkflowId,
} from '../../src/db/persist.js';
import {
  loadWorkflowControlState,
  requestWorkflowControl,
} from '../../src/db/workflow-control.js';
import { runTaskLoop } from '../../src/brain/executor.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'workflow control test',
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

function makeTask(
  workflowId: string,
  name: string,
  dependsOn: string[] = [],
): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: workflowId,
    name,
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'pending',
    depends_on: dependsOn,
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: null,
    completed_at: null,
    created_at: now,
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function eventTypes(db: ReturnType<typeof initDb>, workflowId: string): string[] {
  return (
    db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(workflowId) as Array<{ type: string }>
  ).map((event) => event.type);
}

describe('dashboard workflow control contract', () => {
  it('requesting pause persists structured control state and emits an audit event', () => {
    const db = initDb(':memory:');
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);

    const result = requestWorkflowControl(db, workflow.id, {
      action: 'pause',
      reason: 'inspect before next task',
      requestedBy: 'dashboard',
    });

    expect(result).toMatchObject({
      workflow_id: workflow.id,
      action: 'pause',
      state: 'pause_requested',
      daemon_acknowledged: true,
      audit_event: 'workflow_pause_requested',
    });
    expect(loadWorkflowControlState(db, workflow.id)).toMatchObject({
      workflow_id: workflow.id,
      state: 'pause_requested',
      requested_by: 'dashboard',
      reason: 'inspect before next task',
    });
    expect(eventTypes(db, workflow.id)).toContain('workflow_pause_requested');

    db.close();
  });

  it('pauses before dispatching the next ready task and resumes after acknowledgement', async () => {
    const db = initDb(':memory:');
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);
    const first = makeTask(workflow.id, 'First task');
    const second = makeTask(workflow.id, 'Second task', [first.id]);
    insertTask(db, first);
    insertTask(db, second);
    const tasks = [first, second];
    const calls: string[] = [];

    await runTaskLoop(db, tasks, workflow.id, new Set(), {
      controlPollMs: 5,
      executeTaskFn: async (task) => {
        calls.push(task.name);
        if (task.id === first.id) {
          requestWorkflowControl(db, workflow.id, {
            action: 'pause',
            reason: 'pause after first',
            requestedBy: 'dashboard',
          });
          setTimeout(() => {
            requestWorkflowControl(db, workflow.id, {
              action: 'resume',
              reason: 'continue test',
              requestedBy: 'dashboard',
            });
          }, 20);
        }
        return `ok: ${task.name}`;
      },
      sleepFn: async (ms) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });

    expect(calls).toEqual(['First task', 'Second task']);
    expect(eventTypes(db, workflow.id)).toEqual(expect.arrayContaining([
      'workflow_pause_requested',
      'workflow_paused',
      'workflow_resume_requested',
      'workflow_resumed',
    ]));
    expect(loadWorkflowControlState(db, workflow.id)).toMatchObject({
      state: 'running',
    });

    db.close();
  });

  it('cancel prevents pending tasks from starting and marks the workflow canceled', async () => {
    const db = initDb(':memory:');
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);
    const first = makeTask(workflow.id, 'First task');
    const second = makeTask(workflow.id, 'Second task', [first.id]);
    insertTask(db, first);
    insertTask(db, second);
    const tasks = [first, second];
    const calls: string[] = [];

    await expect(
      runTaskLoop(db, tasks, workflow.id, new Set(), {
        controlPollMs: 5,
        executeTaskFn: async (task) => {
          calls.push(task.name);
          if (task.id === first.id) {
            requestWorkflowControl(db, workflow.id, {
              action: 'cancel',
              reason: 'operator stopped run',
              requestedBy: 'dashboard',
            });
          }
          return `ok: ${task.name}`;
        },
      }),
    ).rejects.toThrow(/cancel/i);

    expect(calls).toEqual(['First task']);
    const workflowRow = db
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(workflow.id) as { status: string };
    const secondRow = db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(second.id) as { status: string };
    expect(workflowRow.status).toBe('cancelled');
    expect(secondRow.status).toBe('cancelled');
    expect(loadWorkflowControlState(db, workflow.id)).toMatchObject({
      state: 'canceled',
    });
    expect(eventTypes(db, workflow.id)).toEqual(expect.arrayContaining([
      'workflow_cancel_requested',
      'workflow_canceled',
    ]));

    db.close();
  });
});
