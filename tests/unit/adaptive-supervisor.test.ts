import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import type { Task } from '../../src/types/index.js';
import {
  runAdaptiveSupervisor,
  parseSubagentSignal,
} from '../../src/brain/executor/adaptive-supervisor.js';
import type {
  ExecuteAdaptiveTurnFn,
  SubagentEvent,
} from '../../src/brain/executor/adaptive-supervisor.types.js';
import {
  registerSubagentRun,
  countActiveDescendants,
  listRunsForTask,
  listRunsForWorkflow,
} from '../../src/v2/subagent/registry.js';
import {
  newSubagentRunId,
  DEFAULT_MAX_CHILDREN,
  type SubagentRunRow,
} from '../../src/v2/subagent/types.js';
import { kill, _resetControlRegistry } from '../../src/v2/subagent/control.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

interface TestFixture {
  workflowId: string;
  tasks: Task[];
}

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

function captureEvents(): {
  events: SubagentEvent[];
  hook: (e: SubagentEvent) => void;
} {
  const events: SubagentEvent[] = [];
  return {
    events,
    hook: (e: SubagentEvent) => {
      events.push(e);
    },
  };
}

// ─── parseSubagentSignal — pure tests ─────────────────────────────────────────

describe('parseSubagentSignal', () => {
  it('treats no marker as complete with full body as result', () => {
    const out = parseSubagentSignal('hello world');
    expect(out.final).toBe('complete');
    expect(out.result).toBe('hello world');
    expect(out.announcements).toHaveLength(0);
  });

  it('parses [[SUBAGENT_COMPLETE]]\\n<body>', () => {
    const out = parseSubagentSignal('intro text\n[[SUBAGENT_COMPLETE]]\nfinal-result');
    expect(out.final).toBe('complete');
    expect(out.result).toBe('final-result');
  });

  it('parses [[SUBAGENT_CONTINUE]] and discards the body', () => {
    const out = parseSubagentSignal('scratch work [[SUBAGENT_CONTINUE]]');
    expect(out.final).toBe('continue');
    expect(out.result).toBe('');
  });

  it('extracts every announcement and strips them from the residual', () => {
    const input =
      'preamble\n' +
      '[[SUBAGENT_ANNOUNCE topic="A" summary="found A"]]\n' +
      'middle\n' +
      '[[SUBAGENT_ANNOUNCE topic="B" summary="found B"]]\n' +
      '[[SUBAGENT_COMPLETE]]\nresult';
    const out = parseSubagentSignal(input);
    expect(out.announcements).toEqual([
      { topic: 'A', summary: 'found A' },
      { topic: 'B', summary: 'found B' },
    ]);
    expect(out.final).toBe('complete');
    expect(out.result).toBe('result');
  });

  it('continue beats complete when both present', () => {
    const out = parseSubagentSignal('[[SUBAGENT_COMPLETE]]\nx\n[[SUBAGENT_CONTINUE]]');
    expect(out.final).toBe('continue');
  });
});

// ─── runAdaptiveSupervisor — happy path single task ───────────────────────────

describe('runAdaptiveSupervisor — single task happy path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('spawns, runs 1 turn, treats output as complete (no marker)', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const stub: ExecuteAdaptiveTurnFn = async () => 'just the result';

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    expect(result.iterations).toBe(1);
    const outcome = result.outcomes.get(tasks[0].id);
    expect(outcome).toBeDefined();
    expect(outcome?.status).toBe('ok');
    expect(outcome?.resultText).toBe('just the result');

    // Persisted state: the run row exists and is complete.
    const runs = listRunsForTask(db, tasks[0].id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('complete');
    expect(runs[0].result_text).toBe('just the result');
  });
});

// ─── multi-task happy path ────────────────────────────────────────────────────

describe('runAdaptiveSupervisor — multi-task', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('runs 2 tasks in parallel iterations, both complete in 1 turn', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 2);

    const stub: ExecuteAdaptiveTurnFn = async (task) =>
      `[[SUBAGENT_COMPLETE]]\nresult of ${task.name}`;

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    expect(result.iterations).toBe(1);
    expect(result.outcomes.size).toBe(2);
    for (const t of tasks) {
      const outcome = result.outcomes.get(t.id);
      expect(outcome?.status).toBe('ok');
      expect(outcome?.resultText).toBe(`result of ${t.name}`);
    }
  });
});

// ─── announce + receive cross-talk ────────────────────────────────────────────

