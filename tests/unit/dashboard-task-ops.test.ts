import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initDb } from '../../src/db/client.js';
import {
  adjustDashboardTaskWithAi,
  buildDashboardTaskRetryDag,
  patchDashboardTask,
  prepareDashboardTaskRetryInPlace,
} from '../../src/mcp/dashboard-task-ops.js';
import { reconstructWorkflowDag } from '../../src/mcp/dashboard-dag-ops.js';
import * as agentRunner from '../../src/v2/agents/runner.js';

function insertWorkflowFixture(dbPath: string) {
  const db = initDb(dbPath);
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows
       (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
        created_by, estimated_cost_usd, actual_cost_usd, metadata)
     VALUES ('wf_task_ops', 'internal', 'Patch and retry dashboard task', NULL, 'failed',
       ?, ?, ?, NULL, NULL, NULL, NULL)`,
  ).run(now - 20_000, now - 1_000, now - 30_000);

  const insertTask = db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
        executor_hint, timeout_seconds, max_retries, retry_count, retry_policy, started_at,
        completed_at, created_at, acceptance_criteria, refine_count, max_refine, refine_feedback,
        model, hitl, execution_mode)
     VALUES (?, 'wf_task_ops', ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, 'exponential',
       ?, ?, ?, ?, 0, 2, NULL, ?, 0, 'ephemeral')`,
  );

  insertTask.run(
    'tk_context',
    'Collect context',
    'tool_call',
    JSON.stringify({ tool_name: 'file-read', args: { path: 'input.md' } }),
    '{"ok":true}',
    'completed',
    '[]',
    null,
    60,
    0,
    now - 20_000,
    now - 18_000,
    now - 20_000,
    null,
    null,
  );
  insertTask.run(
    'tk_failed',
    'Analyze with model',
    'llm_call',
    JSON.stringify({ model_route: { use_case: 'analysis', strategy: 'quality' } }),
    '{"error":"provider timeout"}',
    'failed',
    JSON.stringify(['tk_context']),
    null,
    300,
    1,
    now - 17_000,
    now - 1_000,
    now - 17_000,
    'Explains risk and next step',
    'cc/claude-opus-4-6',
  );
  insertTask.run(
    'tk_downstream',
    'Summarize result',
    'llm_call',
    '{}',
    null,
    'pending',
    JSON.stringify(['tk_failed']),
    null,
    300,
    0,
    null,
    null,
    now - 16_000,
    null,
    null,
  );
  return db;
}

