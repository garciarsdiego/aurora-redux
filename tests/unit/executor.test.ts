import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow, continueWorkflowExecution, runTaskLoop } from '../../src/brain/executor.js';
import { buildWorkflowDebugLog } from '../../src/db/workflow-debug-log.js';
import { recordWorkflowCliPermissionMode } from '../../src/db/workflow-cli-permission.js';
import { isCliSafeMode } from '../../src/executors/cli.js';
import {
  newWorkflowId,
  newTaskId,
  insertWorkflow,
  insertTask,
  setTaskCompleted,
  setTaskFailed,
  findExecutingWorkflow,
} from '../../src/db/persist.js';
import type { Dag, Workflow, Task } from '../../src/types/index.js';
import type { ExecuteAdaptiveTurnFn } from '../../src/brain/executor/adaptive-supervisor.types.js';

// Shared mocks for tests that don't care about concrete LLM output.
// Avoids real Omniroute calls in suites that only verify execution/retry/review.
const stubConsolidate = async (): Promise<string> => 'stub consolidated output';
const stubExecute = async (task: Task): Promise<string> => `stub output for ${task.name}`;

// Live-Omniroute hygiene (file-wide). Several suites here drive *retryable*
// failures (retry policies, timeout retry escalation, parallel-task failure)
// through runTaskLoop. With personas ON (the default) a non-transient failure
// triggers a real failover-classifier LLM call to the configured OMNIROUTE_URL.
// In this repo's .env that's a live LAN box, so each such test hangs to its
// timeout whenever the host is slow/unreachable. Pin personas OFF and point
// OMNIROUTE_URL at a dead local port so any stray call fails fast instead of
// hanging. The legacy retry/escalation assertions are emitted regardless of the
// persona layer, so they are unaffected. Save+restore the originals so we don't
// leak env into sibling test files.
const _savedUsePersonas = process.env.OMNIFORGE_USE_PERSONAS;
const _savedOmnirouteUrl = process.env.OMNIROUTE_URL;
const _savedDisableFinalValidation = process.env.DISABLE_FINAL_VALIDATION;
beforeEach(() => {
  process.env.OMNIFORGE_USE_PERSONAS = 'false';
  process.env.OMNIROUTE_URL = 'http://127.0.0.1:1';
  process.env.DISABLE_FINAL_VALIDATION = 'true';
});
afterEach(() => {
  if (_savedUsePersonas === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
  else process.env.OMNIFORGE_USE_PERSONAS = _savedUsePersonas;
  if (_savedOmnirouteUrl === undefined) delete process.env.OMNIROUTE_URL;
  else process.env.OMNIROUTE_URL = _savedOmnirouteUrl;
  if (_savedDisableFinalValidation === undefined) delete process.env.DISABLE_FINAL_VALIDATION;
  else process.env.DISABLE_FINAL_VALIDATION = _savedDisableFinalValidation;
});

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n') || `git ${args.join(' ')} failed`);
  }
}

// Helper: builds a minimal Task for retry tests
function makeTask(
  id: string,
  wfId: string,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    workflow_id: wfId,
    name: 'Test Task',
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
    ...overrides,
  };
}

describe('executeWorkflow', () => {
  it('injects the planned DAG into execution-plan review tasks', async () => {
    const db = initDb(':memory:');
    const seenInputs: Record<string, unknown>[] = [];

    const dag: Dag = {
      tasks: [
        {
          id: 't0',
          name: 'Review execution plan',
          kind: 'llm_call',
          depends_on: [],
          acceptance_criteria: 'Plan lists all subsequent tasks with their kinds and deliverables',
        },
        {
          id: 't1',
          name: 'Scaffold project',
          kind: 'cli_spawn',
          depends_on: ['t0'],
          acceptance_criteria: 'package.json exists and npm run build exits 0',
        },
        {
          id: 't2',
          name: 'Create task modal',
          kind: 'cli_spawn',
          depends_on: ['t1'],
          acceptance_criteria: 'src/components/TaskModal.tsx exists',
        },
      ],
    };

    await executeWorkflow(db, dag, 'internal', 'build app', {
      consolidateFn: stubConsolidate,
      executeTaskFn: async (task) => {
        if (task.name === 'Review execution plan') {
          seenInputs.push(JSON.parse(task.input_json ?? '{}') as Record<string, unknown>);
        }
        return `stub output for ${task.name}`;
      },
      reviewFn: async () => ({ score: 1, feedback: 'ok', passed: true }),
    });

    expect(seenInputs).toHaveLength(1);
    expect(seenInputs[0]).toMatchObject({
      execution_plan: {
        current_task_id: 't0',
        tasks: [
          expect.objectContaining({ id: 't0', name: 'Review execution plan', kind: 'llm_call' }),
          expect.objectContaining({ id: 't1', name: 'Scaffold project', kind: 'cli_spawn' }),
          expect.objectContaining({ id: 't2', name: 'Create task modal', kind: 'cli_spawn' }),
        ],
      },
    });

    db.close();
  });

  it('records context orchestration packets and handoffs during task execution', async () => {
    const db = initDb(':memory:');
    const secret = 'sk-context-runtime-secret-value';

    const dag: Dag = {
      tasks: [
        {
          id: 'a',
          name: 'Context captured task',
          kind: 'llm_call',
          depends_on: [],
          model: 'cx/gpt-5.4',
        },
      ],
    };

    const wf = await executeWorkflow(db, dag, 'internal', 'context capture test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: async () => `completed with ${secret}`,
      reviewFn: async () => ({ score: 1, feedback: 'ok', passed: true }),
    });

    const log = buildWorkflowDebugLog(db, wf.id);
    const serialized = JSON.stringify(log);

    expect(log.context_orchestration.channels).toHaveLength(1);
    expect(log.context_orchestration.threads).toHaveLength(1);
    expect(log.context_orchestration.context_packets).toHaveLength(1);
    expect(log.context_orchestration.task_handoffs).toHaveLength(1);
    expect(log.context_orchestration.work_items).toHaveLength(2);
    expect(log.context_orchestration.messages.map((message) => message.kind)).toEqual(
      expect.arrayContaining(['event', 'context_packet', 'handoff']),
    );
    expect(serialized).not.toContain(secret);

    db.close();
  });

  it('executes a linear 3-node DAG: all tasks completed, ≥8 events, correct order', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: ['a'] },
        { id: 'c', name: 'Task C', kind: 'llm_call', depends_on: ['b'] },
      ],
    };

    const wf = await executeWorkflow(db, dag, 'internal', 'linear test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(wf.status).toBe('completed');

    const tasks = db
      .prepare('SELECT status FROM tasks WHERE workflow_id = ?')
      .all(wf.id) as { status: string }[];
    expect(tasks).toHaveLength(3);
    expect(tasks.every((t) => t.status === 'completed')).toBe(true);

    const events = db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(wf.id) as { type: string }[];

    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(events.at(0)!.type).toBe('workflow_started');
    expect(events.at(-1)!.type).toBe('workflow_completed');

    const count = (type: string) => events.filter((e) => e.type === type).length;
    expect(count('task_started')).toBe(3);
    expect(count('task_completed')).toBe(3);

    const spans = db
      .prepare("SELECT name, kind, status FROM trace_spans WHERE workflow_id = ? ORDER BY started_at")
      .all(wf.id) as Array<{ name: string; kind: string; status: string }>;
    expect(spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Task A', kind: 'task', status: 'ok' }),
    ]));

    db.close();
  });

  it('fan-in DAG: final task executes only after both predecessors complete', async () => {
    const db = initDb(':memory:');

    // a and b have no deps; c depends on both (convergence)
    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: [] },
        { id: 'c', name: 'Task C', kind: 'llm_call', depends_on: ['a', 'b'] },
      ],
    };

    const wf = await executeWorkflow(db, dag, 'internal', '', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(wf.status).toBe('completed');

    // Use event insertion order (auto-increment id) as execution order proof
    const taskEvents = db
      .prepare(
        `SELECT e.type, t.name
         FROM events e
         INNER JOIN tasks t ON e.task_id = t.id
         WHERE e.workflow_id = ? AND e.task_id IS NOT NULL
         ORDER BY e.id`,
      )
      .all(wf.id) as { type: string; name: string }[];

    const idx = (name: string, type: string) =>
      taskEvents.findIndex((e) => e.name === name && e.type === type);

    const cStartIdx = idx('Task C', 'task_started');
    const aComplIdx = idx('Task A', 'task_completed');
    const bComplIdx = idx('Task B', 'task_completed');

    expect(cStartIdx).toBeGreaterThan(aComplIdx);
    expect(cStartIdx).toBeGreaterThan(bComplIdx);

    db.close();
  });

  it('stops before the next llm_call when workflow model budget is exhausted', async () => {
    const previousBudget = process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '0.05';
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Paid model call', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Should not execute', kind: 'llm_call', depends_on: ['a'] },
      ],
    };
    const calls: string[] = [];
    const executeFn = async (task: Task): Promise<string> => {
      calls.push(task.name);
      task.model_used = 'test/model';
      task.llm_call_cost_usd = 0.07;
      return `output for ${task.name}`;
    };

    await expect(
      executeWorkflow(db, dag, 'internal', 'budget test', {
        consolidateFn: stubConsolidate,
        executeTaskFn: executeFn,
        costReportFn: async () => ({ ok: true, data: { total_usd: 0, by_task: [] } }),
      }),
    ).rejects.toThrow(/budget/i);

    expect(calls).toEqual(['Paid model call']);
    const events = db
      .prepare('SELECT type FROM events ORDER BY id')
      .all() as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toContain('workflow_budget_exceeded');
    db.close();
    if (previousBudget === undefined) delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    else process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = previousBudget;
  });
});

