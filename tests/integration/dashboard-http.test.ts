import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { initDb } from '../../src/db/client.js';
import { resolveToken, startHttpMcpServer, type ShutdownFn } from '../../src/mcp/http-server.js';
import { setDashboardPlannerForTests } from '../../src/mcp/dashboard-plan-ops.js';
import { removeTempDirSafe } from './_temp-dir.js';

// P3 test-harness stability: this suite seeds a fresh WAL DB and boots the
// HTTP daemon in beforeAll, which can exceed the global 15s hookTimeout on
// slow/Windows runners. afterAll closes the daemon's SQLite connection and
// then deletes the temp dir — on Windows the WAL/SHM handle release lags, so
// teardown uses removeTempDirSafe to avoid the flaky afterAll EPERM. Give
// both hooks a generous explicit budget.
const HOOK_TIMEOUT_MS = 60_000;

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not get address'));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

async function waitForWorkflowSettled(port: number, token: string, workflowId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}&workspace=internal`);
    const body = await res.json() as {
      kanban: { workflows: Record<string, Array<{ id: string }>> };
    };
    const executing = body.kanban.workflows.executing ?? [];
    const pending = body.kanban.workflows.pending ?? [];
    const stillActive = [...executing, ...pending].some((workflow) => workflow.id === workflowId);
    if (!stillActive) return;
    await sleep(100);
  }
  throw new Error(`Workflow did not settle in time: ${workflowId}`);
}

function firstDashboardAsset(html: string, extension: 'js' | 'css'): string {
  const match = html.match(new RegExp(`(?:src|href)="(/dashboard/(?:assets/[^"]+|(?:app|styles))\\.${extension})"`));
  if (!match?.[1]) throw new Error(`Dashboard ${extension} asset not found in HTML`);
  return match[1];
}

