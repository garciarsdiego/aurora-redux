import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow, getWorkflowUsedUsdForCap } from '../../src/brain/executor.js';
import { insertWorkflow, newWorkflowId } from '../../src/db/persist.js';
import { insertTask } from '../../src/db/persist.js';
import {
  enforceWorkflowCostCapBeforeTask,
  releaseCostReservation,
  clearWorkflowCostReservations,
  getReservedCostUsd,
  WorkflowCostCapError,
} from '../../src/brain/executor/cost-cap.js';
import type { Dag, Task, Workflow } from '../../src/types/index.js';

const stubConsolidate = async (): Promise<string> => 'consolidated';

function makeLlmTask(id: string, estimate: number): Task {
  return {
    id,
    workflow_id: 'wf-hard',
    name: id,
    kind: 'llm_call',
    input_json: JSON.stringify({ estimated_cost_usd: estimate }),
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
  } as Task;
}

function seedCappedWorkflow(
  db: ReturnType<typeof initDb>,
  wfId: string,
  cap: number,
  tasks: Task[] = [],
): void {
  const now = Date.now();
  insertWorkflow(db, {
    id: wfId,
    workspace: 'internal',
    objective: 'hard cap',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: cap,
    max_duration_seconds: null,
    metadata: null,
  });
  // Insert the task rows so FK-bearing writes (setTaskSkipped / insertEvent with
  // task_id) inside enforceWorkflowCostCapBeforeTask have valid targets — the
  // events.task_id and tasks.id foreign keys are enforced (PRAGMA foreign_keys=ON).
  for (const t of tasks) insertTask(db, t);
}