describe('consolidator', () => {
  it('workflow with 3 tasks → consolidator called with completed tasks, output saved to metadata, workflow_consolidated emitted', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: [] },
        { id: 'c', name: 'Task C', kind: 'llm_call', depends_on: ['a', 'b'] },
      ],
    };

    let consolidatorCalls = 0;
    let receivedTaskCount = 0;
    const mockConsolidate = async (_wf: Workflow, tasks: Task[]): Promise<string> => {
      consolidatorCalls++;
      receivedTaskCount = tasks.filter((t) => t.status === 'completed').length;
      return 'Final synthesized deliverable';
    };

    const wf = await executeWorkflow(db, dag, 'internal', 'build something', {
      consolidateFn: mockConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(wf.status).toBe('completed');
    expect(consolidatorCalls).toBe(1);
    expect(receivedTaskCount).toBe(3);

    const wfRow = db.prepare('SELECT metadata FROM workflows WHERE id = ?')
      .get(wf.id) as { metadata: string };
    expect(wfRow.metadata).toBeTruthy();
    const meta = JSON.parse(wfRow.metadata) as { consolidated_output: string };
    expect(meta.consolidated_output).toBe('Final synthesized deliverable');

    const events = db.prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(wf.id) as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_consolidated');
    expect(types).not.toContain('workflow_consolidation_error');

    // workflow_consolidated must come before workflow_completed
    const consolidatedIdx = types.indexOf('workflow_consolidated');
    const completedIdx = types.indexOf('workflow_completed');
    expect(consolidatedIdx).toBeLessThan(completedIdx);

    const consolidatedEvent = db
      .prepare(`SELECT payload_json FROM events WHERE workflow_id = ? AND type = 'workflow_consolidated'`)
      .get(wf.id) as { payload_json: string };
    const payload = JSON.parse(consolidatedEvent.payload_json) as { output_length: number };
    expect(payload.output_length).toBe('Final synthesized deliverable'.length);

    db.close();
  });

  it('consolidator throws → workflow still completes, workflow_consolidation_error emitted, no consolidated_output in metadata', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: [] },
      ],
    };

    const throwingConsolidate = async (): Promise<string> => {
      throw new Error('omniroute down');
    };

    const wf = await executeWorkflow(db, dag, 'internal', 'test objective', {
      consolidateFn: throwingConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(wf.status).toBe('completed');

    const wfRow = db.prepare('SELECT status, metadata FROM workflows WHERE id = ?')
      .get(wf.id) as { status: string; metadata: string | null };
    expect(wfRow.status).toBe('completed');
    // Tier 0 Wave 4 (0.10) — the v2 validator step now always writes a
    // `validation` summary on metadata BEFORE the consolidator runs. When
    // the consolidator throws, that prior write survives but no
    // `consolidated_output` field is added.
    const meta = wfRow.metadata ? (JSON.parse(wfRow.metadata) as Record<string, unknown>) : {};
    expect(meta).not.toHaveProperty('consolidated_output');

    const events = db.prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(wf.id) as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain('workflow_consolidation_error');
    expect(types).not.toContain('workflow_consolidated');
    expect(types).toContain('workflow_completed'); // still completes

    const errEvent = db
      .prepare(`SELECT payload_json FROM events WHERE workflow_id = ? AND type = 'workflow_consolidation_error'`)
      .get(wf.id) as { payload_json: string };
    const payload = JSON.parse(errEvent.payload_json) as { error: string };
    expect(payload.error).toContain('omniroute down');

    db.close();
  });
});