describe('runAdaptiveSupervisor — announce-and-receive', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('task B sees fenced announcement from task A on the next iteration', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 2);
    const [taskA, taskB] = tasks;

    // Per-task call recorder so we can assert on B's fenced array.
    const calls: Array<{ taskId: string; fenced: string[] }> = [];
    let aTurn = 0;
    let bTurn = 0;

    const stub: ExecuteAdaptiveTurnFn = async (task, fenced) => {
      calls.push({ taskId: task.id, fenced: [...fenced] });

      if (task.id === taskA.id) {
        aTurn++;
        if (aTurn === 1) {
          // Announce, then ask for another turn so we don't terminate
          // before B runs.
          return (
            'info\n' +
            '[[SUBAGENT_ANNOUNCE topic="x" summary="y"]]\n' +
            '[[SUBAGENT_CONTINUE]]'
          );
        }
        return '[[SUBAGENT_COMPLETE]]\nA done';
      }

      // Task B
      bTurn++;
      return '[[SUBAGENT_COMPLETE]]\nB done';
    };

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    expect(result.outcomes.get(taskA.id)?.status).toBe('ok');
    expect(result.outcomes.get(taskB.id)?.status).toBe('ok');

    // First iteration order: A turn 1 (no inbox), then B turn 1 (sees A's
    // freshly-broadcast announcement in its fenced array).
    const aFirstCall = calls.find((c) => c.taskId === taskA.id);
    expect(aFirstCall?.fenced).toEqual([]);

    const bFirstCall = calls.find((c) => c.taskId === taskB.id);
    expect(bFirstCall?.fenced.length).toBe(1);
    expect(bFirstCall?.fenced[0]).toContain('<subagent-message');
    // Body is entity-encoded; "found" or summary "y" must be present.
    expect(bFirstCall?.fenced[0]).toContain('y');
  });
});

// ─── continue marker ──────────────────────────────────────────────────────────

describe('runAdaptiveSupervisor — continue marker drives multiple iterations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('explicit CONTINUE for 3 turns then COMPLETE', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 1);
    let turn = 0;
    const stub: ExecuteAdaptiveTurnFn = async () => {
      turn++;
      if (turn < 4) return `working... [[SUBAGENT_CONTINUE]]`;
      return '[[SUBAGENT_COMPLETE]]\nfinal';
    };

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    const outcome = result.outcomes.get(tasks[0].id);
    expect(outcome?.status).toBe('ok');
    expect(outcome?.resultText).toBe('final');
    // 3 continues + 1 complete = 4 iterations
    expect(result.iterations).toBeGreaterThanOrEqual(4);
  });
});

// ─── max iterations cap ───────────────────────────────────────────────────────

describe('runAdaptiveSupervisor — max iterations cap', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('always-CONTINUE task is timed out at maxIterations', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const stub: ExecuteAdaptiveTurnFn = async () => 'never done [[SUBAGENT_CONTINUE]]';

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      maxIterations: 2,
      executeTurnFn: stub,
    });

    expect(result.iterations).toBe(2);
    const outcome = result.outcomes.get(tasks[0].id);
    expect(outcome?.status).toBe('timeout');
    expect(outcome?.errorMsg).toMatch(/max iterations/i);
  });
});

// ─── failed spawn ─────────────────────────────────────────────────────────────

describe('runAdaptiveSupervisor — failed spawn does not block siblings', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('task with overflowing child slots gets error outcome; sibling proceeds', async () => {
    // We can't easily make spawnSubagent reject for a top-level task because
    // there is no parentRunId, so depth/maxChildren guards don't trip.
    // Instead, we exercise the spawn-error branch via FK violation on a
    // synthetic "ghost" task — give it an id but DO NOT insert a row in
    // tasks. spawnSubagent then hits the FK guard inside registerSubagentRun
    // and returns {status: 'error'}.
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const ghost = makeTask('tk_ghost_no_row', workflowId, 'ghost task');

    const stub: ExecuteAdaptiveTurnFn = async (task) =>
      `[[SUBAGENT_COMPLETE]]\nok ${task.name}`;

    // Order matters: ghost is first, then a real task. Supervisor must
    // record ghost's failure but still drive the real task to completion.
    const result = await runAdaptiveSupervisor(db, [ghost, ...tasks], {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    const ghostOutcome = result.outcomes.get(ghost.id);
    expect(ghostOutcome?.status).toBe('error');
    expect(ghostOutcome?.errorMsg).toBeDefined();

    const realOutcome = result.outcomes.get(tasks[0].id);
    expect(realOutcome?.status).toBe('ok');
    expect(realOutcome?.resultText).toBe(`ok ${tasks[0].name}`);
  });
});

// ─── executeTurnFn throws ─────────────────────────────────────────────────────

describe('runAdaptiveSupervisor — turn-level errors are isolated', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('one task throws, the other completes normally', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 2);
    const [taskA, taskB] = tasks;

    const stub: ExecuteAdaptiveTurnFn = async (task) => {
      if (task.id === taskA.id) {
        throw new Error('boom');
      }
      return '[[SUBAGENT_COMPLETE]]\nB ok';
    };

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    const outcomeA = result.outcomes.get(taskA.id);
    expect(outcomeA?.status).toBe('error');
    expect(outcomeA?.errorMsg).toContain('boom');

    const outcomeB = result.outcomes.get(taskB.id);
    expect(outcomeB?.status).toBe('ok');
    expect(outcomeB?.resultText).toBe('B ok');

    // Persisted: A's run row is 'error', B's is 'complete'.
    const allRuns = listRunsForWorkflow(db, workflowId);
    const aRun = allRuns.find((r) => r.task_id === taskA.id);
    const bRun = allRuns.find((r) => r.task_id === taskB.id);
    expect(aRun?.status).toBe('error');
    expect(aRun?.error_msg).toContain('boom');
    expect(bRun?.status).toBe('complete');
  });
});

