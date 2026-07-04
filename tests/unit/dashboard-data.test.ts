import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initDb } from '../../src/db/client.js';
import { buildDashboardSnapshot } from '../../src/mcp/dashboard-data.js';

describe('dashboard data snapshot', () => {
  let tempDir: string;
  let dbPath: string;
  let originalDbPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'omniforge-dashboard-data-'));
    dbPath = join(tempDir, 'omniforge.db');
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
  });

  afterEach(async () => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('builds workflow and task kanban data with progress and cost totals', async () => {
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      const projectRoot = join(tempDir, 'internal-project');
      const projectCwd = join(projectRoot, 'packages', 'app');
      await mkdir(projectCwd, { recursive: true });
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, NULL, NULL, NULL, NULL)`,
      ).run('wf_live', 'internal', 'Auditar PR e gerar relatório', 'executing', now - 12_000, now - 20_000);
      db.prepare(
        `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
         VALUES (?, ?, ?, ?)`,
      ).run('internal', now - 30_000, 'test', JSON.stringify({
        software_target: {
          project_root: projectRoot,
          cwd: 'packages/app',
          base_ref: 'main',
        },
      }));
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run('wf_done', 'internal', 'Resumo mensal', 'completed', now - 60_000, now - 5_000, now - 90_000);
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run('wf_fail', 'internal', 'Workflow com quota bloqueada', 'failed', now - 50_000, now - 49_000, now - 30_000);

      const insertTask = db.prepare(
        `INSERT INTO tasks
           (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
            executor_hint, timeout_seconds, max_retries, retry_count, retry_policy, started_at,
            completed_at, created_at, acceptance_criteria, refine_count, max_refine, refine_feedback,
            model, hitl, execution_mode)
         VALUES (?, ?, ?, ?, '{}', NULL, ?, '[]', NULL, 300, 3, ?, 'exponential', ?, ?, ?, NULL, 0, 2, NULL, ?, 0, 'ephemeral')`,
      );
      insertTask.run('tk_a', 'wf_live', 'Coletar contexto', 'tool_call', 'completed', 0, now - 19_000, now - 15_000, now - 19_000, null);
      db.prepare(`UPDATE tasks SET input_json = ? WHERE id = 'tk_a'`)
        .run(JSON.stringify({
          tool_name: 'file-write',
          args: { path: 'smoke.txt', content: 'ok' },
          execution_context: {
            workspace_root: 'C:/tmp/workspaces/internal',
            run_root: 'C:/tmp/workspaces/internal/runs/wf_live',
            project_root: 'C:/tmp/workspaces/internal/runs/wf_live',
            cwd: 'C:/tmp/workspaces/internal/runs/wf_live',
            output_dir: 'C:/tmp/workspaces/internal/runs/wf_live',
            base_ref: null,
            source_project_root: 'C:/tmp/workspaces/internal/runs/wf_live',
            source_cwd: 'C:/tmp/workspaces/internal/runs/wf_live',
            worktree_root: null,
            worktree_branch: null,
            lineage: {
              lane: 'software',
              source: 'workspace_run',
              workspace: 'internal',
              workflow_id: 'wf_live',
              task_id: 'tk_a',
            },
          },
        }));
      db.prepare(`UPDATE tasks SET output_json = ? WHERE id = 'tk_a'`)
        .run(JSON.stringify({ path: 'smoke.txt', status: 'written' }));
      insertTask.run('tk_b', 'wf_live', 'Analisar riscos', 'llm_call', 'running', 1, now - 10_000, null, now - 18_000, 'cc/claude-sonnet');
      insertTask.run('tk_c', 'wf_live', 'Consolidar saída', 'llm_call', 'pending', 0, null, null, now - 17_000, null);
      insertTask.run('tk_d', 'wf_done', 'Escrever sumário', 'llm_call', 'completed', 0, now - 80_000, now - 6_000, now - 80_000, 'cx/gpt');
      insertTask.run('tk_failed_ui', 'wf_fail', 'Task com erro localizado', 'llm_call', 'failed', 1, now - 29_500, now - 28_000, now - 29_500, 'cc/claude-sonnet');

      db.prepare(
        `INSERT INTO model_calls
           (id, workflow_id, task_id, model, provider, input_tokens, output_tokens, cost_usd, latency_ms, source, created_at)
         VALUES ('mc_1', 'wf_live', 'tk_b', 'cc/claude-sonnet', 'cc', 100, 30, 0.42, 1400, 'omniroute', ?)`,
      ).run(now - 9_000);
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_live', 'tk_b', 'task_started', '{}', ?)`,
      ).run(now - 8_000);
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_fail', NULL, 'workflow_quota_blocked', '{"remaining_pct":0,"workspace":"internal"}', ?)`,
      ).run(now - 29_000);
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_fail', NULL, 'workflow_background_error', '{"error":"Workflow blocked: quota not allowed (0% remaining)"}', ?)`,
      ).run(now - 28_000);
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_fail', NULL, 'workflow_background_error', '{"error":"Task [tk_failed_ui] failed: provider timeout"}', ?)`,
      ).run(now - 27_000);
      db.prepare(
        `INSERT INTO trace_spans
           (id, workflow_id, task_id, parent_span_id, name, kind, status,
            started_at, ended_at, duration_ms, attributes_json)
         VALUES ('sp_task_b', 'wf_live', 'tk_b', NULL, 'Analisar riscos', 'task', 'running',
            ?, NULL, NULL, '{"phase":"execute"}')`,
      ).run(now - 10_000);
      db.prepare(
        `INSERT INTO subagent_runs
           (run_id, task_id, workflow_id, parent_run_id, depth, model, task_text, status,
            result_text, error_msg, cleanup, spawn_mode, timeout_seconds,
            created_at, started_at, ended_at, archive_after_ms)
         VALUES ('sa_b1', 'tk_b', 'wf_live', NULL, 0, 'cc/claude-sonnet', 'Mapear riscos no código',
            'running', NULL, NULL, 'keep', 'run', 300, ?, ?, NULL, NULL)`,
      ).run(now - 9_500, now - 9_200);
      db.prepare(
        `INSERT INTO subagent_messages
           (id, workflow_id, from_task_id, to_task_id, message_type, payload_json, status, created_at, delivered_at)
         VALUES ('sm_query', 'wf_live', 'tk_c', 'tk_b', 'query',
            ?, 'delivered', ?, ?)`,
      ).run(
        JSON.stringify({
          fenced: '<subagent-message source="tk_c" type="query">Quais riscos você já encontrou?</subagent-message>',
          raw: { question: 'Quais riscos você já encontrou?' },
        }),
        now - 9_000,
        now - 8_500,
      );
      db.prepare(
        `INSERT INTO subagent_messages
           (id, workflow_id, from_task_id, to_task_id, message_type, payload_json, status, created_at, delivered_at)
         VALUES ('sm_announce', 'wf_live', 'tk_b', NULL, 'announcement',
            ?, 'pending', ?, NULL)`,
      ).run(
        JSON.stringify({
          fenced: '<subagent-message source="tk_b" type="announcement">Encontrei 3 riscos críticos.</subagent-message>',
          raw: { topic: 'risk-scan', summary: 'Encontrei 3 riscos críticos.' },
        }),
        now - 8_000,
      );
      db.prepare(
        `INSERT INTO artifacts
           (id, workflow_id, task_id, workspace, kind, content_path, content_inline,
            size_bytes, hash_sha256, created_at)
         VALUES ('art_a', 'wf_live', 'tk_a', 'internal', 'text', NULL, 'artifact body', 13, 'abc', ?)`,
      ).run(now - 14_000);
      db.prepare(
        `INSERT INTO hitl_gates
           (id, workflow_id, task_id, gate_type, prompt, context_json, status, decision,
            decision_reason, channel, created_at, decided_at)
         VALUES ('hg_review', 'wf_live', 'tk_b', 'review', 'Approve?', '{}', 'pending',
            NULL, NULL, 'dashboard', ?, NULL)`,
      ).run(now - 11_000);
      db.prepare(
        `INSERT INTO eval_runs
           (id, workspace, suite_name, status, score, case_count, created_at, completed_at)
         VALUES ('er_1', 'internal', 'golden-smoke', 'completed', 0.75, 4, ?, ?)`,
      ).run(now - 7_000, now - 6_500);

      const snapshot = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });

      expect(snapshot.summary.workflow_count).toBe(3);
      expect(snapshot.summary.active_workflow_count).toBe(1);
      expect(snapshot.summary.total_cost_usd).toBe(0.42);
      expect(snapshot.kanban.workflows.executing.map((wf) => wf.id)).toEqual(['wf_live']);
      expect(snapshot.kanban.workflows.completed.map((wf) => wf.id)).toEqual(['wf_done']);
      expect(snapshot.workflows[0]).toMatchObject({
        id: 'wf_live',
        progress_pct: 33,
        task_counts: { completed: 1, running: 1, pending: 1 },
        model_cost_usd: 0.42,
        latest_event_type: 'task_started',
      });
      expect(snapshot.workflows.find((workflow) => workflow.id === 'wf_fail')).toMatchObject({
        status: 'failed',
        latest_event_type: 'workflow_background_error',
        latest_error: {
          type: 'workflow_background_error',
          message: 'Task [tk_failed_ui] failed: provider timeout',
        },
      });
      expect(snapshot.kanban.tasks['wf_fail'].failed[0]).toMatchObject({
        id: 'tk_failed_ui',
        events: [expect.objectContaining({ type: 'workflow_background_error' })],
      });
      expect(snapshot.timelines['wf_fail']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ task_id: 'tk_failed_ui', type: 'workflow_background_error' }),
        ]),
      );
      expect(snapshot.kanban.tasks['wf_live'].running.map((task) => task.id)).toEqual(['tk_b']);
      expect(snapshot.kanban.tasks['wf_live'].completed[0]).toMatchObject({
        id: 'tk_a',
        tool_name: 'file-write',
        execution_context: expect.objectContaining({
          cwd: 'C:/tmp/workspaces/internal/runs/wf_live',
          output_dir: 'C:/tmp/workspaces/internal/runs/wf_live',
        }),
        output_preview: expect.stringContaining('smoke.txt'),
        artifacts: [
          expect.objectContaining({ id: 'art_a', kind: 'text', size_bytes: 13 }),
        ],
      });
      expect(snapshot.kanban.tasks['wf_live'].running[0]).toMatchObject({
        id: 'tk_b',
        events: [expect.objectContaining({ type: 'task_started' })],
        model_calls: [expect.objectContaining({ model: 'cc/claude-sonnet', cost_usd: 0.42 })],
        trace_spans: [expect.objectContaining({ id: 'sp_task_b', kind: 'task', status: 'running' })],
        subagent_runs: [
          expect.objectContaining({ run_id: 'sa_b1', status: 'running', depth: 0 }),
        ],
        mailbox: expect.arrayContaining([
          expect.objectContaining({ id: 'sm_query', direction: 'inbox', message_type: 'query' }),
          expect.objectContaining({ id: 'sm_announce', direction: 'outbox', message_type: 'announcement' }),
        ]),
      });
      expect(snapshot.kanban.tasks['wf_live'].pending[0]).toMatchObject({
        id: 'tk_c',
        mailbox: expect.arrayContaining([
          expect.objectContaining({ id: 'sm_announce', direction: 'inbox', scope: 'broadcast' }),
        ]),
      });
      expect(snapshot.timelines['wf_live']).toEqual([
        expect.objectContaining({ task_id: 'tk_b', type: 'task_started' }),
      ]);
      expect(snapshot.pending_gates).toEqual([
        expect.objectContaining({ id: 'hg_review', workflow_id: 'wf_live', task_id: 'tk_b' }),
      ]);
      expect(snapshot.workspace_profiles).toEqual(expect.arrayContaining([
        expect.objectContaining({
          workspace: 'internal',
          software_target: expect.objectContaining({
            project_root: projectRoot,
            cwd: projectCwd,
            base_ref: 'main',
          }),
        }),
      ]));
      expect(snapshot.recent_eval_runs).toEqual([
        expect.objectContaining({ id: 'er_1', suite_name: 'golden-smoke', score: 0.75 }),
      ]);
    } finally {
      db.close();
    }
  });

  it('attaches recent task errors even when a workflow has more than 500 events', async () => {
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES ('wf_long', 'internal', 'Long workflow', NULL, 'failed', ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(now - 20_000, now, now - 30_000);
      db.prepare(
        `INSERT INTO tasks
           (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
            executor_hint, timeout_seconds, max_retries, retry_count, retry_policy, started_at,
            completed_at, created_at, acceptance_criteria, refine_count, max_refine, refine_feedback,
            model, hitl, execution_mode)
         VALUES ('tk_failed', 'wf_long', 'Failed task', 'cli_spawn', '{}', 'worker output',
            'failed', '[]', 'cli:claude-code', 300, 3, 0, 'exponential', ?, ?, ?,
            'src/data/mock.ts exports mockWorkspace', 0, 2, NULL, 'cx/gpt-5.4', 0, 'ephemeral')`,
      ).run(now - 10_000, now, now - 10_000);

      const insertEvent = db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_long', NULL, 'workflow_tick', '{}', ?)`,
      );
      for (let i = 0; i < 520; i++) insertEvent.run(now - 9_000 + i);

      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES ('wf_long', 'tk_failed', 'task_review_timeout',
            '{"reason":"timeout","error":"Reviewer timed out after 120000ms"}', ?)`,
      ).run(now + 1);

      const snapshot = buildDashboardSnapshot(db, { workspace: 'internal', limit: 10 });
      expect(snapshot.kanban.tasks['wf_long'].failed[0]).toMatchObject({
        id: 'tk_failed',
        events: [
          expect.objectContaining({
            type: 'task_review_timeout',
            payload_preview: expect.stringContaining('Reviewer timed out'),
          }),
        ],
      });
    } finally {
      db.close();
    }
  });
});