describe('continueWorkflowExecution', () => {
  it('skips completed tasks and only executes pending ones', async () => {
    const db = initDb(':memory:');
    const now = Date.now();

    // Set up DB state simulating crash after task A completed
    const wfId = newWorkflowId();
    const aId = newTaskId();
    const bId = newTaskId();
    const cId = newTaskId();

    const workflow: Workflow = {
      id: wfId,
      workspace: 'test',
      objective: 'resume test',
      pattern_id: null,
      status: 'executing',
      started_at: now,
      completed_at: null,
      created_at: now,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    };
    insertWorkflow(db, workflow);

    const baseTask = (id: string, name: string, deps: string[]): Task => ({
      id,
      workflow_id: wfId,
      name,
      kind: 'llm_call',
      input_json: null,
      output_json: null,
      status: 'pending',
      depends_on: deps,
      executor_hint: null,
      timeout_seconds: 300,
      max_retries: 3,
      retry_count: 0,
      retry_policy: 'exponential',
      started_at: null,
      completed_at: null,
      created_at: now,
      acceptance_criteria: null,
      refine_count: 0,
      max_refine: 2,
      refine_feedback: null,
    });

    insertTask(db, baseTask(aId, 'Task A', []));
    insertTask(db, baseTask(bId, 'Task B', [aId]));
    insertTask(db, baseTask(cId, 'Task C', [bId]));

    // Simulate crash: A already completed before crash
    setTaskCompleted(db, aId, 'a output');

    const result = await continueWorkflowExecution(db, workflow, {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(result.status).toBe('completed');

    // Task A must NOT have been re-started during resume
    const events = db
      .prepare(
        `SELECT type, task_id FROM events WHERE workflow_id = ? AND type = 'task_started' ORDER BY id`,
      )
      .all(wfId) as { type: string; task_id: string }[];

    const aStarted = events.some((e) => e.task_id === aId);
    expect(aStarted).toBe(false);

    // B and C must have been started and completed
    expect(events.some((e) => e.task_id === bId)).toBe(true);
    expect(events.some((e) => e.task_id === cId)).toBe(true);

    const allTasks = db
      .prepare('SELECT status FROM tasks WHERE workflow_id = ?')
      .all(wfId) as { status: string }[];
    expect(allTasks.every((t) => t.status === 'completed')).toBe(true);

    db.close();
  });

  it('keeps resumed workflow failed when unselected failed tasks remain', async () => {
    const db = initDb(':memory:');
    const now = Date.now();

    const wfId = newWorkflowId();
    const failedId = newTaskId();
    const pendingId = newTaskId();

    const workflow: Workflow = {
      id: wfId,
      workspace: 'test',
      objective: 'resume with one old failed task',
      pattern_id: null,
      status: 'executing',
      started_at: now,
      completed_at: null,
      created_at: now,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    };
    insertWorkflow(db, workflow);

    insertTask(db, makeTask(failedId, wfId, {
      name: 'Old failed task',
      retry_policy: 'none',
      created_at: now,
    }));
    insertTask(db, makeTask(pendingId, wfId, {
      name: 'Retry target',
      retry_policy: 'none',
      created_at: now + 1,
    }));
    setTaskFailed(db, failedId);

    const result = await continueWorkflowExecution(db, workflow, {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(result.status).toBe('failed');

    const row = db
      .prepare('SELECT status, completed_at FROM workflows WHERE id = ?')
      .get(wfId) as { status: string; completed_at: number | null };
    expect(row.status).toBe('failed');
    expect(row.completed_at).not.toBeNull();

    const events = db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(wfId) as { type: string }[];
    expect(events.map((event) => event.type)).toContain('workflow_background_error');
    expect(events.map((event) => event.type)).not.toContain('workflow_completed');

    db.close();
  });

  it('findExecutingWorkflow returns existing workflow', async () => {
    const db = initDb(':memory:');
    const now = Date.now();

    const wfId = newWorkflowId();
    insertWorkflow(db, {
      id: wfId,
      workspace: 'ws1',
      objective: 'do the thing',
      pattern_id: null,
      status: 'executing',
      started_at: now,
      completed_at: null,
      created_at: now,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    });

    const found = findExecutingWorkflow(db, 'ws1', 'do the thing');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(wfId);

    // Different objective → not found
    expect(findExecutingWorkflow(db, 'ws1', 'other objective')).toBeNull();
    // Different workspace → not found
    expect(findExecutingWorkflow(db, 'ws2', 'do the thing')).toBeNull();

    db.close();
  });
});

describe('reviewer integration', () => {
  it('records review after task completes when acceptance_criteria is set', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'review test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, {
      retry_policy: 'none',
      acceptance_criteria: 'Output must greet the user',
    });
    insertTask(db, task);

    const fastExecute = async (): Promise<string> => 'Hello!';
    const mockReview = async () => ({ score: 0.9, feedback: 'nice greeting', passed: true });

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: fastExecute,
      reviewFn: mockReview,
    });

    const reviewRow = db
      .prepare('SELECT * FROM reviews WHERE task_id = ?')
      .get(taskId) as
      | { task_id: string; score: number; feedback: string; passed: number; criteria: string }
      | undefined;

    expect(reviewRow).toBeDefined();
    expect(reviewRow!.score).toBe(0.9);
    expect(reviewRow!.feedback).toBe('nice greeting');
    expect(reviewRow!.passed).toBe(1);
    expect(reviewRow!.criteria).toBe('Output must greet the user');

    const events = db
      .prepare(`SELECT type FROM events WHERE workflow_id = ? AND task_id = ? ORDER BY id`)
      .all(wfId, taskId) as { type: string }[];
    expect(events.map((e) => e.type)).toContain('task_reviewed');

    db.close();
  });

  it('emits task_review_failed when score below threshold', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'review fail', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, {
      retry_policy: 'none',
      acceptance_criteria: 'Must be a poem',
    });
    insertTask(db, task);

    const fastExecute = async (): Promise<string> => 'not a poem';
    const lowScoreReview = async () => ({ score: 0.3, feedback: 'not a poem', passed: false });

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: fastExecute,
      reviewFn: lowScoreReview,
    });

    // Task itself still marked completed (D13 does not re-run — that's D14)
    const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(taskRow.status).toBe('completed');

    const reviewRow = db.prepare('SELECT passed FROM reviews WHERE task_id = ?').get(taskId) as { passed: number };
    expect(reviewRow.passed).toBe(0);

    const events = db
      .prepare(`SELECT type FROM events WHERE task_id = ?`)
      .all(taskId) as { type: string }[];
    expect(events.map((e) => e.type)).toContain('task_review_failed');

    db.close();
  });

  it('skips review when acceptance_criteria is null', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'no criteria', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, { retry_policy: 'none' }); // acceptance_criteria: null by default
    insertTask(db, task);

    let reviewCalled = false;
    const mockReview = async () => { reviewCalled = true; return { score: 1, feedback: '', passed: true }; };

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: async () => 'ok',
      reviewFn: mockReview,
    });

    expect(reviewCalled).toBe(false);

    const reviewRow = db.prepare('SELECT id FROM reviews WHERE task_id = ?').get(taskId);
    expect(reviewRow).toBeUndefined();

    db.close();
  });

  it('review error is fatal — task is failed, error event emitted', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'review throws', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, { retry_policy: 'none', acceptance_criteria: 'anything' });
    insertTask(db, task);

    const throwingReview = async () => { throw new Error('omniroute down'); };

    await expect(
      runTaskLoop(db, [task], wfId, new Set(), {
        executeTaskFn: async () => 'ok',
        reviewFn: throwingReview,
      })
    ).rejects.toThrow('omniroute down');

    const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(taskRow.status).toBe('failed');

    const events = db.prepare(`SELECT type FROM events WHERE task_id = ?`).all(taskId) as { type: string }[];
    expect(events.map((e) => e.type)).toContain('task_review_error');

    db.close();
  });
});

describe('timeout', () => {
  it('fails task that exceeds timeout_seconds', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'timeout test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    // timeout_seconds: 0.1 → 100ms deadline
    const task = makeTask(taskId, wfId, {
      timeout_seconds: 0.1,
      max_retries: 0,
      retry_policy: 'none',
    });
    insertTask(db, task);

    const neverResolves = async (): Promise<string> => new Promise(() => {});

    const start = Date.now();
    await expect(
      runTaskLoop(db, [task], wfId, new Set(), { executeTaskFn: neverResolves }),
    ).rejects.toThrow(/timed out/);
    const duration = Date.now() - start;

    expect(duration).toBeGreaterThanOrEqual(80);
    expect(duration).toBeLessThan(500);

    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
      { status: string };
    expect(row.status).toBe('failed');

    db.close();
  }, 3000);

  it('completes normally when executor finishes before timeout', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'fast task', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, { timeout_seconds: 30, retry_policy: 'none' });
    insertTask(db, task);

    const fastExecute = async (): Promise<string> => 'done quickly';

    await runTaskLoop(db, [task], wfId, new Set(), { executeTaskFn: fastExecute });

    const row = db.prepare('SELECT status, output_json FROM tasks WHERE id = ?').get(taskId) as
      { status: string; output_json: string };
    expect(row.status).toBe('completed');
    expect(row.output_json).toBe('done quickly');

    db.close();
  });

  it('timeout_seconds = 0 disables timeout (no-op)', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'no timeout', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, { timeout_seconds: 0, retry_policy: 'none' });
    insertTask(db, task);

    const fastExecute = async (): Promise<string> => 'ok';
    await runTaskLoop(db, [task], wfId, new Set(), { executeTaskFn: fastExecute });

    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('completed');

    db.close();
  });
});