describe('executor cost cap (per-DAG max_total_cost_usd)', () => {
  it('allows llm_call tasks when used + estimate stays strictly under cap', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'A', kind: 'llm_call', depends_on: [], estimated_cost_usd: 0.03 },
        { id: 'b', name: 'B', kind: 'llm_call', depends_on: ['a'], estimated_cost_usd: 0.02 },
      ],
    };
    const calls: string[] = [];
    const wf = await executeWorkflow(db, dag, 'internal', 'under cap', {
      consolidateFn: stubConsolidate,
      max_total_cost_usd: 1.0,
      executeTaskFn: async (task: Task): Promise<string> => {
        calls.push(task.name);
        task.model_used = 'test/model';
        task.llm_call_cost_usd = 0.03;
        return `ok:${task.name}`;
      },
      costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
    });

    expect(wf.status).toBe('completed');
    expect(calls).toEqual(['A', 'B']);
    db.close();
  });

  it('allows the next task when used + estimate exactly equals cap', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'A', kind: 'llm_call', depends_on: [], estimated_cost_usd: 0.09 },
        { id: 'b', name: 'B', kind: 'llm_call', depends_on: ['a'], estimated_cost_usd: 0.01 },
      ],
    };
    const executeTaskFn = async (task: Task): Promise<string> => {
      task.model_used = 'test/model';
      task.llm_call_cost_usd = task.name === 'A' ? 0.09 : 0.01;
      return `ok:${task.name}`;
    };

    const wf = await executeWorkflow(db, dag, 'internal', 'exact cap', {
      consolidateFn: stubConsolidate,
      max_total_cost_usd: 0.1,
      executeTaskFn,
      costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
    });

    expect(wf.status).toBe('completed');
    const rows = db
      .prepare(`SELECT name, status FROM tasks WHERE workflow_id = ? ORDER BY name`)
      .all(wf.id) as { name: string; status: string }[];
    expect(rows).toEqual([
      { name: 'A', status: 'completed' },
      { name: 'B', status: 'completed' },
    ]);
    db.close();
  });

  it('skips tasks and fails workflow when estimate would exceed cap', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'A', kind: 'llm_call', depends_on: [], estimated_cost_usd: 0.06 },
        { id: 'b', name: 'B', kind: 'llm_call', depends_on: ['a'], estimated_cost_usd: 0.05 },
      ],
    };
    const calls: string[] = [];
    await expect(
      executeWorkflow(db, dag, 'internal', 'exceed cap', {
        consolidateFn: stubConsolidate,
        max_total_cost_usd: 0.1,
        executeTaskFn: async (task: Task): Promise<string> => {
          calls.push(task.name);
          task.model_used = 'test/model';
          task.llm_call_cost_usd = 0.06;
          return `ok:${task.name}`;
        },
        costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
      }),
    ).rejects.toThrow(/cost cap/i);

    expect(calls).toEqual(['A']);

    const wfRow = db
      .prepare(`SELECT status FROM workflows ORDER BY created_at DESC LIMIT 1`)
      .get() as { status: string };
    expect(wfRow.status).toBe('failed');

    const capHit = db
      .prepare(`SELECT type, payload_json FROM events WHERE type = 'workflow_cost_cap_hit'`)
      .get() as { type: string; payload_json: string } | undefined;
    expect(capHit).toBeDefined();
    const payload = JSON.parse(capHit!.payload_json) as {
      used: number;
      cap: number;
      remaining_tasks: string[];
    };
    expect(payload.cap).toBeCloseTo(0.1, 5);
    expect(payload.used).toBeCloseTo(0.06, 5);
    expect(payload.remaining_tasks.length).toBeGreaterThanOrEqual(1);
    const bRow = db.prepare(`SELECT id FROM tasks WHERE name = 'B'`).get() as { id: string };
    expect(payload.remaining_tasks).toContain(bRow.id);

    const b = db.prepare(`SELECT status, output_json FROM tasks WHERE name = 'B'`).get() as {
      status: string;
      output_json: string | null;
    };
    expect(b.status).toBe('skipped');
    expect(JSON.parse(b.output_json ?? '{}').skip_reason).toBe('cost_cap_reached');
    db.close();
  });

  it('surfaces max_total_cost_usd on persisted Workflow rows', () => {
    const wf: Workflow = {
      id: 'wf_test',
      workspace: 'internal',
      objective: 'x',
      pattern_id: null,
      status: 'executing',
      started_at: 1,
      completed_at: null,
      created_at: 1,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      max_total_cost_usd: 0.25,
      metadata: null,
    };
    expect(wf.max_total_cost_usd).toBe(0.25);
  });

  it('uses workflows.actual_cost_usd as spend baseline when the column is set', () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const now = Date.now();
    insertWorkflow(db, {
      id: wfId,
      workspace: 'internal',
      objective: 'cap baseline',
      pattern_id: null,
      status: 'executing',
      started_at: now,
      completed_at: null,
      created_at: now,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: 0.123,
      max_total_cost_usd: 1.0,
      metadata: null,
    });
    expect(getWorkflowUsedUsdForCap(db, wfId)).toBeCloseTo(0.123, 6);
    db.close();
  });

  it('enforces cap for cli_spawn using estimate before any spawn runs', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        {
          id: 'a',
          name: 'A',
          kind: 'cli_spawn',
          depends_on: [],
          estimated_cost_usd: 0.05,
          executor_hint: 'cli:test',
        },
      ],
    };
    const calls: string[] = [];
    await expect(
      executeWorkflow(db, dag, 'internal', 'cli cap', {
        consolidateFn: stubConsolidate,
        max_total_cost_usd: 0.01,
        executeTaskFn: async (task: Task): Promise<string> => {
          calls.push(task.name);
          return 'ok';
        },
        costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
      }),
    ).rejects.toThrow(/cost cap/i);
    expect(calls).toEqual([]);
    const a = db.prepare(`SELECT status FROM tasks WHERE name = 'A'`).get() as { status: string };
    expect(a.status).toBe('skipped');
    db.close();
  });
});