describe('HTTP dashboard routes', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-dashboard-http-${Date.now()}`);
  const dbPath = join(dataDir, 'omniforge.db');
  const workspaceProjectRoot = join(dataDir, 'software-project');
  const workspaceProjectCwd = join(workspaceProjectRoot, 'packages', 'app');
  let originalDbPath: string | undefined;
  let originalUsePersonas: string | undefined;
  let originalDaemonAuth: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(workspaceProjectCwd, { recursive: true });
    originalDbPath = process.env.DB_PATH;
    originalUsePersonas = process.env.OMNIFORGE_USE_PERSONAS;
    originalDaemonAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    process.env.DB_PATH = dbPath;
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    setDashboardPlannerForTests(async (raw) => JSON.stringify({
      status: 'plan_ready',
      workspace: raw.workspace,
      objective: raw.objective,
      task_count: 1,
      pattern_used: null,
      skill_applied: null,
      execution_mode_source: 'default',
      plan: [{
        id: 't0',
        name: 'Planned from dashboard',
        kind: 'tool_call',
        depends_on: [],
        tool_name: 'file-write',
        args: { path: 'planned-dashboard.txt', content: 'ok' },
        timeout_seconds: 60,
      }],
      dag_json: JSON.stringify({
        tasks: [{
          id: 't0',
          name: 'Planned from dashboard',
          kind: 'tool_call',
          depends_on: [],
          tool_name: 'file-write',
          args: { path: 'planned-dashboard.txt', content: 'ok' },
          timeout_seconds: 60,
        }],
      }),
    }));

    const db = initDb(dbPath);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES ('wf_dash', 'internal', 'Dashboard smoke', NULL, 'executing', ?, NULL, ?, NULL, NULL, NULL, NULL)`,
      ).run(now - 2_000, now - 3_000);
      db.prepare(
        `INSERT INTO tasks
           (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
            executor_hint, timeout_seconds, max_retries, retry_count, retry_policy, started_at,
            completed_at, created_at, acceptance_criteria, refine_count, max_refine, refine_feedback,
            model, hitl, execution_mode)
         VALUES ('tk_dash_write', 'wf_dash', 'Write smoke file', 'tool_call',
            '{"workspace":"internal","tool_name":"file-write","args":{"path":"dash.txt","content":"ok"}}',
            '{}', 'completed', '[]', NULL, 60, 3, 0, 'exponential',
            ?, ?, ?, NULL, 0, 2, NULL, NULL, 0, 'ephemeral')`,
      ).run(now - 2_000, now - 1_500, now - 2_000);
      db.prepare(
        `INSERT INTO model_calls
           (id, workflow_id, task_id, model, provider, input_tokens, output_tokens,
            cost_usd, latency_ms, source, created_at)
         VALUES
           ('mc_dash_1', 'wf_dash', 'tk_dash_write', 'cc/claude-sonnet-4-6', 'cc',
            100, 40, 0.25, 1200, 'executor', ?),
           ('mc_dash_2', 'wf_dash', NULL, 'cx/gpt-5.5', 'cx',
            20, 10, 0.05, 800, 'reviewer', ?)`,
      ).run(now - 1_400, now - 1_300);
      db.prepare(
        `INSERT INTO trace_spans
           (id, workflow_id, task_id, parent_span_id, name, kind, status,
            started_at, ended_at, duration_ms, attributes_json)
         VALUES
           ('sp_wf_dash', 'wf_dash', NULL, NULL, 'workflow', 'workflow', 'ok', ?, ?, 1500, ?),
           ('sp_task_dash', 'wf_dash', 'tk_dash_write', 'sp_wf_dash', 'Write smoke file', 'task', 'ok', ?, ?, 900, ?),
           ('sp_llm_dash', 'wf_dash', 'tk_dash_write', 'sp_task_dash', 'llm_call:cc/claude-sonnet', 'llm_call', 'ok', ?, ?, 500, ?)`,
      ).run(
        now - 2_000,
        now - 500,
        JSON.stringify({ objective: 'Dashboard smoke', workspace: 'internal' }),
        now - 1_800,
        now - 900,
        JSON.stringify({ executor_hint: 'tool_call' }),
        now - 1_700,
        now - 1_200,
        JSON.stringify({ output_tokens: 12 }),
      );
    } finally {
      db.close();
    }

    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await shutdown();
    setDashboardPlannerForTests(null);
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalUsePersonas === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = originalUsePersonas;
    if (originalDaemonAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalDaemonAuth;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    // shutdown() closes the daemon's SQLite connection; the per-test initDb
    // connections each close in their own finally. Give Windows time to
    // release the WAL/SHM file handles before removing the dir, then delete
    // with the retry + swallow safety net (afterAll EPERM was the P3 flake).
    await sleep(200);
    removeTempDirSafe(dataDir);
  }, HOOK_TIMEOUT_MS);

  it('requires auth for the dashboard shell', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).toBe(401);
  });

  it('redirects the authenticated root path to the dashboard shell', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/dashboard?token=${token}`);
  });

  it('serves the dashboard shell and assets with the daemon token', async () => {
    const handshake = await fetch(`http://127.0.0.1:${port}/dashboard?token=${token}`, { redirect: 'manual' });
    expect(handshake.status).toBe(302);
    expect(handshake.headers.get('location')).toBe('/dashboard');
    expect(handshake.headers.get('set-cookie')).toContain('omniforge_daemon_token=');

    const html = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toContain('text/html');
    const htmlText = await html.text();
    expect(htmlText).toMatch(/Omniforge .*Plan, run, intervene|Omniforge Operations|<div id="root"><\/div>/);

    const script = await fetch(`http://127.0.0.1:${port}${firstDashboardAsset(htmlText, 'js')}`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('application/javascript');
    const bundleText = await script.text();
    // Phase 2 (A3): vendor code-splitting moved React into react-vendor.js;
    // the entry chunk (index.js) is now app-source-only. Check for the
    // vendor chunk reference (import path) OR any React-related token that
    // persists in the app layer, plus the Vite module-preload wiring that
    // guarantees this is a real split bundle rather than an empty stub.
    expect(bundleText).toMatch(/react(?:-vendor)?|React|modulepreload/i);
    // Vite-emitted bundles contain dynamic-import wiring or module-preload
    // setup for vendor chunks. Either guarantees this is a real ES module bundle.
    expect(bundleText).toMatch(/(import\s*\(|modulepreload|Symbol\.for\("react)/);
    // Sanity floor: the dashboard JS bundle is mega-bytes in size when
    // built — anything under ~50KB is a stub regression.
    expect(bundleText.length).toBeGreaterThan(50_000);
  });

  it('returns an empty favicon response without polluting browser console with a 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(res.status).toBe(204);
  });

  it('sets a local dashboard cookie so refresh works after the URL token is removed', async () => {
    const first = await fetch(`http://127.0.0.1:${port}/dashboard?token=${token}`, { redirect: 'manual' });
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toBe('/dashboard');
    expect(first.headers.get('set-cookie')).toContain('omniforge_daemon_token=');

    const refresh = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(refresh.status).toBe(200);
  });

  it('auto-provisions the implicit internal workspace with a git-able software target', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}&workspace=internal`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      workspace_profiles: Array<{
        workspace: string;
        software_target: {
          project_root: string;
          cwd?: string;
          base_ref?: string | null;
        } | null;
      }>;
    };
    const expectedRoot = join(dataDir, 'workspaces', 'internal', 'project');
    const profile = body.workspace_profiles.find((item) => item.workspace === 'internal');
    expect(profile?.software_target?.project_root).toBe(expectedRoot);
    expect(existsSync(join(expectedRoot, '.git'))).toBe(true);
  });

  it('returns dashboard JSON for the kanban UI', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}&workspace=internal`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      summary: { workflow_count: number; active_workflow_count: number };
      kanban: { workflows: { executing: Array<{ id: string }> } };
    };
    expect(body.summary.workflow_count).toBe(1);
    expect(body.summary.active_workflow_count).toBe(1);
    expect(body.kanban.workflows.executing).toEqual([
      expect.objectContaining({ id: 'wf_dash' }),
    ]);
  });

  it('returns cost aggregation for a dashboard run', async () => {
    const previousBudget = process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.5';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/run/wf_dash/cost?token=${token}`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        summary: { workflow_id: string; call_count: number; total_cost_usd: number };
        byTask: Array<{ task_id: string | null; task_name: string | null; total_cost_usd: number }>;
        byModel: Array<{ model: string; provider: string | null; total_cost_usd: number }>;
        cap: number | null;
        currency: string;
        generated_at: string;
      };

      expect(body.summary).toMatchObject({
        workflow_id: 'wf_dash',
        call_count: 2,
        total_cost_usd: 0.3,
      });
      expect(body.byTask).toEqual([
        expect.objectContaining({ task_id: 'tk_dash_write', task_name: 'Write smoke file', total_cost_usd: 0.25 }),
        expect.objectContaining({ task_id: null, task_name: null, total_cost_usd: 0.05 }),
      ]);
      expect(body.byModel).toEqual([
        expect.objectContaining({ model: 'cc/claude-sonnet-4-6', provider: 'cc', total_cost_usd: 0.25 }),
        expect.objectContaining({ model: 'cx/gpt-5.5', provider: 'cx', total_cost_usd: 0.05 }),
      ]);
      expect(body.cap).toBe(1.5);
      expect(body.currency).toBe('USD');
      expect(new Date(body.generated_at).toString()).not.toBe('Invalid Date');
    } finally {
      if (previousBudget === undefined) delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
      else process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = previousBudget;
    }
  });

  it('returns a nested trace tree for a dashboard run', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/runs/wf_dash/trace?token=${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      trace_id: string;
      root_span: {
        span_id: string;
        name: string;
        kind: string;
        started_at: number;
        ended_at: number | null;
        attributes_json: string;
        children: Array<{
          span_id: string;
          children: Array<{ span_id: string; kind: string; attributes_json: string; children: unknown[] }>;
        }>;
      };
      total_spans: number;
      duration_ms: number;
    };
    expect(body.trace_id).toBe('wf_dash');
    expect(body.total_spans).toBe(3);
    expect(body.duration_ms).toBe(1500);
    expect(body.root_span).toEqual(expect.objectContaining({
      span_id: 'sp_wf_dash',
      name: 'workflow',
      kind: 'workflow',
      attributes_json: JSON.stringify({ objective: 'Dashboard smoke', workspace: 'internal' }),
    }));
    expect(body.root_span.children[0]).toEqual(expect.objectContaining({
      span_id: 'sp_task_dash',
    }));
    expect(body.root_span.children[0]?.children[0]).toEqual(expect.objectContaining({
      span_id: 'sp_llm_dash',
      kind: 'llm_call',
      attributes_json: JSON.stringify({ output_tokens: 12 }),
      children: [],
    }));
  });

  it('returns total_spans 0 for a run without trace rows', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/runs/test-id/trace?token=${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ trace_id: 'test-id', total_spans: 0 });
  });

  it('returns the merged Omniroute model catalog for dashboard pickers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/model-catalog?token=${token}&force=true`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      total: number;
      source: string;
      models: Array<{ model_id: string; provider: string; provider_display?: string }>;
      providers: Array<{ id: string; displayName: string; modelCount: number }>;
    };
    expect(body.total).toBeGreaterThan(0);
    expect(body.models.length).toBe(body.total);
    expect(body.models[0]).toEqual(expect.objectContaining({
      model_id: expect.any(String),
      provider: expect.any(String),
    }));
    // M1-W3-D (theater cleanup): the virtual `cli:*` providers are always
    // injected by loadCatalog (VIRTUAL_CLI_ENTRIES at modelCatalog.ts:103),
    // so the provider set is non-empty even when the live Omniroute API
    // is down. Pin that contract here.
    expect(body.providers.length).toBeGreaterThan(0);
    const providerIds = body.providers.map((p) => p.id);
    expect(providerIds).toContain('cli');
    // The cli provider must report at least the 5 hardcoded virtual entries
    // (claude-code, codex, gemini, kimi, cursor — opencode is conditional).
    const cliProvider = body.providers.find((p) => p.id === 'cli');
    expect(cliProvider).toBeDefined();
    expect(cliProvider!.modelCount).toBeGreaterThanOrEqual(5);
  });

  // Sprint F4 (model picker): /api/models is the lighter-weight alias used by
  // the Composer's ModelPicker. Asserts the picker-friendly shape (id +
  // provider + tier? + description?) and that auth still gates it.
  it('returns picker-friendly models from /api/models with Bearer auth', async () => {
    const unauth = await fetch(`http://127.0.0.1:${port}/api/models`);
    expect(unauth.status).toBe(401);

    const res = await fetch(`http://127.0.0.1:${port}/api/models?token=${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      total: number;
      source: string;
      models: Array<{
        id: string;
        provider: string;
        provider_display: string;
        kind: string;
        source: string;
        tier?: string;
        description?: string;
        recommended_for?: string[];
      }>;
      providers: Array<{ id: string; displayName: string; modelCount: number }>;
      fetched_at: number;
    };
    expect(body.total).toBeGreaterThan(0);
    expect(body.models.length).toBe(body.total);
    expect(body.models[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      provider: expect.any(String),
      provider_display: expect.any(String),
      kind: expect.any(String),
    }));
    // M1-W3-D (theater cleanup): pin the cli pseudo-provider — always
    // present in the catalog because VIRTUAL_CLI_ENTRIES injects 5+ entries
    // regardless of Omniroute live state.
    expect(body.providers.length).toBeGreaterThan(0);
    const providerIds2 = body.providers.map((p) => p.id);
    expect(providerIds2).toContain('cli');
    // virtual cli:* entries should be present so the picker can surface them
    expect(body.models.some((m) => m.id.startsWith('cli:'))).toBe(true);
    // The 5 baseline cli ids — bumped to 5 to reflect VIRTUAL_CLI_ENTRIES.
    const cliIds = body.models.filter((m) => m.id.startsWith('cli:')).map((m) => m.id);
    expect(cliIds.length).toBeGreaterThanOrEqual(5);
    expect(cliIds).toEqual(expect.arrayContaining([
      'cli:claude-code', 'cli:codex', 'cli:gemini', 'cli:kimi', 'cli:cursor',
    ]));
  });

  it('creates dashboard workspaces from the authenticated API', async () => {
    const created = await fetch(`http://127.0.0.1:${port}/api/dashboard/workspaces?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'clientdemo', created_by: 'test' }),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      workspace: 'clientdemo',
      created: true,
    });

    const duplicate = await fetch(`http://127.0.0.1:${port}/api/dashboard/workspaces?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'clientdemo', created_by: 'test' }),
    });
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      workspace: 'clientdemo',
      created: false,
    });

    const summary = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}`);
    const body = await summary.json() as {
      workspaces: string[];
      workspace_profiles: Array<{ workspace: string; software_target: unknown }>;
    };
    expect(body.workspaces).toContain('clientdemo');
    expect(body.workspace_profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspace: 'clientdemo',
        software_target: null,
      }),
    ]));
  });

  it('updates workspace software targets and exposes them in the dashboard summary', async () => {
    await fetch(`http://127.0.0.1:${port}/api/dashboard/workspaces?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'clientdemo', created_by: 'test' }),
    });

    const updated = await fetch(`http://127.0.0.1:${port}/api/dashboard/workspaces/clientdemo?token=${token}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        software_target: {
          project_root: workspaceProjectRoot,
          cwd: 'packages/app',
          base_ref: 'main',
        },
      }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      workspace: 'clientdemo',
      profile: {
        workspace: 'clientdemo',
        software_target: {
          project_root: workspaceProjectRoot,
          cwd: workspaceProjectCwd,
          base_ref: 'main',
        },
      },
    });
    expect(existsSync(join(workspaceProjectRoot, '.git'))).toBe(true);

    const summary = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}`);
    expect(summary.status).toBe(200);
    const body = await summary.json() as {
      workspace_profiles: Array<{
        workspace: string;
        software_target: {
          project_root: string;
          cwd: string;
          base_ref: string | null;
        } | null;
      }>;
    };
    expect(body.workspace_profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspace: 'clientdemo',
        software_target: {
          project_root: workspaceProjectRoot,
          cwd: workspaceProjectCwd,
          base_ref: 'main',
        },
      }),
    ]));
  });

  it('persists and lists planner sessions through the authenticated dashboard API', async () => {
    const saved = await fetch(`http://127.0.0.1:${port}/api/dashboard/planner-sessions?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'ps_dashboard_http',
        title: 'Sessão de planning HTTP',
        workspace: 'internal',
        objective: 'Sessão de planning HTTP',
        messages: [
          { id: 'm1', role: 'user', text: 'Planeje um DAG de teste' },
        ],
        dag: null,
      }),
    });
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      session: {
        id: 'ps_dashboard_http',
        workspace: 'internal',
        messages: [{ id: 'm1', role: 'user', text: 'Planeje um DAG de teste' }],
      },
    });

    const listed = await fetch(`http://127.0.0.1:${port}/api/dashboard/planner-sessions?token=${token}&workspace=internal`);
    expect(listed.status).toBe(200);
    const body = await listed.json() as {
      sessions: Array<{ id: string; workspace: string; messages: Array<{ id: string }> }>;
    };
    expect(body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'ps_dashboard_http',
        workspace: 'internal',
        messages: [expect.objectContaining({ id: 'm1' })],
      }),
    ]));
  });

  it('imports, lists and runs DAGs from the dashboard API', async () => {
    const source = `
tasks:
  - id: t0
    name: Write imported dashboard DAG
    kind: tool_call
    depends_on: []
    tool_name: file-write
    args:
      path: imported-dashboard.txt
      content: ok
    timeout_seconds: 60
`;
    const validated = await fetch(`http://127.0.0.1:${port}/api/dashboard/dags/validate?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    expect(validated.status).toBe(200);
    await expect(validated.json()).resolves.toMatchObject({ ok: true, task_count: 1 });

    const imported = await fetch(`http://127.0.0.1:${port}/api/dashboard/dags/import?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'internal',
        name: 'dashboard-imported-smoke',
        objective_sample: 'Dashboard imported DAG smoke',
        source,
      }),
    });
    expect(imported.status).toBe(200);
    const importBody = await imported.json() as { pattern_id: string };
    expect(importBody.pattern_id).toMatch(/^pt_/);

    const listed = await fetch(`http://127.0.0.1:${port}/api/dashboard/dags?token=${token}&workspace=internal`);
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as { dags: Array<{ id: string; name: string; task_count: number }> };
    expect(listBody.dags).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: importBody.pattern_id,
        name: 'dashboard-imported-smoke',
        task_count: 1,
      }),
    ]));

    const run = await fetch(`http://127.0.0.1:${port}/api/dashboard/dags/run?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'internal',
        objective: 'Run imported dashboard DAG',
        pattern_id: importBody.pattern_id,
        cli_permission_mode: 'autonomous',
      }),
    });
    expect(run.status).toBe(200);
    const runBody = await run.json() as { workflow_id: string; status: string };
    expect(runBody.workflow_id).toMatch(/^wf_/);
    expect(runBody.status).toBe('started');
    await waitForWorkflowSettled(port, token, runBody.workflow_id);

    const db = initDb(dbPath);
    try {
      const event = db.prepare(
        `SELECT payload_json FROM events WHERE workflow_id = ? AND type = 'workflow_cli_permission_mode'`,
      ).get(runBody.workflow_id) as { payload_json: string } | undefined;
      expect(event).toBeDefined();
      expect(JSON.parse(event?.payload_json ?? '{}')).toMatchObject({ mode: 'autonomous' });
    } finally {
      db.close();
    }
  });

  it('plans and revises DAGs from the dashboard API without executing them', async () => {
    const planned = await fetch(`http://127.0.0.1:${port}/api/dashboard/dags/plan?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'internal',
        objective: 'Create a dashboard generated DAG',
      }),
    });

    expect(planned.status).toBe(200);
    const plannedBody = await planned.json() as {
      status: string;
      task_count: number;
      dag: { tasks: Array<{ name: string }> };
    };
    expect(plannedBody).toMatchObject({
      status: 'plan_ready',
      task_count: 1,
    });
    expect(plannedBody.dag.tasks[0].name).toBe('Planned from dashboard');

    const revised = await fetch(`http://127.0.0.1:${port}/api/dashboard/dags/plan?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: 'internal',
        objective: 'Create a dashboard generated DAG',
        feedback: 'Split the validation task',
        current_dag: plannedBody.dag,
      }),
    });

    expect(revised.status).toBe(200);
    await expect(revised.json()).resolves.toMatchObject({
      revision_feedback: 'Split the validation task',
      task_count: 1,
    });
  });

  it('patches task model overrides and starts a safe task retry from the dashboard API', async () => {
    const patched = await fetch(`http://127.0.0.1:${port}/api/dashboard/workflows/wf_dash/tasks/tk_dash_write?token=${token}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cx/gpt-5.4',
        model_route: { use_case: 'software', strategy: 'balanced', provider: 'cx' },
        timeout_seconds: 120,
      }),
    });

    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      task: {
        id: 'tk_dash_write',
        model: 'cx/gpt-5.4',
        timeout_seconds: 120,
      },
    });

    const retry = await fetch(`http://127.0.0.1:${port}/api/dashboard/workflows/wf_dash/tasks/tk_dash_write/retry?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'task', objective: 'Retry dashboard write task' }),
    });

    expect(retry.status).toBe(200);
    const body = await retry.json() as {
      source_workflow_id: string;
      source_task_id: string;
      retry_scope: string;
      workflow_id: string;
      task_count: number;
    };
    expect(body).toMatchObject({
      source_workflow_id: 'wf_dash',
      source_task_id: 'tk_dash_write',
      retry_scope: 'task',
      task_count: 1,
    });
    expect(body.workflow_id).toMatch(/^wf_/);
    await waitForWorkflowSettled(port, token, body.workflow_id);
  });

  it('reconstructs and repeats a workflow DAG from the dashboard API', async () => {
    const view = await fetch(`http://127.0.0.1:${port}/api/dashboard/workflows/wf_dash/dag?token=${token}`);
    expect(view.status).toBe(200);
    const viewBody = await view.json() as { dag: { tasks: Array<{ tool_name?: string; args?: unknown }> } };
    expect(viewBody.dag.tasks[0]).toMatchObject({
      tool_name: 'file-write',
      args: { path: 'dash.txt', content: 'ok' },
    });

    const repeated = await fetch(`http://127.0.0.1:${port}/api/dashboard/workflows/wf_dash/repeat?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'Repeated dashboard smoke' }),
    });
    expect(repeated.status).toBe(200);
    const body = await repeated.json() as { source_workflow_id: string; workflow_id: string; task_count: number };
    expect(body).toMatchObject({
      source_workflow_id: 'wf_dash',
      task_count: 1,
    });
    expect(body.workflow_id).toMatch(/^wf_/);
    await waitForWorkflowSettled(port, token, body.workflow_id);
  });

  it('exposes subagent runs/mailbox in the summary and allows steer/kill from the dashboard API', async () => {
    const db = initDb(dbPath);
    const now = Date.now();
    try {
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at, created_at,
            created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES ('wf_subagent', 'internal', 'Adaptive workflow smoke', NULL, 'executing', ?, NULL, ?, NULL, NULL, NULL, NULL)`,
      ).run(now - 10_000, now - 11_000);
      db.prepare(
        `INSERT INTO tasks
           (id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
            executor_hint, timeout_seconds, max_retries, retry_count, retry_policy, started_at,
            completed_at, created_at, acceptance_criteria, refine_count, max_refine, refine_feedback,
            model, hitl, execution_mode)
         VALUES ('tk_subagent', 'wf_subagent', 'Adaptive review', 'llm_call',
            '{"execution_context":{"workspace_root":"C:/tmp","run_root":"C:/tmp/wf_subagent","project_root":"C:/tmp/wf_subagent","cwd":"C:/tmp/wf_subagent","output_dir":"C:/tmp/wf_subagent","base_ref":null,"source_project_root":"C:/tmp/wf_subagent","source_cwd":"C:/tmp/wf_subagent","worktree_root":null,"worktree_branch":null,"lineage":{"lane":"software","source":"workspace_run","workspace":"internal","workflow_id":"wf_subagent","task_id":"tk_subagent"}}}',
            NULL, 'running', '[]', NULL, 300, 3, 0, 'exponential', ?, NULL, ?, 'Return findings', 0, 2, NULL,
            'cc/claude-sonnet', 0, 'adaptive')`,
      ).run(now - 9_500, now - 10_000);
      db.prepare(
        `INSERT INTO subagent_runs
           (run_id, task_id, workflow_id, parent_run_id, depth, model, task_text, status,
            result_text, error_msg, cleanup, spawn_mode, timeout_seconds,
            created_at, started_at, ended_at, archive_after_ms)
         VALUES ('sa_http_1', 'tk_subagent', 'wf_subagent', NULL, 0, 'cc/claude-sonnet',
            'Investigue riscos e anuncie progresso', 'running', NULL, NULL, 'keep', 'run', 300,
            ?, ?, NULL, NULL)`,
      ).run(now - 9_000, now - 8_500);
      db.prepare(
        `INSERT INTO subagent_messages
           (id, workflow_id, from_task_id, to_task_id, message_type, payload_json, status, created_at, delivered_at)
         VALUES ('sm_http_1', 'wf_subagent', 'tk_subagent', NULL, 'announcement', ?, 'pending', ?, NULL)`,
      ).run(
        JSON.stringify({
          fenced: '<subagent-message source="tk_subagent" type="announcement">Mapeando riscos agora.</subagent-message>',
          raw: { topic: 'progress', summary: 'Mapeando riscos agora.' },
        }),
        now - 8_000,
      );
    } finally {
      db.close();
    }

    const summary = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}&workspace=internal`);
    expect(summary.status).toBe(200);
    const snapshot = await summary.json() as {
      kanban: { tasks: Record<string, Record<string, Array<{ id: string; subagent_runs: unknown[]; mailbox: unknown[] }>>> };
    };
    expect(snapshot.kanban.tasks['wf_subagent'].running[0]).toMatchObject({
      id: 'tk_subagent',
      subagent_runs: [expect.objectContaining({ run_id: 'sa_http_1', status: 'running' })],
      mailbox: [expect.objectContaining({ id: 'sm_http_1', direction: 'outbox' })],
    });

    const steer = await fetch(`http://127.0.0.1:${port}/api/dashboard/workflows/wf_subagent/tasks/tk_subagent/subagents/steer?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: 'Foque só nos 2 riscos mais prováveis e sintetize.' }),
    });
    expect(steer.status).toBe(200);
    await expect(steer.json()).resolves.toMatchObject({
      workflow_id: 'wf_subagent',
      task_id: 'tk_subagent',
      steer_status: 'accepted',
    });

    const kill = await fetch(`http://127.0.0.1:${port}/api/dashboard/workflows/wf_subagent/tasks/tk_subagent/subagents/kill?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Encerrar smoke de subagente' }),
    });
    expect(kill.status).toBe(200);
    await expect(kill.json()).resolves.toMatchObject({
      workflow_id: 'wf_subagent',
      task_id: 'tk_subagent',
      kill_status: 'killed',
      active_runs: 0,
      task_status: 'failed',
    });

    const verifyDb = initDb(dbPath);
    try {
      const taskRow = verifyDb.prepare(
        `SELECT status, steer_instruction FROM tasks WHERE id = 'tk_subagent'`,
      ).get() as { status: string; steer_instruction: string | null };
      expect(taskRow.status).toBe('failed');
      expect(taskRow.steer_instruction).toBe('Foque só nos 2 riscos mais prováveis e sintetize.');

      const runRow = verifyDb.prepare(
        `SELECT status, error_msg FROM subagent_runs WHERE run_id = 'sa_http_1'`,
      ).get() as { status: string; error_msg: string | null };
      expect(runRow.status).toBe('killed');
      expect(runRow.error_msg).toBe('Encerrar smoke de subagente');
    } finally {
      verifyDb.close();
    }
  });

  it('rejects DAG validation requests with missing dependency references', async () => {
    const source = `
tasks:
  - id: t1
    name: Impossible imported dashboard DAG
    kind: llm_call
    depends_on: [missing]
    acceptance_criteria: Valid JSON object with field result string and explicit completion status
`;
    const validated = await fetch(`http://127.0.0.1:${port}/api/dashboard/dags/validate?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });

    expect(validated.status).toBe(400);
    await expect(validated.json()).resolves.toMatchObject({
      error: expect.stringContaining('graph-integrity'),
    });
  });

  it('clears dashboard runs and workspace registry only with explicit confirmation', async () => {
    const rejected = await fetch(`http://127.0.0.1:${port}/api/dashboard/admin/clear?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'wrong' }),
    });
    expect(rejected.status).toBe(400);

    const cleared = await fetch(`http://127.0.0.1:${port}/api/dashboard/admin/clear?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_DASHBOARD_DATA', include_patterns: false }),
    });
    expect(cleared.status).toBe(200);
    const body = await cleared.json() as { deleted: Record<string, number>; include_patterns: boolean };
    expect(body.include_patterns).toBe(false);
    expect(body.deleted.workflows).toBeGreaterThanOrEqual(1);
    expect(body.deleted.dashboard_workspaces).toBeGreaterThanOrEqual(1);

    const summary = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}`);
    const snapshot = await summary.json() as {
      summary: { workflow_count: number; task_count: number };
      workspaces: string[];
    };
    expect(snapshot.summary.workflow_count).toBe(0);
    expect(snapshot.summary.task_count).toBe(0);
    expect(snapshot.workspaces).not.toContain('clientdemo');
  });
});