describe('parallel execution', () => {
  it('runs independent tasks in parallel — total time ≈ one task, not three', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'parallel test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const [aId, bId, cId] = [newTaskId(), newTaskId(), newTaskId()];
    const tasks = [aId, bId, cId].map((id) => {
      const t = makeTask(id, wfId, { retry_policy: 'none' });
      insertTask(db, t);
      return t;
    });

    // Each task takes ~30ms; sequential = ~90ms, parallel = ~30ms
    const slowExecute = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 30));
      return 'ok';
    };

    const start = Date.now();
    await runTaskLoop(db, tasks, wfId, new Set(), { executeTaskFn: slowExecute });
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(85); // ~30ms parallel, well under 90ms sequential with CI jitter
    expect(duration).toBeGreaterThanOrEqual(25); // sanity — async work actually happened

    const statuses = db
      .prepare('SELECT status FROM tasks WHERE workflow_id = ?')
      .all(wfId) as { status: string }[];
    expect(statuses.every((r) => r.status === 'completed')).toBe(true);

    db.close();
  });

  it('fan-in with parallel branches — C starts only after both A and B complete', async () => {
    const db = initDb(':memory:');

    // Reuse existing executeWorkflow which now runs A||B then C
    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: [] },
        { id: 'c', name: 'Task C', kind: 'llm_call', depends_on: ['a', 'b'] },
      ],
    };

    const wf = await executeWorkflow(db, dag, 'internal', '', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
    });
    expect(wf.status).toBe('completed');

    const events = db
      .prepare(
        `SELECT e.type, t.name FROM events e
         INNER JOIN tasks t ON e.task_id = t.id
         WHERE e.workflow_id = ? AND e.task_id IS NOT NULL ORDER BY e.id`,
      )
      .all(wf.id) as { type: string; name: string }[];

    const idx = (name: string, type: string) =>
      events.findIndex((e) => e.name === name && e.type === type);

    expect(idx('Task C', 'task_started')).toBeGreaterThan(idx('Task A', 'task_completed'));
    expect(idx('Task C', 'task_started')).toBeGreaterThan(idx('Task B', 'task_completed'));

    db.close();
  });

  it('failure in one parallel task fails the workflow', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'parallel fail', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const [aId, bId] = [newTaskId(), newTaskId()];
    const tasks = [aId, bId].map((id) => {
      const t = makeTask(id, wfId, { retry_policy: 'none' });
      insertTask(db, t);
      return t;
    });

    // task A succeeds, task B always fails
    const mixedExecute = async (task: Task): Promise<string> => {
      if (task.id === bId) throw new Error('task B failed');
      return 'ok';
    };

    await expect(
      runTaskLoop(db, tasks, wfId, new Set(), { executeTaskFn: mixedExecute, sleepFn: async () => {} }),
    ).rejects.toThrow('task B failed');

    const wfRow = db.prepare('SELECT status FROM workflows WHERE id = ?').get(wfId) as { status: string };
    expect(wfRow.status).toBe('failed');

    db.close();
  });
});

describe('eval-refine loop', () => {
  it('refine success — 1 fail + 1 pass → refine_count=1, final output is refined, task completed', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'refine success', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, {
      retry_policy: 'none',
      acceptance_criteria: 'Must be a haiku',
      max_refine: 2,
    });
    insertTask(db, task);

    let execCalls = 0;
    const mockExecute = async (): Promise<string> => {
      execCalls++;
      return execCalls === 1 ? 'not a haiku' : 'old pond / a frog jumps in / water sound';
    };

    let reviewCalls = 0;
    const mockReview = async () => {
      reviewCalls++;
      return reviewCalls === 1
        ? { score: 0.2, feedback: 'Not a haiku — wrong syllable structure', passed: false }
        : { score: 0.95, feedback: 'Perfect haiku', passed: true };
    };

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: mockExecute,
      reviewFn: mockReview,
    });

    const taskRow = db.prepare('SELECT status, refine_count, output_json FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; refine_count: number; output_json: string };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.refine_count).toBe(1);
    expect(taskRow.output_json).toBe('old pond / a frog jumps in / water sound');

    const reviews = db.prepare('SELECT score, passed FROM reviews WHERE task_id = ? ORDER BY rowid')
      .all(taskId) as { score: number; passed: number }[];
    expect(reviews).toHaveLength(2);
    expect(reviews[0].passed).toBe(0);
    expect(reviews[1].passed).toBe(1);

    const events = db.prepare('SELECT type FROM events WHERE task_id = ? ORDER BY id')
      .all(taskId) as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain('task_review_failed');
    expect(types).toContain('task_refining');
    expect(types).toContain('task_reviewed');
    expect(types).not.toContain('task_refine_exhausted');

    db.close();
  });

  it('budget cap — stops before max_refine when accumulated cost would exceed limit', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'budget cap', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    // max_refine=3 but cost per call=0.06 and MAX=0.10 → 1 refine ok (0.06), 2nd would exceed (0.12)
    const task = makeTask(taskId, wfId, {
      retry_policy: 'none',
      acceptance_criteria: 'Must be perfect',
      max_refine: 3,
    });
    insertTask(db, task);

    const mockExecute = async (): Promise<string> => 'mediocre output';
    const alwaysFails = async () => ({ score: 0.3, feedback: 'not good enough', passed: false });

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: mockExecute,
      reviewFn: alwaysFails,
      refineCostPerCallUsd: 0.06, // 1 refine = $0.06 ok, 2nd would = $0.12 > $0.10
    });

    const taskRow = db.prepare('SELECT status, refine_count FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; refine_count: number };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.refine_count).toBe(1); // only 1 refine before budget cap

    const events = db.prepare('SELECT type FROM events WHERE task_id = ? ORDER BY id')
      .all(taskId) as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain('task_refine_budget_exceeded');
    expect(types).not.toContain('task_refine_exhausted');

    // budget event carries cost metadata
    const budgetEvent = db
      .prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task_refine_budget_exceeded'`)
      .get(taskId) as { payload_json: string };
    const payload = JSON.parse(budgetEvent.payload_json) as { cost_usd: number; max_cost_usd: number };
    expect(payload.cost_usd).toBeCloseTo(0.06);
    expect(payload.max_cost_usd).toBe(0.10);

    db.close();
  });

  it('time cap — stops before max_refine when wall-clock budget exceeded', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'time cap', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    // max_refine=3 but timeout=40ms; executor takes 60ms → after refine 1 (~60ms > 40ms), 2nd blocked
    const task = makeTask(taskId, wfId, {
      retry_policy: 'none',
      acceptance_criteria: 'Must be perfect',
      max_refine: 3,
    });
    insertTask(db, task);

    const slowExecute = async (): Promise<string> => {
      await new Promise((r) => setTimeout(r, 60));
      return 'mediocre output';
    };
    const alwaysFails = async () => ({ score: 0.3, feedback: 'not good enough', passed: false });

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: slowExecute,
      reviewFn: alwaysFails,
      refineTimeoutMs: 40,
    });

    const taskRow = db.prepare('SELECT status, refine_count FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; refine_count: number };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.refine_count).toBe(1); // 1 refine completed, 2nd blocked by timeout

    const events = db.prepare('SELECT type FROM events WHERE task_id = ? ORDER BY id')
      .all(taskId) as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain('task_refine_timeout');
    expect(types).not.toContain('task_refine_exhausted');

    const timeoutEvent = db
      .prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task_refine_timeout'`)
      .get(taskId) as { payload_json: string };
    const payload = JSON.parse(timeoutEvent.payload_json) as { elapsed_ms: number; max_ms: number };
    expect(payload.elapsed_ms).toBeGreaterThan(0);
    expect(payload.max_ms).toBe(40);

    db.close();
  }, 3000);

  it('refine exhausted — review always fails → refine_count=max_refine, task_refine_exhausted emitted, task completed', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'refine exhausted', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, {
      retry_policy: 'none',
      acceptance_criteria: 'Must be perfect',
      max_refine: 2,
    });
    insertTask(db, task);

    const mockExecute = async (): Promise<string> => 'mediocre output';
    const alwaysFails = async () => ({ score: 0.3, feedback: 'still not good enough', passed: false });

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: mockExecute,
      reviewFn: alwaysFails,
    });

    const taskRow = db.prepare('SELECT status, refine_count FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; refine_count: number };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.refine_count).toBe(2); // max_refine exhausted

    // 3 reviews total: 1 initial + 2 refines
    const reviewCount = (db.prepare('SELECT count(*) as n FROM reviews WHERE task_id = ?')
      .get(taskId) as { n: number }).n;
    expect(reviewCount).toBe(3);

    const events = db.prepare('SELECT type FROM events WHERE task_id = ? ORDER BY id')
      .all(taskId) as { type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain('task_refine_exhausted');
    expect(types.filter((t) => t === 'task_refining')).toHaveLength(2);

    db.close();
  });
});

