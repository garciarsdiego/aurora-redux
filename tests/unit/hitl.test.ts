import { describe, it, expect, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import type { Dag, Task } from '../../src/types/index.js';

const stubConsolidate = async (): Promise<string> => 'stub consolidated';
const stubExecute = async (task: Task): Promise<string> => `output: ${task.name}`;
const stubReview = async (): Promise<{ score: number; feedback: string; passed: boolean }> =>
  ({ score: 1, feedback: 'ok', passed: true });

describe('HITL gate', () => {
  it('task without hitl executes without calling hitlFn', async () => {
    const db = initDb(':memory:');
    const hitlFn = vi.fn(async () => 'approve' as const);

    const dag: Dag = {
      tasks: [{ id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] }],
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'no hitl test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
      reviewFn: stubReview,
      hitlFn,
    });

    expect(wf.status).toBe('completed');
    expect(hitlFn).not.toHaveBeenCalled();
  });

  it('task with hitl: true + auto-approve bypasses hitlFn and succeeds', async () => {
    const db = initDb(':memory:');
    const hitlFn = vi.fn(async () => 'approve' as const);

    const dag: Dag = {
      tasks: [{ id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [], hitl: true }],
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'auto-approve test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
      reviewFn: stubReview,
      hitlFn,
      autoApprove: true,
    });

    expect(wf.status).toBe('completed');
    // hitlFn must NOT be called when autoApprove is true
    expect(hitlFn).not.toHaveBeenCalled();

    // hitl_gates record must be created and resolved as approved
    const gate = db.prepare(`SELECT status FROM hitl_gates WHERE workflow_id = ?`).get(wf.id) as
      | { status: string }
      | undefined;
    expect(gate?.status).toBe('approved');
  });

  it('task with hitl: true + approve decision continues and completes', async () => {
    const db = initDb(':memory:');
    const hitlFn = vi.fn(async () => 'approve' as const);

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Gated Task', kind: 'llm_call', depends_on: [], hitl: true },
        { id: 'b', name: 'Downstream', kind: 'llm_call', depends_on: ['a'] },
      ],
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'approve test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
      reviewFn: stubReview,
      hitlFn,
    });

    expect(wf.status).toBe('completed');
    expect(hitlFn).toHaveBeenCalledOnce();
    expect(hitlFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gated Task' }));

    const tasks = db
      .prepare('SELECT name, status FROM tasks WHERE workflow_id = ?')
      .all(wf.id) as { name: string; status: string }[];
    expect(tasks.every((t) => t.status === 'completed')).toBe(true);

    const gate = db.prepare(`SELECT status FROM hitl_gates WHERE workflow_id = ?`).get(wf.id) as
      | { status: string }
      | undefined;
    expect(gate?.status).toBe('approved');
  });

  it('task with hitl: true + reject fails the task and stops the workflow', async () => {
    const db = initDb(':memory:');
    const hitlFn = vi.fn(async () => 'reject' as const);

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Gated Task', kind: 'llm_call', depends_on: [], hitl: true },
        { id: 'b', name: 'Downstream', kind: 'llm_call', depends_on: ['a'] },
      ],
    };

    await expect(
      executeWorkflow(db, dag, '__test__', 'reject test', {
        consolidateFn: stubConsolidate,
        executeTaskFn: stubExecute,
        reviewFn: stubReview,
        hitlFn,
      }),
    ).rejects.toThrow("Task 'Gated Task' rejeitada pelo HITL gate");

    // Gated task must be failed
    const gatedTask = db
      .prepare(`SELECT status FROM tasks WHERE name = ?`)
      .get('Gated Task') as { status: string } | undefined;
    expect(gatedTask?.status).toBe('failed');

    // hitl_gates record must be rejected
    const gate = db.prepare(`SELECT status FROM hitl_gates`).get() as
      | { status: string }
      | undefined;
    expect(gate?.status).toBe('rejected');

    // Workflow must be failed
    const wf = db
      .prepare(`SELECT status FROM workflows`)
      .get() as { status: string } | undefined;
    expect(wf?.status).toBe('failed');
  });

  it('non-hitl task in DAG with mixed hitl tasks runs without gate', async () => {
    const db = initDb(':memory:');
    const hitlFn = vi.fn(async () => 'approve' as const);

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Free Task',  kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Gated Task', kind: 'llm_call', depends_on: ['a'], hitl: true },
      ],
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'mixed test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
      reviewFn: stubReview,
      hitlFn,
    });

    expect(wf.status).toBe('completed');
    // Gate only for the hitl task
    expect(hitlFn).toHaveBeenCalledOnce();
    expect(hitlFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'Gated Task' }));
  });

  it('plan-gate task (no deps + hitl:true) receives planContext with full DAG', async () => {
    const db = initDb(':memory:');
    let receivedInfo: Record<string, unknown> | undefined;
    const hitlFn = vi.fn(async (info: Record<string, unknown>) => {
      receivedInfo = info;
      return 'approve' as const;
    });

    const dag: Dag = {
      tasks: [
        { id: 't0', name: 'Review execution plan', kind: 'llm_call', depends_on: [], hitl: true,
          acceptance_criteria: 'Plan lists all tasks' },
        { id: 't1', name: 'Build module A', kind: 'cli_spawn', depends_on: ['t0'],
          acceptance_criteria: 'Module A produced' },
        { id: 't2', name: 'Build module B', kind: 'cli_spawn', depends_on: ['t0'],
          acceptance_criteria: 'Module B produced' },
        { id: 't3', name: 'Assemble final', kind: 'cli_spawn', depends_on: ['t1', 't2'],
          acceptance_criteria: 'Final artifact exists' },
      ],
    };

    await executeWorkflow(db, dag, '__test__', 'plan-gate UX test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
      reviewFn: stubReview,
      hitlFn,
    });

    expect(hitlFn).toHaveBeenCalledOnce();
    expect(receivedInfo).toBeDefined();
    expect(receivedInfo!['name']).toBe('Review execution plan');

    // planContext must be present on the t0 plan-gate prompt
    const planCtx = receivedInfo!['planContext'] as
      | { workflowId: string; objective: string; tasks: Array<{ name: string }> }
      | undefined;
    expect(planCtx).toBeDefined();
    expect(planCtx!.objective).toBe('plan-gate UX test');
    expect(planCtx!.tasks).toHaveLength(4);
    expect(planCtx!.tasks.map((t) => t.name)).toEqual([
      'Review execution plan',
      'Build module A',
      'Build module B',
      'Assemble final',
    ]);
  });

  it('downstream hitl gate (with deps) does NOT receive planContext', async () => {
    const db = initDb(':memory:');
    let receivedInfo: Record<string, unknown> | undefined;
    const hitlFn = vi.fn(async (info: Record<string, unknown>) => {
      receivedInfo = info;
      return 'approve' as const;
    });

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Free Task',  kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Mid-DAG Gate', kind: 'llm_call', depends_on: ['a'], hitl: true },
      ],
    };

    await executeWorkflow(db, dag, '__test__', 'mid-DAG hitl', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
      reviewFn: stubReview,
      hitlFn,
    });

    expect(receivedInfo!['name']).toBe('Mid-DAG Gate');
    // Mid-DAG hitl gates have deps → not the plan gate → no planContext
    expect(receivedInfo!['planContext']).toBeUndefined();
  });
});
