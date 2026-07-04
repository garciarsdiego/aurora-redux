import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { startHttpMcpServer, resolveToken, type ShutdownFn } from '../../src/mcp/http-server.js';
import { initDb } from '../../src/db/client.js';
import { _resetControlRegistry, registerAbortController } from '../../src/v2/subagent/control.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('HTTP MCP daemon — smoke', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = path.join(tmpdir(), `omniforge-smoke-${Date.now()}`);
  let originalAuth: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
  });

  afterAll(async () => {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalAuth;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
  });

  it('GET /health returns 200 without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET /mcp/tools/list returns 401 without token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/tools/list`);
    expect(res.status).toBe(401);
  });

  it('GET /mcp/tools/list returns 401 with wrong token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/tools/list`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /mcp/tools/list returns tools with correct token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/tools/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: Array<{ name: string }> };
    expect(Array.isArray(body.tools)).toBe(true);
    // Soft pin: at least the REQUIRED_TOOLS set must be present. The registry
    // grew past 58 (added credential_*, sync, and a few advisors) — we no
    // longer hard-pin the count here. The "tool names match" test below
    // continues to enforce that every REQUIRED tool is present.
    expect(body.tools.length).toBeGreaterThanOrEqual(58);
  });

  it('tool names match the Omniforge MCP tools', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/tools/list`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json() as { tools: Array<{ name: string }> };
    const names = body.tools.map((t) => t.name).sort();
    // Resilient assertion: REQUIRED tools must be present, but the set may grow.
    // For an exact-match smoke (no drift), see F0-7 next-wave smoke test that
    // derives the list dynamically from the MCP server registry.
    const REQUIRED_TOOLS = [
      // Core tools
      'omniforge_approve_gate',
      'omniforge_builder_chat',
      'omniforge_export_pattern',
      'omniforge_get_context_bundle',
      'omniforge_get_eval_run',
      'omniforge_get_model_calls',
      'omniforge_get_workflow_status',
      'omniforge_import_pattern',
      'omniforge_list_eval_cases',
      'omniforge_list_models',
      'omniforge_list_patterns',
      'omniforge_list_versioned_definitions',
      'omniforge_list_workflows',
      'omniforge_listmodels',
      'omniforge_pin_versioned_definition',
      'omniforge_plan_workflow',
      'omniforge_read_file',
      'omniforge_register_eval_case',
      'omniforge_register_versioned_definition',
      'omniforge_replay_persona_version',
      'omniforge_route_model',
      'omniforge_run_meta_workflow',
      'omniforge_run_workflow',
      'omniforge_save_pattern',
      'omniforge_set_config',
      'omniforge_set_hermes_model',
      'omniforge_tail_cli',
      'omniforge_task_await',
      'omniforge_task_cancel',
      'omniforge_vault_delete',
      'omniforge_vault_list',
      'omniforge_vault_merge',
      'omniforge_vault_read',
      'omniforge_vault_write',
      // 17 native advisors (AETHER ε.4)
      'omniforge_analyze',
      'omniforge_apilookup',
      'omniforge_challenge',
      'omniforge_chat',
      'omniforge_codereview',
      'omniforge_consensus',
      'omniforge_debug',
      'omniforge_docgen',
      'omniforge_planner',
      'omniforge_precommit',
      'omniforge_refactor',
      'omniforge_secaudit',
      'omniforge_testgen',
      'omniforge_thinkdeep',
      'omniforge_tracer',
      'omniforge_version',
      // 7 collaboration tools (Wave 0.1 additions)
      'omniforge_create_fix_task',
      'omniforge_get_architecture_contract',
      'omniforge_inspect_workflow_diff',
      'omniforge_post_task_handoff',
      'omniforge_read_task_thread',
      'omniforge_request_architecture_review',
      'omniforge_request_product_review',
      // M1-W3-D: previously missing from this list — pin the full surface
      'omniforge_opencode_sync_models',
    ].sort();
    // REQUIRED_TOOLS must be present (no regressions); total may grow as new
    // tools land (credential_*, sync_*, additional advisors). Per-tool drift
    // is still caught by the arrayContaining check below.
    expect(names).toEqual(expect.arrayContaining(REQUIRED_TOOLS));
    expect(names.length).toBeGreaterThanOrEqual(REQUIRED_TOOLS.length);
    // Each known tool name is present, no exceptions.
    for (const required of REQUIRED_TOOLS) {
      expect(names).toContain(required);
    }
  });

  it('GET /mcp/sse returns 401 without token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/sse`);
    expect(res.status).toBe(401);
  });

  it('GET /unknown returns 404 with token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown-path`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  // Sprint 2.4 (D-H2.066, F-REL-1): hard cancel must propagate AbortController
  // and flip workflow status to 'cancelled' (not 'failed').
  it('POST /workflow/:id/cancel aborts in-flight controllers and marks workflow cancelled', async () => {
    _resetControlRegistry();
    const dbPath = path.join(dataDir, 'omniforge.db');
    process.env.DB_PATH = dbPath;
    const db = initDb(dbPath);
    try {
      const wfId = `wf_cancel_${Date.now().toString(36)}`;
      const tkRunning = `tk_${Date.now().toString(36)}_r`;
      const tkPending = `tk_${Date.now().toString(36)}_p`;
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, created_at)
         VALUES (?, 'internal', 'cancel test', 'executing', ?)`,
      ).run(wfId, now);
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
         VALUES (?, ?, 'running task', 'llm_call', 'running', ?)`,
      ).run(tkRunning, wfId, now);
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
         VALUES (?, ?, 'pending task', 'llm_call', 'pending', ?)`,
      ).run(tkPending, wfId, now);

      const ac = new AbortController();
      registerAbortController(tkRunning, ac);

      const res = await fetch(`http://127.0.0.1:${port}/workflow/${wfId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'integration-test' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.cancelled).toBe(true);
      expect(body.tasks_cancelled).toBe(2);
      expect(body.controllers_aborted).toBe(1);
      expect(ac.signal.aborted).toBe(true);

      const wfRow = db
        .prepare('SELECT status FROM workflows WHERE id = ?')
        .get(wfId) as { status: string };
      expect(wfRow.status).toBe('cancelled');

      const tkRow = db
        .prepare('SELECT status FROM tasks WHERE id = ?')
        .get(tkRunning) as { status: string };
      expect(tkRow.status).toBe('cancelled');

      const evRow = db
        .prepare("SELECT payload_json FROM events WHERE workflow_id = ? AND type = 'workflow_cancelled'")
        .get(wfId) as { payload_json: string };
      const payload = JSON.parse(evRow.payload_json);
      expect(payload.reason).toBe('integration-test');
      expect(payload.controllers_aborted).toBe(1);
    } finally {
      db.close();
      _resetControlRegistry();
      delete process.env.DB_PATH;
    }
  });

  // Sprint 8.1 (D-H2.066, F-SEC-1): /dashboard?token=X must 302-redirect
  // to /dashboard (no query) with Set-Cookie. Removes token from browser
  // history, URL bar, Referer headers.
  it('GET /dashboard?token=X redirects 302 with Set-Cookie (no body)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=${token}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('omniforge_daemon_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    const body = await res.text();
    expect(body).toBe('');
  });

  it('GET /dashboard (no query) serves the dashboard with cookie auth', async () => {
    // Auth via cookie set by the Sprint 8.1 redirect.
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    // M1-W3-D (theater cleanup): replace > 100 cosmetic check with
    // stable shell-content assertions. Both the inline-fallback and the
    // built dashboard-v2 shell include a <head> + a React root mount node.
    expect(body).toContain('<!doctype html>');
    expect(body).toMatch(/<html[\s>]/i);
    // The mounted SPA root OR the inline-fallback heading must be present.
    expect(body).toMatch(/<div id="root"><\/div>|DAG Workbench|Omniforge/);
    // Sanity: HTML shell is at minimum a few hundred bytes (avoids the
    // truly-empty regression of a 0-byte 200).
    expect(body.length).toBeGreaterThan(500);
  });

  it('POST /workflow/:id/cancel returns 409 when already terminal', async () => {
    const dbPath = path.join(dataDir, 'omniforge.db');
    process.env.DB_PATH = dbPath;
    const db = initDb(dbPath);
    try {
      const wfId = `wf_term_${Date.now().toString(36)}`;
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, created_at, completed_at)
         VALUES (?, 'internal', 't', 'completed', ?, ?)`,
      ).run(wfId, Date.now(), Date.now());
      const res = await fetch(`http://127.0.0.1:${port}/workflow/${wfId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('workflow_already_terminal');
      expect(body.status).toBe('completed');
    } finally {
      db.close();
      delete process.env.DB_PATH;
    }
  });
});

describe('HTTP MCP daemon — local auth opt-out', () => {
  let shutdown: ShutdownFn;
  let port: number;
  const dataDir = path.join(tmpdir(), `omniforge-smoke-auth-off-${Date.now()}`);
  let originalAuth: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    process.env.OMNIFORGE_DAEMON_AUTH = 'off';
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
  });

  afterAll(async () => {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalAuth;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
  });

  it('allows loopback requests without daemon token when OMNIFORGE_DAEMON_AUTH=off', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/tools/list`);
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: Array<{ name: string }> };
    expect(body.tools.some((tool) => tool.name === 'omniforge_list_models')).toBe(true);
  });
});