describe('retry policies', () => {
  const noSleep = async () => {};

  // These exercise the legacy retry MECHANICS (retry_count, status, backoff
  // events) — NOT the persona self-healing layer. The personas-OFF +
  // dead-OMNIROUTE_URL guard that keeps these deterministic and fully offline
  // is now applied file-wide (see the top-level beforeEach/afterEach), since
  // the "timeout retry escalation" and "parallel execution" suites drive the
  // same retryable failures. Expected retry_count / status / task_retrying
  // assertions are unaffected — they are emitted by the legacy retry path
  // regardless of the persona layer.

  it('succeeds after N failures — retry_count reflects attempts, status is completed', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'retry test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, { max_retries: 3, retry_policy: 'exponential' });
    insertTask(db, task);

    // Fails on attempts 1 and 2, succeeds on attempt 3
    let calls = 0;
    const flakyExecute = async (_t: Task): Promise<string> => {
      calls++;
      if (calls < 3) throw new Error(`attempt ${calls} failed`);
      return 'ok after retry';
    };

    await runTaskLoop(db, [task], wfId, new Set(), { executeTaskFn: flakyExecute, sleepFn: noSleep });

    const row = db.prepare('SELECT status, retry_count, output_json FROM tasks WHERE id = ?').get(taskId) as
      { status: string; retry_count: number; output_json: string };

    expect(row.status).toBe('completed');
    expect(row.retry_count).toBe(2); // 2 retries before success
    expect(row.output_json).toBe('ok after retry');

    const retryEvents = db
      .prepare(`SELECT type FROM events WHERE workflow_id = ? AND type = 'task_retrying'`)
      .all(wfId) as { type: string }[];
    expect(retryEvents).toHaveLength(2);

    db.close();
  });

  it('exhausts max_retries — status is failed, workflow is failed', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'fail test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, { max_retries: 2, retry_policy: 'exponential' });
    insertTask(db, task);

    const alwaysFails = async (): Promise<string> => { throw new Error('always fails'); };

    await expect(
      runTaskLoop(db, [task], wfId, new Set(), { executeTaskFn: alwaysFails, sleepFn: noSleep }),
    ).rejects.toThrow('always fails');

    const taskRow = db.prepare('SELECT status, retry_count FROM tasks WHERE id = ?').get(taskId) as
      { status: string; retry_count: number };
    expect(taskRow.status).toBe('failed');
    expect(taskRow.retry_count).toBe(2); // max_retries exhausted

    const wfRow = db.prepare('SELECT status FROM workflows WHERE id = ?').get(wfId) as { status: string };
    expect(wfRow.status).toBe('failed');

    db.close();
  });

  it('retry_policy none — fails immediately without retry', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'none policy', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, { max_retries: 3, retry_policy: 'none' });
    insertTask(db, task);

    let calls = 0;
    const countingExecute = async (): Promise<string> => { calls++; throw new Error('fail'); };

    await expect(
      runTaskLoop(db, [task], wfId, new Set(), { executeTaskFn: countingExecute, sleepFn: noSleep }),
    ).rejects.toThrow();

    expect(calls).toBe(1); // only one attempt, no retries

    const row = db.prepare('SELECT retry_count FROM tasks WHERE id = ?').get(taskId) as { retry_count: number };
    expect(row.retry_count).toBe(0);

    db.close();
  });
});

// ─── FASE 1B Bloco A.2 — execution_mode dispatch tests ───────────────────────