describe('dashboard task operations', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omniforge-dashboard-task-ops-'));
    dbPath = join(tempDir, 'omniforge.db');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('patches task model and model_route for dashboard operator overrides', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      const patched = patchDashboardTask(db, 'wf_task_ops', 'tk_failed', {
        name: 'Re-analyze with model',
        kind: 'cli_spawn',
        model: 'cx/gpt-5.4',
        model_route: { use_case: 'debug', strategy: 'balanced', provider: 'cx' },
        timeout_seconds: 600,
        acceptance_criteria: 'Return structured JSON with risk and mitigation',
      });

      expect(patched).toMatchObject({
        id: 'tk_failed',
        name: 'Re-analyze with model',
        kind: 'cli_spawn',
        model: 'cx/gpt-5.4',
        timeout_seconds: 600,
        acceptance_criteria: 'Return structured JSON with risk and mitigation',
      });
      const row = db.prepare(`SELECT input_json FROM tasks WHERE id = 'tk_failed'`).get() as { input_json: string };
      expect(JSON.parse(row.input_json)).toMatchObject({
        model_route: { use_case: 'debug', strategy: 'balanced', provider: 'cx' },
      });
      const event = db.prepare(`SELECT type FROM events WHERE task_id = 'tk_failed'`).get() as { type: string };
      expect(event.type).toBe('dashboard_task_patched');
    } finally {
      db.close();
    }
  });

  it('normalizes default-ish executor hints when patching a cli task to a cx model', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      const patched = patchDashboardTask(db, 'wf_task_ops', 'tk_failed', {
        kind: 'cli_spawn',
        executor_hint: 'cli:claude-code',
        model: 'cx/gpt-5.4',
      });

      expect(patched).toMatchObject({
        id: 'tk_failed',
        kind: 'cli_spawn',
        model: 'cx/gpt-5.4',
        executor_hint: 'cli:codex',
      });
      const event = db
        .prepare(`SELECT payload_json FROM events WHERE task_id = 'tk_failed' ORDER BY id DESC LIMIT 1`)
        .get() as { payload_json: string };
      expect(JSON.parse(event.payload_json)).toMatchObject({ executor_hint: 'cli:codex' });
    } finally {
      db.close();
    }
  });

  it('rejects patching a task that is currently running', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      db.prepare(`UPDATE tasks SET status = 'running' WHERE id = 'tk_failed'`).run();
      expect(() => patchDashboardTask(db, 'wf_task_ops', 'tk_failed', {
        model: 'cx/gpt-5.4',
      })).toThrow(/running task/);
    } finally {
      db.close();
    }
  });

  it('normalizes default-ish executor hints when retrying a historical cx cli task in place', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      db.prepare(
        `UPDATE tasks
            SET kind = 'cli_spawn',
                executor_hint = 'cli:claude-code',
                model = 'cx/gpt-5.4'
          WHERE id = 'tk_failed'`,
      ).run();

      prepareDashboardTaskRetryInPlace(db, 'wf_task_ops', 'tk_failed', { mode: 'task' });

      const row = db
        .prepare(`SELECT kind, model, executor_hint, status FROM tasks WHERE id = 'tk_failed'`)
        .get() as { kind: string; model: string | null; executor_hint: string | null; status: string };
      expect(row).toEqual({
        kind: 'cli_spawn',
        model: 'cx/gpt-5.4',
        executor_hint: 'cli:codex',
        status: 'pending',
      });
    } finally {
      db.close();
    }
  });

  it('builds a retry DAG for a failed task and downstream tasks', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      const retry = buildDashboardTaskRetryDag(db, 'wf_task_ops', 'tk_failed', { mode: 'downstream' });

      expect(retry).toMatchObject({
        source_workflow_id: 'wf_task_ops',
        source_task_id: 'tk_failed',
        retry_scope: 'downstream',
        workspace: 'internal',
        objective: 'Patch and retry dashboard task',
      });
      expect(retry.dag.tasks.map((task) => task.name)).toEqual([
        'Analyze with model',
        'Summarize result',
      ]);
      expect(retry.dag.tasks[0]).toMatchObject({
        id: 't1',
        depends_on: [],
        model: 'cc/claude-opus-4-6',
        model_route: { use_case: 'analysis', strategy: 'quality' },
      });
      expect(retry.dag.tasks[1]).toMatchObject({
        id: 't2',
        depends_on: ['t1'],
      });
      expect(retry.omitted_dependencies).toEqual([
        { task_id: 't1', omitted: ['t0'] },
      ]);
    } finally {
      db.close();
    }
  });

  it('keeps an explicit retry objective override when provided by the dashboard', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      const retry = buildDashboardTaskRetryDag(db, 'wf_task_ops', 'tk_failed', {
        mode: 'task',
        objective: 'Retry only the failed analysis task',
      });

      expect(retry.objective).toBe('Retry only the failed analysis task');
      expect(retry.retry_scope).toBe('task');
      expect(retry.dag.tasks.map((task) => task.name)).toEqual(['Analyze with model']);
    } finally {
      db.close();
    }
  });

  it('prepares in-place retry by resetting selected tasks on the same workflow', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      const retry = prepareDashboardTaskRetryInPlace(db, 'wf_task_ops', 'tk_failed', { mode: 'downstream' });

      expect(retry).toMatchObject({
        source_workflow_id: 'wf_task_ops',
        source_task_id: 'tk_failed',
        retry_scope: 'downstream',
        task_ids: ['tk_failed', 'tk_downstream'],
        task_count: 2,
      });
      const workflow = db.prepare(`SELECT status, completed_at FROM workflows WHERE id = 'wf_task_ops'`).get() as {
        status: string;
        completed_at: number | null;
      };
      expect(workflow).toEqual({ status: 'executing', completed_at: null });

      const rows = db.prepare(
        `SELECT id, status, started_at, completed_at, output_json
           FROM tasks
          WHERE workflow_id = 'wf_task_ops'
          ORDER BY created_at ASC`,
      ).all() as Array<{ id: string; status: string; started_at: number | null; completed_at: number | null; output_json: string | null }>;
      expect(rows).toEqual([
        expect.objectContaining({ id: 'tk_context', status: 'completed', output_json: '{"ok":true}' }),
        expect.objectContaining({ id: 'tk_failed', status: 'pending', started_at: null, completed_at: null, output_json: null }),
        expect.objectContaining({ id: 'tk_downstream', status: 'pending', started_at: null, completed_at: null, output_json: null }),
      ]);
      const event = db.prepare(
        `SELECT type, payload_json
           FROM events
          WHERE workflow_id = 'wf_task_ops'
          ORDER BY id DESC
          LIMIT 1`,
      ).get() as { type: string; payload_json: string };
      expect(event.type).toBe('dashboard_task_retry_started');
      expect(JSON.parse(event.payload_json)).toMatchObject({ selected_task_ids: ['tk_failed', 'tk_downstream'] });
    } finally {
      db.close();
    }
  });

  it('prepares in-place retry for all failed tasks without selecting downstream tasks', () => {
    const db = insertWorkflowFixture(dbPath);
    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO tasks
           (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
            executor_hint, timeout_seconds, max_retries, retry_count, retry_policy, started_at,
            completed_at, created_at, acceptance_criteria, refine_count, max_refine, refine_feedback,
            model, hitl, execution_mode)
         VALUES ('tk_parallel_failed', 'wf_task_ops', 'Build parallel panel', 'cli_spawn', '{}',
           '{"error":"lease expired"}', 'failed', ?, 'cli:codex', 300, 3, 1, 'exponential',
           ?, ?, ?, 'Build the panel', 0, 2, NULL, 'cx/gpt-5.4', 0, 'ephemeral')`,
      ).run(JSON.stringify(['tk_context']), now - 15_000, now - 2_000, now - 15_000);
      db.prepare(
        `UPDATE tasks
            SET status = 'completed',
                output_json = '{"ok":"downstream should not be reset"}',
                completed_at = ?
          WHERE id = 'tk_downstream'`,
      ).run(now - 500);

      const retry = prepareDashboardTaskRetryInPlace(db, 'wf_task_ops', 'tk_failed', { mode: 'failed' });

      expect(retry).toMatchObject({
        source_workflow_id: 'wf_task_ops',
        source_task_id: 'tk_failed',
        retry_scope: 'failed',
        task_ids: ['tk_failed', 'tk_parallel_failed'],
        task_count: 2,
      });

      const rows = db.prepare(
        `SELECT id, status, output_json, completed_at
           FROM tasks
          WHERE workflow_id = 'wf_task_ops'
          ORDER BY created_at ASC`,
      ).all() as Array<{ id: string; status: string; output_json: string | null; completed_at: number | null }>;
      expect(rows).toEqual([
        expect.objectContaining({ id: 'tk_context', status: 'completed', output_json: '{"ok":true}' }),
        expect.objectContaining({ id: 'tk_failed', status: 'pending', output_json: null, completed_at: null }),
        expect.objectContaining({
          id: 'tk_downstream',
          status: 'completed',
          output_json: '{"ok":"downstream should not be reset"}',
        }),
        expect.objectContaining({ id: 'tk_parallel_failed', status: 'pending', output_json: null, completed_at: null }),
      ]);

      const event = db.prepare(
        `SELECT type, task_id, payload_json
           FROM events
          WHERE workflow_id = 'wf_task_ops'
          ORDER BY id DESC
          LIMIT 1`,
      ).get() as { type: string; task_id: string; payload_json: string };
      expect(event.type).toBe('dashboard_task_retry_started');
      expect(event.task_id).toBe('tk_failed');
      expect(JSON.parse(event.payload_json)).toMatchObject({
        mode: 'failed',
        selected_task_ids: ['tk_failed', 'tk_parallel_failed'],
        task_count: 2,
      });
    } finally {
      db.close();
    }
  });

  it('backfills execution_plan context when retrying an older plan-review task', () => {
    const db = insertWorkflowFixture(dbPath);
    try {
      db.prepare(
        `UPDATE tasks
            SET name = 'Review execution plan',
                acceptance_criteria = 'Plan lists all subsequent tasks with their kinds and deliverables',
                input_json = ?
          WHERE id = 'tk_failed'`,
      ).run(JSON.stringify({ objective: 'legacy run without execution plan' }));

      prepareDashboardTaskRetryInPlace(db, 'wf_task_ops', 'tk_failed', { mode: 'task' });

      const row = db.prepare(`SELECT input_json FROM tasks WHERE id = 'tk_failed'`).get() as { input_json: string };
      const input = JSON.parse(row.input_json) as Record<string, unknown>;
      expect(input).toMatchObject({
        execution_plan: {
          current_task_id: 't1',
          tasks: [
            expect.objectContaining({ id: 't0', name: 'Collect context', kind: 'tool_call' }),
            expect.objectContaining({ id: 't1', name: 'Review execution plan', kind: 'llm_call' }),
            expect.objectContaining({ id: 't2', name: 'Summarize result', kind: 'llm_call' }),
          ],
        },
      });
    } finally {
      db.close();
    }
  });

  it('uses AI adjustment to patch only the selected failed task', async () => {
    vi.stubEnv('OMNIFORGE_USE_PERSONAS', 'false');
    const db = insertWorkflowFixture(dbPath);
    vi.spyOn(agentRunner, 'runAgent');
    const planner = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'plan_ready',
      dag: {
        tasks: [
          {
            id: 't1',
            name: 'Analyze with resilient CLI agent',
            kind: 'cli_spawn',
            depends_on: [],
            executor_hint: 'cli:codex',
            model: 'codex/gpt-5.4-codex',
            timeout_seconds: 900,
            acceptance_criteria: 'Produce a concise JSON object with risk and mitigation fields',
          },
        ],
      },
    }));

    try {
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_task_ops', 'tk_failed', 'task_failed', '{"error":"provider timeout"}', ?)`,
      ).run(Date.now());

      const result = await adjustDashboardTaskWithAi(db, 'wf_task_ops', 'tk_failed', {
        instruction: 'Switch this task to a coding CLI agent and increase timeout.',
        apply: true,
      }, planner);

      expect(agentRunner.runAgent).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        source_workflow_id: 'wf_task_ops',
        source_task_id: 'tk_failed',
        dag_task_id: 't1',
        applied: true,
        discarded_task_count: 0,
        suggested_task: {
          id: 't1',
          name: 'Analyze with resilient CLI agent',
          depends_on: ['t0'],
        },
        task: {
          id: 'tk_failed',
          name: 'Analyze with resilient CLI agent',
          kind: 'cli_spawn',
          model: 'codex/gpt-5.4-codex',
          timeout_seconds: 900,
        },
      });
      expect(planner.mock.calls[0]?.[0].objective).toContain('provider timeout');

      const downstream = db.prepare(`SELECT name, kind, model FROM tasks WHERE id = 'tk_downstream'`).get() as {
        name: string;
        kind: string;
        model: string | null;
      };
      expect(downstream).toEqual({
        name: 'Summarize result',
        kind: 'llm_call',
        model: null,
      });
      const event = db.prepare(
        `SELECT type FROM events WHERE task_id = 'tk_failed' ORDER BY id DESC LIMIT 1`,
      ).get() as { type: string };
      expect(event.type).toBe('dashboard_task_ai_adjusted');
    } finally {
      db.close();
    }
  });

  it('with OMNIFORGE_USE_PERSONAS uses REFINER_PERSONA and skips dashboard planner', async () => {
    vi.stubEnv('OMNIFORGE_USE_PERSONAS', 'true');
    const db = insertWorkflowFixture(dbPath);
    const replay = reconstructWorkflowDag(db, 'wf_task_ops');
    const refinedTasks = replay.dag.tasks.map((t) =>
      t.id === 't1'
        ? {
            ...t,
            name: 'Analyze with resilient CLI agent',
            kind: 'cli_spawn' as const,
            executor_hint: 'cli:codex',
            model: 'codex/gpt-5.4-codex',
            timeout_seconds: 900,
            acceptance_criteria: 'Produce a concise JSON object with risk and mitigation fields',
          }
        : t,
    );
    vi.spyOn(agentRunner, 'runAgent').mockResolvedValue({
      tasks: refinedTasks,
      changelog: ['t1: switch to cli_spawn + codex for resilient execution'],
      preserved_task_ids: refinedTasks.map((x) => x.id),
      added_task_ids: [],
      removed_task_ids: [],
      rationale: 'Operator asked for CLI resilience.',
    });
    const planner = vi.fn();

    try {
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_task_ops', 'tk_failed', 'task_failed', '{"error":"provider timeout"}', ?)`,
      ).run(Date.now());

      const result = await adjustDashboardTaskWithAi(db, 'wf_task_ops', 'tk_failed', {
        instruction: 'Switch this task to a coding CLI agent and increase timeout.',
        apply: true,
      }, planner);

      expect(planner).not.toHaveBeenCalled();
      expect(agentRunner.runAgent).toHaveBeenCalledTimes(1);
      expect(result.refiner_changelog).toEqual([
        't1: switch to cli_spawn + codex for resilient execution',
      ]);
      expect(result).toMatchObject({
        source_workflow_id: 'wf_task_ops',
        source_task_id: 'tk_failed',
        dag_task_id: 't1',
        applied: true,
        discarded_task_count: 2,
        suggested_task: {
          id: 't1',
          name: 'Analyze with resilient CLI agent',
          depends_on: ['t0'],
        },
        task: {
          id: 'tk_failed',
          name: 'Analyze with resilient CLI agent',
          kind: 'cli_spawn',
          model: 'codex/gpt-5.4-codex',
          timeout_seconds: 900,
        },
      });
    } finally {
      db.close();
    }
  });

  it('falls back to legacy planner when REFINER_PERSONA throws under OMNIFORGE_USE_PERSONAS', async () => {
    vi.stubEnv('OMNIFORGE_USE_PERSONAS', 'true');
    const db = insertWorkflowFixture(dbPath);
    vi.spyOn(agentRunner, 'runAgent').mockRejectedValue(new Error('omniroute down'));
    const planner = vi.fn().mockResolvedValue(JSON.stringify({
      status: 'plan_ready',
      dag: {
        tasks: [
          {
            id: 't1',
            name: 'Fallback patched task',
            kind: 'llm_call',
            depends_on: [],
            timeout_seconds: 120,
          },
        ],
      },
    }));

    try {
      const result = await adjustDashboardTaskWithAi(db, 'wf_task_ops', 'tk_failed', {
        instruction: 'Recover via legacy path.',
        apply: true,
      }, planner);

      expect(agentRunner.runAgent).toHaveBeenCalled();
      expect(planner).toHaveBeenCalledTimes(1);
      expect(result.suggested_task?.name).toBe('Fallback patched task');
      expect(result.refiner_changelog).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
