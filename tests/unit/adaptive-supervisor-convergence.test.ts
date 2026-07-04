// W1 convergence detector — tests for the early-exit behaviour added to
// runAdaptiveSupervisor. Mirrors the fixture style of
// `tests/unit/adaptive-supervisor.test.ts` so the two suites can be read
// side-by-side. Each test resets the control registry and creates a fresh
// in-memory DB to avoid cross-talk.
//
// The three required scenarios per the W1 spec:
//   1. Productive iterations → unproductive iterations → early exit at
//      iter N+streak, with `adaptive_supervisor_converged` event emitted.
//   2. Convergence detection disabled via env → loop runs to the full cap.
//   3. Sanity: DEFAULT_MAX_ITERATIONS = 25 (observable via the public
//      contract — running an always-CONTINUE task without overriding
//      maxIterations yields exactly 25 iterations + a converged break,
//      OR — because convergence fires at iter 2 — yields 2 iterations.
//      So we exercise both the cap and the convergence in isolation).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import type { Task } from '../../src/types/index.js';
import {
  runAdaptiveSupervisor,
  DEFAULT_MAX_ITERATIONS,
} from '../../src/brain/executor/adaptive-supervisor.js';
import type {
  ExecuteAdaptiveTurnFn,
} from '../../src/brain/executor/adaptive-supervisor.types.js';
import { _resetControlRegistry } from '../../src/v2/subagent/control.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTask(id: string, wfId: string, name: string, timeoutSeconds = 30): Task {
  return {
    id,
    workflow_id: wfId,
    name,
    kind: 'llm_call',
    input_json: JSON.stringify({ objective: `do ${name}` }),
    output_json: null,
    status: 'running',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: timeoutSeconds,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: Date.now(),
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

interface TestFixture {
  workflowId: string;
  tasks: Task[];
}

function setupWorkflow(db: Database.Database, taskCount: number): TestFixture {
  const workflowId = `wf_test_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, 'internal', 'test objective', 'executing', ?)`,
  ).run(workflowId, now);

  const tasks: Task[] = [];
  for (let i = 0; i < taskCount; i++) {
    const taskId = `tk_test_${i}_${Math.random().toString(36).slice(2, 8)}`;
    const name = `task ${i}`;
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, status, depends_on_json,
          timeout_seconds, max_retries, retry_count, retry_policy,
          refine_count, max_refine, hitl, created_at, input_json)
       VALUES (?, ?, ?, 'llm_call', 'running', '[]',
               30, 0, 0, 'none', 0, 0, 0, ?, ?)`,
    ).run(taskId, workflowId, name, now, JSON.stringify({ objective: `do ${name}` }));

    tasks.push(makeTask(taskId, workflowId, name));
  }

  return { workflowId, tasks };
}

function selectConvergedEvents(db: Database.Database, workflowId: string): Array<{
  type: string;
  payload_json: string;
}> {
  return db
    .prepare(
      `SELECT type, payload_json FROM events
       WHERE workflow_id = ? AND type = 'adaptive_supervisor_converged'
       ORDER BY id`,
    )
    .all(workflowId) as Array<{ type: string; payload_json: string }>;
}

// ─── Test 1 — productive then unproductive → converged break ─────────────────

describe('runAdaptiveSupervisor — W1 convergence (early exit on no progress)', () => {
  let db: Database.Database;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    delete process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE']; // default = enabled
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    } else {
      process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'] = savedEnv;
    }
  });

  it('exits early when two consecutive iterations produce no completions', async () => {
    // Two tasks so the alive set stays > 0 even while one of them is
    // emitting CONTINUE; otherwise the alive-empty exit-condition would
    // pre-empt the convergence detector.
    const { workflowId, tasks } = setupWorkflow(db, 2);
    const [taskA, taskB] = tasks;

    // Productive iterations 1-7: each task emits 3 alternating CONTINUE
    // turns then a series of unproductive CONTINUE turns. To keep this
    // assertion stable, we use a simpler script: BOTH tasks always emit
    // CONTINUE — i.e. iteration 1 does no completions (alive stays 2),
    // iteration 2 also does no completions (alive stays 2). Streak hits
    // CONVERGENCE_STREAK_THRESHOLD (= 2) at iter 2, so the loop breaks
    // and `result.iterations === 2`.
    //
    // We do NOT use the maxIterations override so the test also confirms
    // the new default cap (25) is in effect — convergence fires long
    // before the cap.
    const stub: ExecuteAdaptiveTurnFn = async () => 'still thinking [[SUBAGENT_CONTINUE]]';

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    // Convergence fired at iteration 2 — well before DEFAULT_MAX_ITERATIONS (25).
    expect(result.iterations).toBe(2);
    expect(result.iterations).toBeLessThan(DEFAULT_MAX_ITERATIONS);

    // Both tasks landed in the Phase 3 cleanup path with a timeout outcome —
    // the supervisor declared them unfinished when it broke out of the loop.
    expect(result.outcomes.get(taskA.id)?.status).toBe('timeout');
    expect(result.outcomes.get(taskB.id)?.status).toBe('timeout');

    // Exactly one adaptive_supervisor_converged event was persisted.
    const events = selectConvergedEvents(db, workflowId);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload_json) as {
      iteration: number;
      alive: number;
      streak: number;
      reason: string;
    };
    expect(payload.iteration).toBe(2);
    expect(payload.streak).toBe(2);
    expect(payload.alive).toBe(2);
    expect(payload.reason).toBe('no_progress');
  });

  it('resets the streak after a productive iteration', async () => {
    // Subagent emits CONTINUE for turns 1-2, COMPLETE for turn 3, then we
    // expect: iter 1 = no progress (streak=1), iter 2 = no progress (streak=2)
    // → would converge, BUT this test is about NOT converging when progress
    // happens just in time. So we tighten the script: CONTINUE on iter 1
    // (streak=1), COMPLETE on iter 2 (alive shrinks → streak resets).
    // The loop should exit because alive.size === 0, NOT due to convergence.
    const { workflowId, tasks } = setupWorkflow(db, 1);
    let turn = 0;
    const stub: ExecuteAdaptiveTurnFn = async () => {
      turn += 1;
      if (turn === 1) return 'phase 1 [[SUBAGENT_CONTINUE]]';
      return '[[SUBAGENT_COMPLETE]]\nfinal';
    };

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    expect(result.iterations).toBe(2);
    expect(result.outcomes.get(tasks[0].id)?.status).toBe('ok');
    const events = selectConvergedEvents(db, workflowId);
    expect(events).toHaveLength(0);
  });
});

// ─── Test 1b — multi-agent precondition: single-agent does NOT early-exit ────

describe('runAdaptiveSupervisor — W1 convergence multi-agent precondition', () => {
  let db: Database.Database;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    delete process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE']; // default = enabled
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    } else {
      process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'] = savedEnv;
    }
  });

  it('does NOT converge a single-agent always-CONTINUE workflow (alive < 2 precondition)', async () => {
    // Regression guard for the supervisor-coordination scope: when only one
    // subagent is alive, the convergence detector must NOT early-exit. The
    // single agent is responsible for its own progress; the multi-agent
    // "stuck waiting for peer" heuristic doesn't apply. Behavior contract
    // documented in adaptive-supervisor.ts:566-569.
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const stub: ExecuteAdaptiveTurnFn = async () => 'forever-thinking [[SUBAGENT_CONTINUE]]';

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      maxIterations: 5, // small cap so test stays fast
      executeTurnFn: stub,
    });

    // Loop ran to the maxIterations cap (5) instead of converging at iter 2.
    expect(result.iterations).toBe(5);
    expect(result.outcomes.get(tasks[0].id)?.status).toBe('timeout');

    // No convergence event emitted — precondition was not met.
    const events = selectConvergedEvents(db, workflowId);
    expect(events).toHaveLength(0);
  });

  it('streak resets when one of two tasks completes mid-loop (alive shrinks)', async () => {
    // Setup: 2 tasks. Task A always CONTINUEs. Task B CONTINUEs once then
    // COMPLETEs. Expected timeline:
    //   iter 1: both CONTINUE — alive stays at 2, no completions → streak = 1
    //   iter 2: A CONTINUEs, B COMPLETEs — alive shrinks to 1 → streak resets
    //   iter 3+: alive=1, precondition not met → streak stays 0, runs to cap
    // Convergence MUST NOT fire even though iter 1 was an unproductive
    // multi-agent iteration. The streak resets specifically because outcomes
    // grew (B completed). Loop exits via maxIterations, not convergence.
    const { workflowId, tasks } = setupWorkflow(db, 2);
    const [taskA, taskB] = tasks;
    const turns = new Map<string, number>();
    const stub: ExecuteAdaptiveTurnFn = async (task) => {
      const n = (turns.get(task.id) ?? 0) + 1;
      turns.set(task.id, n);
      if (task.id === taskB.id && n === 2) return '[[SUBAGENT_COMPLETE]]\ndone-b';
      return 'continue [[SUBAGENT_CONTINUE]]';
    };

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      maxIterations: 4,
      executeTurnFn: stub,
    });

    // No convergence — streak was reset on iter 2 (B completed), and from
    // iter 3 onward alive=1 so precondition fails. Loop exits via cap.
    const events = selectConvergedEvents(db, workflowId);
    expect(events).toHaveLength(0);
    expect(result.iterations).toBe(4);
    // B completed with 'ok'; A timed out at cleanup.
    expect(result.outcomes.get(taskB.id)?.status).toBe('ok');
    expect(result.outcomes.get(taskA.id)?.status).toBe('timeout');
  });
});

// ─── Test 2 — env disable flag honored ────────────────────────────────────────

describe('runAdaptiveSupervisor — W1 convergence disable knob', () => {
  let db: Database.Database;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'] = 'false';
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    } else {
      process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'] = savedEnv;
    }
  });

  it('does NOT exit early; runs to the provided maxIterations cap', async () => {
    // With convergence disabled, an always-CONTINUE task should hit the
    // explicit maxIterations cap (we use a small cap = 4 to keep the test
    // fast — the cap-25 default is exercised separately in Test 3).
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const stub: ExecuteAdaptiveTurnFn = async () => 'spinning [[SUBAGENT_CONTINUE]]';

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      maxIterations: 4,
      executeTurnFn: stub,
    });

    // Loop ran to the cap (4) instead of converging at iter 2.
    expect(result.iterations).toBe(4);
    expect(result.outcomes.get(tasks[0].id)?.status).toBe('timeout');

    // No convergence event emitted.
    const events = selectConvergedEvents(db, workflowId);
    expect(events).toHaveLength(0);
  });
});

// ─── Test 3 — DEFAULT_MAX_ITERATIONS sanity ───────────────────────────────────

describe('runAdaptiveSupervisor — W1 default cap raised to 25', () => {
  let db: Database.Database;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    // Disable convergence so we can observe the unobstructed cap.
    process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'] = 'false';
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'];
    } else {
      process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'] = savedEnv;
    }
  });

  it('exposes DEFAULT_MAX_ITERATIONS === 25 as the documented baseline', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(25);
  });

  it('uses DEFAULT_MAX_ITERATIONS when opts.maxIterations is undefined', async () => {
    // Convergence disabled (afterEach restores env). An always-CONTINUE
    // task should run for exactly DEFAULT_MAX_ITERATIONS iterations.
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const stub: ExecuteAdaptiveTurnFn = async () => 'never done [[SUBAGENT_CONTINUE]]';

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    expect(result.iterations).toBe(DEFAULT_MAX_ITERATIONS);
    expect(result.outcomes.get(tasks[0].id)?.status).toBe('timeout');
  });
});