describe('execution_mode dispatch', () => {
  // Helper to build a Workflow record for insertWorkflow
  function makeWorkflow(id: string): Workflow {
    const now = Date.now();
    return {
      id,
      workspace: 'test',
      objective: 'adaptive test',
      pattern_id: null,
      status: 'executing',
      started_at: now,
      completed_at: null,
      created_at: now,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    };
  }

  it('ephemeral default — DAG tasks with no execution_mode materialise as ephemeral; supervisor never invoked', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call', depends_on: [] },
        { id: 'b', name: 'Task B', kind: 'llm_call', depends_on: ['a'] },
      ],
    };

    const supervisorSpy = vi.fn();

    const wf = await executeWorkflow(db, dag, 'test', 'ephemeral default test', {
      consolidateFn: async () => 'ok',
      executeTaskFn: stubExecute,
      onSubagentEvent: supervisorSpy,
    });

    expect(wf.status).toBe('completed');

    // Verify execution_mode stored in DB is 'ephemeral' for all tasks
    const rows = db
      .prepare(`SELECT execution_mode FROM tasks WHERE workflow_id = ?`)
      .all(wf.id) as { execution_mode: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.execution_mode === 'ephemeral')).toBe(true);

    // supervisor hook should NOT have been called (no adaptive tasks)
    expect(supervisorSpy).not.toHaveBeenCalled();

    db.close();
  });

  it('all adaptive — 2 adaptive tasks call supervisor once; ephemeral path skipped', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    insertWorkflow(db, makeWorkflow(wfId));

    const [aId, bId] = [newTaskId(), newTaskId()];

    const makeAdaptiveTask = (id: string, name: string): Task => ({
      ...makeTask(id, wfId, { retry_policy: 'none' }),
      name,
      execution_mode: 'adaptive',
    });

    const tasks = [
      makeAdaptiveTask(aId, 'Adaptive A'),
      makeAdaptiveTask(bId, 'Adaptive B'),
    ];
    for (const t of tasks) insertTask(db, t);

    let supervisorCallCount = 0;
    const stubTurnFn: ExecuteAdaptiveTurnFn = async (task) => {
      supervisorCallCount++;
      return `adaptive output for ${task.name}`;
    };

    let ephemeralExecuteCalled = false;
    const spyExecute = async (task: Task): Promise<string> => {
      ephemeralExecuteCalled = true;
      return `ephemeral output for ${task.name}`;
    };

    await runTaskLoop(db, tasks, wfId, new Set(), {
      executeTaskFn: spyExecute,
      adaptiveExecuteTurnFn: stubTurnFn,
    });

    // Ephemeral execute was never invoked (all tasks adaptive)
    expect(ephemeralExecuteCalled).toBe(false);

    // Both tasks should be completed in DB
    const statuses = db
      .prepare('SELECT status FROM tasks WHERE workflow_id = ?')
      .all(wfId) as { status: string }[];
    expect(statuses.every((r) => r.status === 'completed')).toBe(true);

    // Supervisor turn function was called at least once (once per task at minimum)
    expect(supervisorCallCount).toBeGreaterThanOrEqual(2);

    db.close();
  });

  it('mixed batch — 1 ephemeral + 1 adaptive in same batch; both complete; completedIds includes both', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    insertWorkflow(db, makeWorkflow(wfId));

    const [ephId, adapId] = [newTaskId(), newTaskId()];

    const ephemeralTask: Task = {
      ...makeTask(ephId, wfId, { retry_policy: 'none' }),
      name: 'Ephemeral Task',
      execution_mode: 'ephemeral',
    };
    const adaptiveTask: Task = {
      ...makeTask(adapId, wfId, { retry_policy: 'none' }),
      name: 'Adaptive Task',
      execution_mode: 'adaptive',
    };
    insertTask(db, ephemeralTask);
    insertTask(db, adaptiveTask);

    const completedIds = new Set<string>();
    const stubTurnFn: ExecuteAdaptiveTurnFn = async (task) => `turn output for ${task.name}`;

    await runTaskLoop(db, [ephemeralTask, adaptiveTask], wfId, completedIds, {
      executeTaskFn: stubExecute,
      adaptiveExecuteTurnFn: stubTurnFn,
    });

    // Both IDs must be in completedIds
    expect(completedIds.has(ephId)).toBe(true);
    expect(completedIds.has(adapId)).toBe(true);

    // Both tasks completed in DB
    const statuses = db
      .prepare('SELECT id, status FROM tasks WHERE workflow_id = ?')
      .all(wfId) as { id: string; status: string }[];
    expect(statuses.find((r) => r.id === ephId)?.status).toBe('completed');
    expect(statuses.find((r) => r.id === adapId)?.status).toBe('completed');

    db.close();
  });

  it('adaptive failure propagation — supervisor error outcome → task fails, workflow fails', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    insertWorkflow(db, makeWorkflow(wfId));

    const adapId = newTaskId();
    const adaptiveTask: Task = {
      ...makeTask(adapId, wfId, { retry_policy: 'none' }),
      name: 'Failing Adaptive Task',
      execution_mode: 'adaptive',
    };
    insertTask(db, adaptiveTask);

    // executeTurnFn that throws so the stub supervisor sets outcome.status = 'error'
    const failingTurnFn: ExecuteAdaptiveTurnFn = async (_task) => {
      throw new Error('supervisor turn boom');
    };

    await expect(
      runTaskLoop(db, [adaptiveTask], wfId, new Set(), {
        adaptiveExecuteTurnFn: failingTurnFn,
      }),
    ).rejects.toThrow(/Failing Adaptive Task.*failed/);

    const taskRow = db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(adapId) as { status: string };
    expect(taskRow.status).toBe('failed');

    const wfRow = db
      .prepare('SELECT status FROM workflows WHERE id = ?')
      .get(wfId) as { status: string };
    expect(wfRow.status).toBe('failed');

    db.close();
  });

  it('resumeWorkflow with adaptive tasks — DB tasks with execution_mode=adaptive resume via supervisor path', async () => {
    const db = initDb(':memory:');
    const now = Date.now();
    const wfId = newWorkflowId();

    const workflow: Workflow = makeWorkflow(wfId);
    insertWorkflow(db, workflow);

    const aId = newTaskId();
    const bId = newTaskId();

    // Task A: already completed from prior run
    const taskA: Task = {
      ...makeTask(aId, wfId),
      name: 'Prior Completed',
      execution_mode: 'ephemeral',
      status: 'completed',
    };
    // Task B: adaptive, pending (simulating crash before it ran)
    const taskB: Task = {
      ...makeTask(bId, wfId, { retry_policy: 'none' }),
      name: 'Adaptive Resume',
      execution_mode: 'adaptive',
      depends_on: [aId],
    };
    insertTask(db, taskA);
    insertTask(db, taskB);

    // Mark A completed in DB as prior run would have
    setTaskCompleted(db, aId, 'prior output');

    let supervisorInvokedForB = false;
    const stubTurnFn: ExecuteAdaptiveTurnFn = async (task) => {
      if (task.id === bId) supervisorInvokedForB = true;
      return `resumed adaptive output for ${task.name}`;
    };

    const result = await continueWorkflowExecution(db, workflow, {
      consolidateFn: async () => 'ok',
      executeTaskFn: stubExecute,
      adaptiveExecuteTurnFn: stubTurnFn,
    });

    expect(result.status).toBe('completed');

    // B must have been routed through supervisor
    expect(supervisorInvokedForB).toBe(true);

    // B must be completed in DB
    const bRow = db
      .prepare('SELECT status FROM tasks WHERE id = ?')
      .get(bId) as { status: string };
    expect(bRow.status).toBe('completed');

    db.close();
  });
});

describe('workflow CLI permission mode', () => {
  it('applies persisted autonomous mode to cli_spawn tasks after daemon async context loss', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();
    const now = Date.now();
    const previousDaemonChild = process.env.OMNIFORGE_DAEMON_CHILD;

    insertWorkflow(db, {
      id: wfId,
      workspace: 'internal',
      objective: 'persist autonomous CLI permission',
      pattern_id: null,
      status: 'executing',
      started_at: now,
      completed_at: null,
      created_at: now,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    });
    recordWorkflowCliPermissionMode(db, wfId, 'autonomous', 'test');

    const task = makeTask(taskId, wfId, {
      kind: 'cli_spawn',
      executor_hint: 'cli:codex',
      model: 'cx/gpt-5.4',
      retry_policy: 'none',
      acceptance_criteria: null,
      input_json: JSON.stringify({ objective: 'write files' }),
    });
    insertTask(db, task);

    try {
      process.env.OMNIFORGE_DAEMON_CHILD = '1';
      await runTaskLoop(db, [task], wfId, new Set(), {
        executeTaskFn: async () => (isCliSafeMode() ? 'safe' : 'autonomous'),
      });

      const taskRow = db.prepare(
        `SELECT status, output_json FROM tasks WHERE id = ?`,
      ).get(taskId) as { status: string; output_json: string | null };
      expect(taskRow).toMatchObject({
        status: 'completed',
        output_json: 'autonomous',
      });

      const applied = db.prepare(
        `SELECT payload_json
           FROM events
          WHERE workflow_id = ?
            AND task_id = ?
            AND type = 'task_cli_permission_mode_applied'
          ORDER BY id DESC
          LIMIT 1`,
      ).get(wfId, taskId) as { payload_json: string } | undefined;
      expect(applied).toBeDefined();
      expect(JSON.parse(applied!.payload_json)).toMatchObject({ mode: 'autonomous' });
    } finally {
      if (previousDaemonChild === undefined) delete process.env.OMNIFORGE_DAEMON_CHILD;
      else process.env.OMNIFORGE_DAEMON_CHILD = previousDaemonChild;
      db.close();
    }
  });
});

// ─── timeout_seconds DAG field + retry escalation tests ──────────────────────