describe('executor cost cap — HARD ceiling via reservations (BRAIN-04)', () => {
  const WF = 'wf-hard';

  it('reserves the estimate on pass so a parallel batch cannot overshoot the cap', () => {
    const db = initDb(':memory:');
    clearWorkflowCostReservations(WF);

    // Simulate a wide parallel batch: NO task has completed yet, so DB `used`
    // is 0 for all. Pre-fix, every task compared 0 + 0.04 <= 0.1 and all 3
    // passed (total 0.12 > 0.1 overshoot). Post-fix, each pass reserves its
    // estimate so the third task sees the prior two reservations.
    const t1 = makeLlmTask('t1', 0.04);
    const t2 = makeLlmTask('t2', 0.04);
    const t3 = makeLlmTask('t3', 0.04);
    seedCappedWorkflow(db, WF, 0.1, [t1, t2, t3]);

    // t1: used=0 reserved=0 → 0.04 <= 0.1 → pass + reserve 0.04
    enforceWorkflowCostCapBeforeTask(db, t1, WF, [t1, t2, t3]);
    expect(t1.status).toBe('pending');
    expect(getReservedCostUsd(WF)).toBeCloseTo(0.04, 6);

    // t2: used=0 reserved=0.04 → 0.08 <= 0.1 → pass + reserve another 0.04
    enforceWorkflowCostCapBeforeTask(db, t2, WF, [t1, t2, t3]);
    expect(t2.status).toBe('pending');
    expect(getReservedCostUsd(WF)).toBeCloseTo(0.08, 6);

    // t3: used=0 reserved=0.08 → 0.12 > 0.1 → HARD ceiling trips (throws + skips).
    expect(() => enforceWorkflowCostCapBeforeTask(db, t3, WF, [t1, t2, t3]))
      .toThrow(WorkflowCostCapError);
    expect(t3.status).toBe('skipped');

    const wfRow = db.prepare(`SELECT status FROM workflows WHERE id = ?`).get(WF) as { status: string };
    expect(wfRow.status).toBe('failed');

    clearWorkflowCostReservations(WF);
    db.close();
  });

  it('releasing a reservation frees headroom for the next task', () => {
    const db = initDb(':memory:');
    clearWorkflowCostReservations(WF);

    const t1 = makeLlmTask('t1', 0.06);
    const t2 = makeLlmTask('t2', 0.06);
    seedCappedWorkflow(db, WF, 0.1, [t1, t2]);

    enforceWorkflowCostCapBeforeTask(db, t1, WF, [t1, t2]);
    expect(getReservedCostUsd(WF)).toBeCloseTo(0.06, 6);

    // Without releasing, t2 (0.06) would push 0.12 > 0.1 and be skipped. After
    // releasing t1's reservation (e.g. its real cost is now in the ledger), the
    // headroom is restored and t2 passes.
    releaseCostReservation(WF, 't1');
    expect(getReservedCostUsd(WF)).toBeCloseTo(0, 6);

    enforceWorkflowCostCapBeforeTask(db, t2, WF, [t1, t2]);
    expect(t2.status).toBe('pending');
    expect(getReservedCostUsd(WF)).toBeCloseTo(0.06, 6);

    clearWorkflowCostReservations(WF);
    db.close();
  });

  it('re-checking the same task (retry) does not double-count its own reservation', () => {
    const db = initDb(':memory:');
    clearWorkflowCostReservations(WF);

    const t1 = makeLlmTask('t1', 0.06);
    seedCappedWorkflow(db, WF, 0.1, [t1]);
    enforceWorkflowCostCapBeforeTask(db, t1, WF, [t1]);
    expect(getReservedCostUsd(WF)).toBeCloseTo(0.06, 6);

    // Retry re-entry: same task re-checks. It must overwrite, not add, so the
    // reservation total stays 0.06 (0.06+0.06 would be 0.12 > 0.1 and falsely trip).
    enforceWorkflowCostCapBeforeTask(db, t1, WF, [t1]);
    expect(t1.status).toBe('pending');
    expect(getReservedCostUsd(WF)).toBeCloseTo(0.06, 6);

    clearWorkflowCostReservations(WF);
    db.close();
  });

  it('clearWorkflowCostReservations drops the whole workflow ledger', () => {
    const db = initDb(':memory:');
    clearWorkflowCostReservations(WF);

    const t1 = makeLlmTask('t1', 0.2);
    seedCappedWorkflow(db, WF, 1.0, [t1]);
    enforceWorkflowCostCapBeforeTask(db, t1, WF, [t1]);
    expect(getReservedCostUsd(WF)).toBeCloseTo(0.2, 6);

    clearWorkflowCostReservations(WF);
    expect(getReservedCostUsd(WF)).toBe(0);
    db.close();
  });
});