// ─── abort signal via kill() ──────────────────────────────────────────────────

describe('runAdaptiveSupervisor — abort signal honored by kill()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('kill() during a long-running turn aborts the executor', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const [task] = tasks;

    // Stub turn that waits for the abort signal; throws on abort.
    const stub: ExecuteAdaptiveTurnFn = async (_t, _fenced, signal) => {
      // Schedule a kill during this turn.
      setTimeout(() => {
        kill(db, task.id, 'killed-by-test');
      }, 5);

      return await new Promise<string>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    };

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    const outcome = result.outcomes.get(task.id);
    expect(outcome?.status).toBe('error');
    expect(outcome?.errorMsg).toMatch(/abort/i);
  });
});

// ─── event sequencing ─────────────────────────────────────────────────────────

describe('runAdaptiveSupervisor — event sequence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('emits spawned×N first, then iteration + completed events', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 2);
    const { events, hook } = captureEvents();

    const stub: ExecuteAdaptiveTurnFn = async (task) =>
      `[[SUBAGENT_COMPLETE]]\n${task.name} done`;

    await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
      onSubagentEvent: hook,
    });

    // First two events: subagent_spawned for each task (in input order).
    expect(events[0].type).toBe('subagent_spawned');
    expect(events[1].type).toBe('subagent_spawned');

    // Then exactly one supervisor_iteration event for iteration 1.
    const iterationEvents = events.filter((e) => e.type === 'supervisor_iteration');
    expect(iterationEvents).toHaveLength(1);
    if (iterationEvents[0].type === 'supervisor_iteration') {
      expect(iterationEvents[0].iteration).toBe(1);
      expect(iterationEvents[0].alive).toBe(2);
    }

    // Then two subagent_completed events.
    const completedEvents = events.filter((e) => e.type === 'subagent_completed');
    expect(completedEvents).toHaveLength(2);
    for (const evt of completedEvents) {
      if (evt.type === 'subagent_completed') {
        expect(evt.payload.status).toBe('ok');
      }
    }

    // Sanity on order: every spawned comes before any completed.
    const lastSpawnedIdx = events.findIndex(
      (e, i) => e.type === 'subagent_spawned' && events.slice(i + 1).every((x) => x.type !== 'subagent_spawned'),
    );
    const firstCompletedIdx = events.findIndex((e) => e.type === 'subagent_completed');
    expect(lastSpawnedIdx).toBeLessThan(firstCompletedIdx);
  });
});

// ─── Bonus — onSubagentEvent failure does not crash supervisor ────────────────

describe('runAdaptiveSupervisor — observer hook is best-effort', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('a throwing onSubagentEvent does not abort the loop', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const stub: ExecuteAdaptiveTurnFn = async () => '[[SUBAGENT_COMPLETE]]\nok';

    const result = await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
      onSubagentEvent: () => {
        throw new Error('observer crashed');
      },
    });

    expect(result.outcomes.get(tasks[0].id)?.status).toBe('ok');
  });
});

// ─── Sanity: events table reflects supervisor activity ────────────────────────

describe('runAdaptiveSupervisor — events table writes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('persists subagent_spawned, supervisor_iteration, subagent_completed', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 1);
    const stub: ExecuteAdaptiveTurnFn = async () => '[[SUBAGENT_COMPLETE]]\nfin';

    await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    const eventTypes = db
      .prepare(`SELECT type FROM events WHERE workflow_id = ? ORDER BY id`)
      .all(workflowId) as Array<{ type: string }>;
    const types = eventTypes.map((e) => e.type);

    expect(types).toContain('subagent_spawned');
    expect(types).toContain('supervisor_iteration');
    expect(types).toContain('subagent_completed');
  });
});

// ─── Sanity: descendants accounting via spawn ─────────────────────────────────

describe('runAdaptiveSupervisor — registry side-effects', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    _resetControlRegistry();
  });

  it('every adaptive task gets exactly one subagent_runs row', async () => {
    const { workflowId, tasks } = setupWorkflow(db, 3);
    const stub: ExecuteAdaptiveTurnFn = async () => '[[SUBAGENT_COMPLETE]]\nok';

    await runAdaptiveSupervisor(db, tasks, {
      workflowId,
      workspace: 'internal',
      executeTurnFn: stub,
    });

    const allRuns: SubagentRunRow[] = listRunsForWorkflow(db, workflowId);
    expect(allRuns).toHaveLength(3);
    for (const r of allRuns) {
      expect(r.status).toBe('complete');
    }
  });
});

// Avoid unused-import lint when only types are referenced
void countActiveDescendants;
void registerSubagentRun;
void newSubagentRunId;
void DEFAULT_MAX_CHILDREN;