describe('DAG timeout_seconds materialisation', () => {
  it('DAG with timeout_seconds: 600 → materialised task has timeout_seconds 600', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Slow Task', kind: 'cli_spawn', depends_on: [], timeout_seconds: 600 },
      ],
    };

    const wf = await executeWorkflow(db, dag, 'internal', 'timeout override test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(wf.status).toBe('completed');

    const row = db
      .prepare('SELECT timeout_seconds FROM tasks WHERE workflow_id = ?')
      .get(wf.id) as { timeout_seconds: number };
    expect(row.timeout_seconds).toBe(600);

    db.close();
  });

  it('DAG without timeout_seconds → materialised task has default 300 (back-compat)', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'Normal Task', kind: 'llm_call', depends_on: [] },
      ],
    };

    const wf = await executeWorkflow(db, dag, 'internal', 'default timeout test', {
      consolidateFn: stubConsolidate,
      executeTaskFn: stubExecute,
    });

    expect(wf.status).toBe('completed');

    const row = db
      .prepare('SELECT timeout_seconds FROM tasks WHERE workflow_id = ?')
      .get(wf.id) as { timeout_seconds: number };
    expect(row.timeout_seconds).toBe(300);

    db.close();
  });

  it('cli_spawn tasks inherit workspace software target without changing run_root', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-executor-workspace-target-'));
    const dbPath = join(tempDir, 'omniforge.db');
    const projectRoot = join(tempDir, 'repo');
    const projectCwd = join(projectRoot, 'packages', 'app');
    const originalDbPath = process.env.DB_PATH;
    mkdirSync(projectCwd, { recursive: true });
    process.env.DB_PATH = dbPath;

    const db = initDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
         VALUES (?, ?, ?, ?)`,
      ).run('internal', Date.now(), 'test', JSON.stringify({
        software_target: {
          project_root: projectRoot,
          cwd: 'packages/app',
          base_ref: 'main',
        },
      }));

      const dag: Dag = {
        tasks: [
          { id: 'a', name: 'Software Task', kind: 'cli_spawn', depends_on: [] },
        ],
      };

      const wf = await executeWorkflow(db, dag, 'internal', 'workspace target test', {
        consolidateFn: stubConsolidate,
        executeTaskFn: stubExecute,
      });

      expect(wf.status).toBe('completed');

      const row = db
        .prepare('SELECT id, input_json FROM tasks WHERE workflow_id = ?')
        .get(wf.id) as { id: string; input_json: string };
      const parsed = JSON.parse(row.input_json) as {
        execution_context?: {
          run_root: string;
          project_root: string;
          cwd: string;
          output_dir: string;
          base_ref: string | null;
        };
      };

      expect(parsed.execution_context).toMatchObject({
        project_root: resolve(projectRoot),
        cwd: resolve(projectCwd),
        output_dir: resolve('workspaces', 'internal', 'runs', wf.id),
        base_ref: 'main',
        source_project_root: resolve(projectRoot),
        source_cwd: resolve(projectCwd),
        worktree_root: null,
        worktree_branch: null,
      });
      expect(parsed.execution_context?.run_root).toBe(resolve('workspaces', 'internal', 'runs', wf.id));
      expect(parsed.execution_context?.project_root).not.toBe(parsed.execution_context?.run_root);
    } finally {
      db.close();
      if (originalDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = originalDbPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('cli_spawn tasks materialize a git worktree when the workspace target points to a repository', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-executor-git-worktree-'));
    const dbPath = join(tempDir, 'omniforge.db');
    const repoRoot = join(tempDir, 'repo');
    const repoCwd = join(repoRoot, 'packages', 'app');
    const originalDbPath = process.env.DB_PATH;
    let createdWorktreeRoot: string | null = null;
    mkdirSync(repoCwd, { recursive: true });
    process.env.DB_PATH = dbPath;

    const db = initDb(dbPath);
    try {
      runGit(tempDir, ['init', repoRoot]);
      runGit(repoRoot, ['config', 'user.name', 'Omniforge Test']);
      runGit(repoRoot, ['config', 'user.email', 'omniforge@example.com']);
      runGit(repoRoot, ['checkout', '-b', 'main']);
      writeFileSync(join(repoRoot, 'README.md'), '# test\n');
      writeFileSync(join(repoCwd, 'index.ts'), 'export const ok = true;\n');
      runGit(repoRoot, ['add', '.']);
      runGit(repoRoot, ['commit', '-m', 'init']);

      db.prepare(
        `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
         VALUES (?, ?, ?, ?)`,
      ).run('internal', Date.now(), 'test', JSON.stringify({
        software_target: {
          project_root: repoRoot,
          cwd: 'packages/app',
          base_ref: 'main',
        },
      }));

      const dag: Dag = {
        tasks: [
          { id: 'a', name: 'Software Task', kind: 'cli_spawn', depends_on: [] },
        ],
      };

      const wf = await executeWorkflow(db, dag, 'internal', 'workspace git worktree test', {
        consolidateFn: stubConsolidate,
        executeTaskFn: stubExecute,
      });
      createdWorktreeRoot = resolve('data', 'worktrees', 'internal', wf.id);

      const row = db
        .prepare('SELECT id, input_json FROM tasks WHERE workflow_id = ?')
        .get(wf.id) as { id: string; input_json: string };
      const parsed = JSON.parse(row.input_json) as {
        execution_context?: {
          run_root: string;
          project_root: string;
          cwd: string;
          output_dir: string;
          base_ref: string | null;
          source_project_root: string;
          source_cwd: string;
          worktree_root: string | null;
          worktree_branch: string | null;
          lineage: { source: string };
        };
      };

      const worktreeRoot = createdWorktreeRoot;
      expect(parsed.execution_context).toMatchObject({
        project_root: worktreeRoot,
        cwd: resolve(worktreeRoot, 'packages', 'app'),
        output_dir: resolve('workspaces', 'internal', 'runs', wf.id),
        base_ref: 'main',
        source_project_root: realpathSync.native(repoRoot),
        source_cwd: realpathSync.native(repoCwd),
        worktree_root: worktreeRoot,
        worktree_branch: `omniforge/${wf.id}`,
        lineage: { source: 'git_worktree' },
      });
      expect(parsed.execution_context?.run_root).toBe(resolve('workspaces', 'internal', 'runs', wf.id));

      runGit(worktreeRoot, ['rev-parse', '--is-inside-work-tree']);
      const events = db
        .prepare(`SELECT type FROM events WHERE workflow_id = ? ORDER BY id`)
        .all(wf.id) as Array<{ type: string }>;
      expect(events.map((event) => event.type)).toContain('task_worktree_created');
    } finally {
      db.close();
      if (originalDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = originalDbPath;
      if (createdWorktreeRoot) {
        try { runGit(repoRoot, ['worktree', 'remove', '--force', createdWorktreeRoot]); }
        catch { rmSync(createdWorktreeRoot, { recursive: true, force: true }); }
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('timeout retry escalation', () => {
  const noSleep = async (): Promise<void> => {};

  it('attempt 2 after timeout: effectiveTimeout = 1.5× original, task_timeout_extended emitted', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'escalation test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    // timeout_seconds: 0.1 (100ms) so the first attempt times out quickly.
    // max_retries: 1 so there is exactly 1 retry (attempt 2) — which we
    // make succeed so the task completes and we can inspect events.
    const task = makeTask(taskId, wfId, {
      timeout_seconds: 0.1,
      max_retries: 1,
      retry_policy: 'exponential',
    });
    insertTask(db, task);

    let callCount = 0;
    const timeoutThenSucceed = async (): Promise<string> => {
      callCount++;
      if (callCount === 1) {
        // First attempt: never resolve → triggers withTimeout
        await new Promise<never>(() => {});
      }
      return 'succeeded on retry';
    };

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: timeoutThenSucceed,
      sleepFn: noSleep,
    });

    // Task must have completed on the retry
    const taskRow = db
      .prepare('SELECT status, retry_count FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; retry_count: number };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.retry_count).toBe(1);

    // task_timeout_extended must have been emitted once (on attempt 2)
    const extEvents = db
      .prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task_timeout_extended' ORDER BY id`)
      .all(taskId) as { payload_json: string }[];
    expect(extEvents).toHaveLength(1);

    const extPayload = JSON.parse(extEvents[0]!.payload_json) as {
      previous_s: number;
      new_s: number;
      attempt: number;
    };
    // The event must be emitted on attempt 2 with the original timeout as previous_s.
    // Note: with tiny sub-second values Math.round(0.1 * 1.5) rounds to 0;
    // the clamp and rounding semantics are verified at meaningful scales in the
    // multi-escalation and cap tests below — here we only assert the event shape.
    expect(extPayload.attempt).toBe(2);
    expect(extPayload.previous_s).toBeCloseTo(0.1);
    expect(typeof extPayload.new_s).toBe('number');

    db.close();
  }, 5000);

  it('attempt 3 after two timeouts: 1.5² escalation (new_s > first escalation), capped at 1800s', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'multi-escalation test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    // Use a realistic timeout: 200s so Math.round(200*1.5)=300 and Math.round(300*1.5)=450
    const task = makeTask(taskId, wfId, {
      timeout_seconds: 200,
      max_retries: 2,
      retry_policy: 'exponential',
    });
    insertTask(db, task);

    // Stub that times out on attempts 1 and 2 then succeeds on attempt 3.
    // We can't actually wait 200s — instead we override the executeTaskFn to
    // throw a message matching the timeout classifier pattern directly.
    let callCount = 0;
    const fakeTimeouts = async (): Promise<string> => {
      callCount++;
      if (callCount <= 2) {
        throw new Error(`Task 'Multi Task' timed out after 200000ms`);
      }
      return 'success on attempt 3';
    };

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: fakeTimeouts,
      sleepFn: noSleep,
    });

    const taskRow = db
      .prepare('SELECT status, retry_count FROM tasks WHERE id = ?')
      .get(taskId) as { status: string; retry_count: number };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.retry_count).toBe(2);

    // Two task_timeout_extended events — one per escalation
    const extEvents = db
      .prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task_timeout_extended' ORDER BY id`)
      .all(taskId) as { payload_json: string }[];
    expect(extEvents).toHaveLength(2);

    const p1 = JSON.parse(extEvents[0]!.payload_json) as { previous_s: number; new_s: number; attempt: number };
    const p2 = JSON.parse(extEvents[1]!.payload_json) as { previous_s: number; new_s: number; attempt: number };

    // Attempt 2: 200 → Math.round(200*1.5) = 300
    expect(p1.attempt).toBe(2);
    expect(p1.previous_s).toBe(200);
    expect(p1.new_s).toBe(300);

    // Attempt 3: 300 → Math.round(300*1.5) = 450
    expect(p2.attempt).toBe(3);
    expect(p2.previous_s).toBe(300);
    expect(p2.new_s).toBe(450);

    // Both values are well below 1800s cap
    expect(p1.new_s).toBeLessThanOrEqual(1800);
    expect(p2.new_s).toBeLessThanOrEqual(1800);

    db.close();
  });

  it('escalation caps at 1800s — starting near cap does not exceed it', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'cap test', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    // Start at 1500s — 1.5× would be 2250s, must be clamped to 1800s
    const task = makeTask(taskId, wfId, {
      timeout_seconds: 1500,
      max_retries: 1,
      retry_policy: 'exponential',
    });
    insertTask(db, task);

    let callCount = 0;
    const fakeTimeout = async (): Promise<string> => {
      callCount++;
      if (callCount === 1) {
        throw new Error(`Task 'Cap Task' timed out after 1500000ms`);
      }
      return 'ok';
    };

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: fakeTimeout,
      sleepFn: noSleep,
    });

    const extEvents = db
      .prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task_timeout_extended'`)
      .all(taskId) as { payload_json: string }[];
    expect(extEvents).toHaveLength(1);

    const payload = JSON.parse(extEvents[0]!.payload_json) as { new_s: number };
    expect(payload.new_s).toBe(1800);

    db.close();
  });

  it('starting at cap (1800s) + timeout → task_timeout_cap_reached emitted, retries short-circuited', async () => {
    // R-HIGH Opus review 2026-04-23: when timeout_seconds is already at the
    // cap and the task times out, the 1.5× escalation clamps to the same
    // value — retrying is a no-op that wastes 30min per attempt. The fix
    // short-circuits the retry loop when the cap is already hit.
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'cap-short-circuit', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, {
      timeout_seconds: 1800,
      max_retries: 3, // would normally retry 3 times
      retry_policy: 'exponential',
    });
    insertTask(db, task);

    let callCount = 0;
    const alwaysTimeout = async (): Promise<string> => {
      callCount++;
      throw new Error(`Task 'Cap Task' timed out after 1800000ms`);
    };

    await expect(
      runTaskLoop(db, [task], wfId, new Set(), {
        executeTaskFn: alwaysTimeout,
        sleepFn: noSleep,
      }),
    ).rejects.toThrow(/timed out/);

    // Short-circuit: executor should call at most 2 times (initial + 1 retry
    // that trips the cap-reached branch). NOT 4 (initial + 3 retries).
    expect(callCount).toBeLessThanOrEqual(2);

    // Exactly one task_timeout_cap_reached event emitted
    const capEvents = db
      .prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task_timeout_cap_reached'`)
      .all(taskId) as { payload_json: string }[];
    expect(capEvents).toHaveLength(1);

    const payload = JSON.parse(capEvents[0]!.payload_json) as { timeout_s: number; attempt: number };
    expect(payload.timeout_s).toBe(1800);

    // No task_timeout_extended events — the escalation branch was skipped
    const extEvents = db
      .prepare(`SELECT 1 FROM events WHERE task_id = ? AND type = 'task_timeout_extended'`)
      .all(taskId);
    expect(extEvents).toHaveLength(0);

    db.close();
  });

  it('non-timeout retry does NOT emit task_timeout_extended', async () => {
    const db = initDb(':memory:');
    const wfId = newWorkflowId();
    const taskId = newTaskId();

    insertWorkflow(db, {
      id: wfId, workspace: 'test', objective: 'no escalation on non-timeout', pattern_id: null,
      status: 'executing', started_at: Date.now(), completed_at: null,
      created_at: Date.now(), created_by: null, estimated_cost_usd: null,
      actual_cost_usd: null, metadata: null,
    });

    const task = makeTask(taskId, wfId, {
      timeout_seconds: 300,
      max_retries: 1,
      retry_policy: 'exponential',
    });
    insertTask(db, task);

    let callCount = 0;
    const rateLimitThenSucceed = async (): Promise<string> => {
      callCount++;
      if (callCount === 1) {
        throw new Error('rate limit exceeded — retry later');
      }
      return 'ok';
    };

    await runTaskLoop(db, [task], wfId, new Set(), {
      executeTaskFn: rateLimitThenSucceed,
      sleepFn: noSleep,
    });

    const extEvents = db
      .prepare(`SELECT payload_json FROM events WHERE task_id = ? AND type = 'task_timeout_extended'`)
      .all(taskId) as { payload_json: string }[];
    // Rate-limit retry must NOT escalate the timeout
    expect(extEvents).toHaveLength(0);

    db.close();
  });
});
