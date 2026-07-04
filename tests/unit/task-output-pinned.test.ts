// Aurora-parity Wave 2 — pin/freeze upstream outputs (backend slice). A task
// whose output is "pinned" reuses its stored output_json on a re-run instead of
// re-executing (zero model spend) — the substrate Wave-3 rewind/fork builds on.
import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { runTaskLoop } from '../../src/brain/executor.js';
import {
  insertWorkflow,
  insertTask,
  loadWorkflowTasks,
  setTaskOutputPinned,
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

describe('pin/freeze — executor short-circuit', () => {
  it('reuses a pinned task’s stored output without executing', async () => {
    const db = setup();
    const task = makeTask({ output_pinned: true, output_json: 'PINNED OUTPUT' });
    insertTask(db, task);
    const exec = vi.fn(async () => 'FRESH OUTPUT');

    await runTaskLoop(db, [task], 'wf1', new Set(), { executeTaskFn: exec, sleepFn: async () => {} });

    expect(exec).not.toHaveBeenCalled();
    const row = db.prepare("SELECT status, output_json FROM tasks WHERE id = 't1'").get() as {
      status: string; output_json: string;
    };
    expect(row.status).toBe('completed');
    expect(row.output_json).toBe('PINNED OUTPUT');
    const ev = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task_output_pinned_reused'").get() as { n: number };
    expect(ev.n).toBe(1);
    // No model spend attributed for a reused task.
    const calls = db.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE task_id = 't1'").get() as { n: number };
    expect(calls.n).toBe(0);
    db.close();
  });

  it('executes normally when pinned but there is NO stored output to reuse', async () => {
    const db = setup();
    const task = makeTask({ output_pinned: true, output_json: null });
    insertTask(db, task);
    const exec = vi.fn(async () => 'FRESH OUTPUT');

    await runTaskLoop(db, [task], 'wf1', new Set(), { executeTaskFn: exec, sleepFn: async () => {} });

    expect(exec).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('executes normally when NOT pinned (a stale stored output is ignored)', async () => {
    const db = setup();
    const task = makeTask({ output_pinned: false, output_json: 'STALE' });
    insertTask(db, task);
    const exec = vi.fn(async () => 'FRESH OUTPUT');

    await runTaskLoop(db, [task], 'wf1', new Set(), { executeTaskFn: exec, sleepFn: async () => {} });

    expect(exec).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('executes normally when pinned with an empty-string output (nothing to reuse)', async () => {
    const db = setup();
    const task = makeTask({ output_pinned: true, output_json: '' });
    insertTask(db, task);
    const exec = vi.fn(async () => 'FRESH OUTPUT');

    await runTaskLoop(db, [task], 'wf1', new Set(), { executeTaskFn: exec, sleepFn: async () => {} });

    expect(exec).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('audits the HITL-gate bypass when a pinned hitl task is reused', async () => {
    // Reusing a pinned output skips preDispatch (including the HITL gate) — the
    // intended frozen-output semantic, but it must be auditable.
    const db = setup();
    const task = makeTask({ output_pinned: true, output_json: 'APPROVED OUTPUT', hitl: true });
    insertTask(db, task);
    const exec = vi.fn(async () => 'FRESH OUTPUT');

    await runTaskLoop(db, [task], 'wf1', new Set(), { executeTaskFn: exec, sleepFn: async () => {} });

    expect(exec).not.toHaveBeenCalled();
    const bypass = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task_hitl_bypassed_by_pin'").get() as { n: number };
    expect(bypass.n).toBe(1);
    db.close();
  });
});

describe('pin/freeze — persistence', () => {
  it('round-trips output_pinned (number column -> boolean) through insert + load', () => {
    const db = setup();
    insertTask(db, makeTask({ id: 't1', output_pinned: true }));
    insertTask(db, makeTask({ id: 't2', output_pinned: false }));
    const tasks = loadWorkflowTasks(db, 'wf1');
    expect(tasks.find((t) => t.id === 't1')?.output_pinned).toBe(true);
    expect(tasks.find((t) => t.id === 't2')?.output_pinned).toBe(false);
    db.close();
  });

  it('setTaskOutputPinned toggles the flag', () => {
    const db = setup();
    insertTask(db, makeTask({ id: 't1' }));
    setTaskOutputPinned(db, 't1', true);
    expect((db.prepare("SELECT output_pinned FROM tasks WHERE id='t1'").get() as { output_pinned: number }).output_pinned).toBe(1);
    setTaskOutputPinned(db, 't1', false);
    expect((db.prepare("SELECT output_pinned FROM tasks WHERE id='t1'").get() as { output_pinned: number }).output_pinned).toBe(0);
    db.close();
  });
});

describe('pin/freeze — full rewind-then-reuse round-trip', () => {
  it('runs once, pins, rewinds (setTaskPending), reloads, re-runs reusing the stored output without executing', async () => {
    const db = setup();
    // 1) Pending llm_call task, NOT yet pinned. First run executes for real.
    const first = makeTask({ id: 't1', output_pinned: false, output_json: null, status: 'pending' });
    insertTask(db, first);

    const exec = vi.fn(async () => 'REAL OUTPUT FROM RUN 1');
    await runTaskLoop(db, [first], 'wf1', new Set(), { executeTaskFn: exec, sleepFn: async () => {} });

    expect(exec).toHaveBeenCalledTimes(1);
    {
      const row = db.prepare("SELECT status, output_json FROM tasks WHERE id='t1'").get() as {
        status: string; output_json: string;
      };
      expect(row.status).toBe('completed');
      expect(row.output_json).toBe('REAL OUTPUT FROM RUN 1');
    }

    // 2) Pin the task, then rewind it to pending (the Wave-3 fork/rewind move).
    setTaskOutputPinned(db, 't1', true);
    setTaskPending(db, 't1');

    // 3) Reload from DB — proves output_pinned survived AND output_json was
    // preserved across the rewind (the contract the reuse short-circuit relies
    // on — see the comment in run-task/index.ts).
    const reloaded = loadWorkflowTasks(db, 'wf1').find((t) => t.id === 't1');
    expect(reloaded).toBeDefined();
    expect(reloaded!.status).toBe('pending');
    expect(reloaded!.output_pinned).toBe(true);
    expect(reloaded!.output_json).toBe('REAL OUTPUT FROM RUN 1');

    // 4) Re-run with the reloaded (pinned + has-output + pending) task. The
    // executor must short-circuit: NO execution, output reused, event emitted.
    const exec2 = vi.fn(async () => 'SHOULD NOT RUN');
    await runTaskLoop(db, [reloaded!], 'wf1', new Set(), { executeTaskFn: exec2, sleepFn: async () => {} });

    expect(exec2).not.toHaveBeenCalled();
    const row2 = db.prepare("SELECT status, output_json FROM tasks WHERE id='t1'").get() as {
      status: string; output_json: string;
    };
    expect(row2.status).toBe('completed');
    expect(row2.output_json).toBe('REAL OUTPUT FROM RUN 1');
    const reused = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='task_output_pinned_reused'").get() as { n: number };
    expect(reused.n).toBe(1);
    db.close();
  });
});
