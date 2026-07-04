// OPP-C1 / H-FINDING-5 (2026-05-23) — Two-stage map-reduce consolidation.
//
// The harness eval on 2026-05-23 produced 8 TIMEOUTs at 600s, all on T4/T5
// tasks where the consolidator had to reassemble 5+ upstream outputs in a
// single LLM call. The fix introduces a MAP step: for each upstream output,
// in parallel and capped at 8 concurrent calls, summarize via a cheap model
// under an 800-token budget. Then the REDUCE step runs the original
// consolidator over the summarized tasks list.
//
// This test pins the threshold (>4 upstreams triggers map-reduce), the
// per-task event emission contract, and the graceful-degradation path when
// a map call fails.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflowWithTasks,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import { getDbPath } from '../../src/utils/config.js';
import type { Workflow, Task } from '../../src/types/index.js';

const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn(),
  callOmnirouteWithUsage: vi.fn(),
}));
vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

const { runConsolidation } = await import('../../src/brain/executor/consolidation.js');

const workspace = 'integration_test_consolidation_mapreduce';

function makeWorkflow(id: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective: 'map-reduce consolidation regression',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: 'mapreduce_test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeCompletedTask(id: string, workflowId: string, name: string, output: string): Task {
  return {
    id,
    workflow_id: workflowId,
    name,
    kind: 'llm_call',
    input_json: '{}',
    output_json: output,
    status: 'completed',
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

function loadEvents(db: ReturnType<typeof initDb>, wfId: string, type: string): Array<{ task_id: string | null; payload_json: string | null }> {
  return db
    .prepare('SELECT task_id, payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY id ASC')
    .all(wfId, type) as Array<{ task_id: string | null; payload_json: string | null }>;
}

describe('runConsolidation — two-stage map-reduce (OPP-C1)', () => {
  let db: ReturnType<typeof initDb>;
  const ids: string[] = [];
  const previousMapModel = process.env.CONSOLIDATOR_MAP_MODEL;

  beforeEach(() => {
    db = initDb(getDbPath());
    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
  });

  afterEach(() => {
    for (const id of ids) {
      db.prepare('DELETE FROM events WHERE workflow_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(id);
      db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    }
    ids.length = 0;
    db.close();
    if (previousMapModel === undefined) delete process.env.CONSOLIDATOR_MAP_MODEL;
    else process.env.CONSOLIDATOR_MAP_MODEL = previousMapModel;
  });

  it('(a) low fan-in (<=4 upstreams) uses the single-stage path — no map events emitted', async () => {
    const wfId = newWorkflowId();
    ids.push(wfId);
    const wf = makeWorkflow(wfId);
    const tasks = Array.from({ length: 4 }, (_, i) =>
      makeCompletedTask(newTaskId(), wfId, `task ${i}`, `output ${i}`),
    );
    insertWorkflowWithTasks(db, wf, tasks);

    const doConsolidate = vi.fn(async (_wf: Workflow, ts: Task[]) => {
      // Original (un-summarized) outputs should reach the consolidator.
      expect(ts.filter((t) => t.status === 'completed').map((t) => t.output_json)).toEqual([
        'output 0',
        'output 1',
        'output 2',
        'output 3',
      ]);
      return 'final-single-stage';
    });

    await runConsolidation(db, wf, tasks, doConsolidate);

    expect(doConsolidate).toHaveBeenCalledTimes(1);
    expect(omnirouteMock.callOmniroute).not.toHaveBeenCalled();
    expect(loadEvents(db, wfId, 'consolidation_map_started')).toHaveLength(0);
    expect(loadEvents(db, wfId, 'consolidation_map_completed')).toHaveLength(0);
    expect(loadEvents(db, wfId, 'consolidation_reduce_started')).toHaveLength(0);
    expect(loadEvents(db, wfId, 'consolidation_reduce_completed')).toHaveLength(0);
    expect(loadEvents(db, wfId, 'workflow_consolidated')).toHaveLength(1);
  });

  it('(b) high fan-in (>4 upstreams) runs MAP step in parallel and emits one event per task', async () => {
    const wfId = newWorkflowId();
    ids.push(wfId);
    const wf = makeWorkflow(wfId);
    const upstreamCount = 7;
    const tasks = Array.from({ length: upstreamCount }, (_, i) =>
      makeCompletedTask(newTaskId(), wfId, `task ${i}`, `output ${i}`),
    );
    insertWorkflowWithTasks(db, wf, tasks);

    omnirouteMock.callOmniroute.mockImplementation(async (args: { userPrompt: string }) => {
      // Echo a fake summary derived from the user prompt so the test can
      // assert that summaries (not raw outputs) reach the reducer.
      const match = /TASK NAME: (task \d+)/.exec(args.userPrompt);
      return `summary-of-${match?.[1] ?? 'unknown'}`;
    });

    const doConsolidate = vi.fn(async (_wf: Workflow, ts: Task[]) => {
      const outputs = ts.filter((t) => t.status === 'completed').map((t) => t.output_json);
      // Each output must have been replaced with its MAP summary.
      for (const out of outputs) {
        expect(out).toMatch(/^summary-of-task \d+$/);
      }
      return 'final-map-reduce';
    });

    await runConsolidation(db, wf, tasks, doConsolidate);

    // MAP called once per upstream (parallel).
    expect(omnirouteMock.callOmniroute).toHaveBeenCalledTimes(upstreamCount);
    expect(doConsolidate).toHaveBeenCalledTimes(1);

    // Per-task map_started/completed events (upstreamCount each) PLUS one
    // workflow-level start + one workflow-level end = N+1 total of each.
    const mapStarted = loadEvents(db, wfId, 'consolidation_map_started');
    const mapCompleted = loadEvents(db, wfId, 'consolidation_map_completed');
    expect(mapStarted.length).toBe(upstreamCount + 1);
    expect(mapCompleted.length).toBe(upstreamCount + 1);

    // Per-task events carry task_id; workflow-level events do not.
    const perTaskStarted = mapStarted.filter((e) => e.task_id !== null);
    expect(perTaskStarted).toHaveLength(upstreamCount);

    expect(loadEvents(db, wfId, 'consolidation_reduce_started')).toHaveLength(1);
    expect(loadEvents(db, wfId, 'consolidation_reduce_completed')).toHaveLength(1);
    expect(loadEvents(db, wfId, 'workflow_consolidated')).toHaveLength(1);
  });

  it('(c) MAP failure falls back to placeholder so REDUCE still runs', async () => {
    const wfId = newWorkflowId();
    ids.push(wfId);
    const wf = makeWorkflow(wfId);
    const upstreamCount = 5;
    const tasks = Array.from({ length: upstreamCount }, (_, i) =>
      makeCompletedTask(newTaskId(), wfId, `task ${i}`, `output ${i}`),
    );
    insertWorkflowWithTasks(db, wf, tasks);

    // First map call (task 0) fails both attempts (1 initial + 1 retry).
    // Remaining tasks succeed.
    let task0Calls = 0;
    omnirouteMock.callOmniroute.mockImplementation(async (args: { userPrompt: string }) => {
      const match = /TASK NAME: (task \d+)/.exec(args.userPrompt);
      const name = match?.[1] ?? 'unknown';
      if (name === 'task 0') {
        task0Calls++;
        throw new Error(`boom-${task0Calls}`);
      }
      return `summary-of-${name}`;
    });

    let reducerSawPlaceholder = false;
    const doConsolidate = vi.fn(async (_wf: Workflow, ts: Task[]) => {
      const outputs = ts.filter((t) => t.status === 'completed').map((t) => t.output_json ?? '');
      reducerSawPlaceholder = outputs.some((o) => o.startsWith('[map-step-failed:'));
      return 'final-with-degraded-map';
    });

    await runConsolidation(db, wf, tasks, doConsolidate);

    // task 0 attempted twice (initial + retry); others once each.
    expect(task0Calls).toBe(2);
    expect(omnirouteMock.callOmniroute).toHaveBeenCalledTimes(2 + (upstreamCount - 1));

    // REDUCE still ran and saw the placeholder.
    expect(doConsolidate).toHaveBeenCalledTimes(1);
    expect(reducerSawPlaceholder).toBe(true);

    // workflow-level map_completed payload reports failed_count = 1.
    const workflowLevelCompleted = loadEvents(db, wfId, 'consolidation_map_completed').filter(
      (e) => e.task_id === null,
    );
    expect(workflowLevelCompleted).toHaveLength(1);
    const payload = JSON.parse(workflowLevelCompleted[0]!.payload_json ?? '{}');
    expect(payload.failed_count).toBe(1);
    expect(payload.upstream_count).toBe(upstreamCount);

    expect(loadEvents(db, wfId, 'workflow_consolidated')).toHaveLength(1);
  });
});
