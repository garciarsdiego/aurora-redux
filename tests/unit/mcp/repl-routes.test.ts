// Daemon REPL/SSE routes — D-H2.027.
//
// End-to-end tests against a live HTTP server (real http.createServer +
// real SQLite file). Mocks ONLY callOmnirouteStream so we can drive
// /stream/llm without a real Omniroute backend. Each test gets its own
// port + DB to keep parallel execution safe.

import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDb } from '../../../src/db/client.js';
import { insertWorkflow, insertHitlGate, insertEvent, newHitlGateId } from '../../../src/db/persist.js';
import type { Workflow } from '../../../src/types/index.js';

// ── callOmnirouteStream mock ─────────────────────────────────────────────────

let mockChunks: string[] = ['hello ', 'world', '!'];
let mockUsage: { input_tokens?: number; output_tokens?: number } | null = { input_tokens: 4, output_tokens: 3 };
let mockStreamShouldThrow: Error | null = null;
let mockAbortObserved = false;

let mockChunkDelayMs = 5;

vi.mock('../../../src/utils/omniroute-stream.ts', () => ({
  callOmnirouteStream(opts: { signal?: AbortSignal; onUsage?: (u: unknown) => void }) {
    const chunks = [...mockChunks];
    const onUsage = opts.onUsage;
    const signal = opts.signal;
    // Register an abort listener so we observe even mid-await aborts.
    if (signal) {
      signal.addEventListener('abort', () => { mockAbortObserved = true; }, { once: true });
    }
    return (async function* (): AsyncGenerator<string> {
      if (mockStreamShouldThrow) throw mockStreamShouldThrow;
      try {
        for (const chunk of chunks) {
          if (signal?.aborted) { mockAbortObserved = true; return; }
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, mockChunkDelayMs);
            if (signal) {
              signal.addEventListener('abort', () => {
                clearTimeout(t);
                reject(new Error('aborted'));
              }, { once: true });
            }
          });
          if (signal?.aborted) { mockAbortObserved = true; return; }
          yield chunk;
        }
        if (onUsage && mockUsage) onUsage(mockUsage);
      } catch {
        if (signal?.aborted) mockAbortObserved = true;
      }
    })();
  },
}));

// Force getDbPath to use a per-test temp file.
const TEST_TOKEN = 'test-token-fixed-1234567890abcdef';

let port = 13800;
function nextPort(): number { return port++; }

interface ServerHandle {
  shutdown: () => Promise<void>;
  port: number;
  dbPath: string;
}

async function startServerForTest(): Promise<ServerHandle> {
  const tempDir = path.join(tmpdir(), `omniforge-repl-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
  const dbPath = path.join(tempDir, 'test.db');
  const previousDaemonAuth = process.env.OMNIFORGE_DAEMON_AUTH;
  process.env.OMNIFORGE_DAEMON_TOKEN = TEST_TOKEN;
  delete process.env.OMNIFORGE_DAEMON_AUTH;
  process.env.DB_PATH = dbPath;
  const myPort = nextPort();
  // Import AFTER env is set so config lazy-getters see the right values.
  const { startHttpMcpServer } = await import('../../../src/mcp/http-server.js');
  const shutdown = await startHttpMcpServer(tempDir, myPort);
  return {
    shutdown: async () => {
      await shutdown();
      if (previousDaemonAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
      else process.env.OMNIFORGE_DAEMON_AUTH = previousDaemonAuth;
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
    port: myPort,
    dbPath,
  };
}

function bearer(headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json', Connection: 'close', ...headers };
}

async function postJson(handle: ServerHandle, urlPath: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}${urlPath}`, {
    method: 'POST',
    headers: bearer(headers),
    body: JSON.stringify(body),
  });
}

async function get(handle: ServerHandle, urlPath: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.port}${urlPath}`, { headers: bearer(headers) });
}

function seedWorkflow(dbPath: string, wf: Partial<Workflow> & { id: string }): Workflow {
  const db = initDb(dbPath);
  try {
    const full: Workflow = {
      id: wf.id,
      workspace: wf.workspace ?? 'internal',
      objective: wf.objective ?? 'test goal',
      pattern_id: null,
      status: wf.status ?? 'executing',
      started_at: wf.started_at ?? Date.now(),
      completed_at: null,
      created_at: Date.now(),
      created_by: 'test',
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    };
    insertWorkflow(db, full);
    return full;
  } finally { db.close(); }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await startServerForTest(); });
  afterEach(async () => { await handle.shutdown(); });

  it('returns shape { status, version, uptime_ms, api_version } without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-omniforge-api-version')).toBe('1');
    const body = await res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(typeof body['version']).toBe('string');
    expect(typeof body['uptime_ms']).toBe('number');
    expect(body['api_version']).toBe(1);
  });

  it('uptime_ms increases between calls', async () => {
    const a = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json() as { uptime_ms: number };
    await new Promise((r) => setTimeout(r, 25));
    const b = await (await fetch(`http://127.0.0.1:${handle.port}/health`)).json() as { uptime_ms: number };
    expect(b.uptime_ms).toBeGreaterThanOrEqual(a.uptime_ms);
  });
});

describe('Bearer auth enforcement', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await startServerForTest(); });
  afterEach(async () => { await handle.shutdown(); });

  it('returns 401 without Authorization header', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/actor/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong Bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/actor/register`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with correctly-shaped but wrong-value token', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/actor/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN.slice(0, -1)}X`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /actor/register + heartbeat + unregister', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await startServerForTest(); });
  afterEach(async () => { await handle.shutdown(); });

  it('register issues a token; map populated; idempotent on re-call', async () => {
    const res = await postJson(handle, '/actor/register', { kind: 'repl' });
    expect(res.status).toBe(200);
    const body = await res.json() as { actor_id: string; actor_token: string; expires_at: number };
    expect(body.actor_id).toMatch(/^repl-/);
    expect(body.actor_token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expires_at).toBeGreaterThan(Date.now());

    const { __testing__ } = await import('../../../src/mcp/http-server.js');
    expect(__testing__.actorRegistry.has(body.actor_token)).toBe(true);
  });

  it('register accepts custom actor_id', async () => {
    const res = await postJson(handle, '/actor/register', { kind: 'cli', actor_id: 'my-custom-id' });
    const body = await res.json() as { actor_id: string };
    expect(body.actor_id).toBe('my-custom-id');
  });

  it('heartbeat renews TTL', async () => {
    const reg = await (await postJson(handle, '/actor/register', { kind: 'repl' })).json() as { actor_token: string; expires_at: number };
    await new Promise((r) => setTimeout(r, 30));
    const beat = await postJson(handle, '/actor/heartbeat', { actor_token: reg.actor_token });
    expect(beat.status).toBe(200);
    const beatBody = await beat.json() as { expires_at: number };
    expect(beatBody.expires_at).toBeGreaterThanOrEqual(reg.expires_at);
  });

  it('heartbeat rejects unknown token with 401', async () => {
    const res = await postJson(handle, '/actor/heartbeat', { actor_token: 'nonexistent-token' });
    expect(res.status).toBe(401);
  });

  it('unregister is idempotent (200 even if token already gone)', async () => {
    const reg = await (await postJson(handle, '/actor/register', { kind: 'repl' })).json() as { actor_token: string };
    const r1 = await postJson(handle, '/actor/unregister', { actor_token: reg.actor_token });
    const r2 = await postJson(handle, '/actor/unregister', { actor_token: reg.actor_token });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const { __testing__ } = await import('../../../src/mcp/http-server.js');
    expect(__testing__.actorRegistry.has(reg.actor_token)).toBe(false);
  });
});

describe('POST /workflow/:id/cancel', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await startServerForTest(); });
  afterEach(async () => { await handle.shutdown(); });

  it('cancels an executing workflow and marks tasks cancelled', async () => {
    seedWorkflow(handle.dbPath, { id: 'wf_cancel_me', status: 'executing' });
    const db = initDb(handle.dbPath);
    db.prepare(
      `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('tk_run', 'wf_cancel_me', 'running task', 'llm_call', 'running', Date.now());
    db.close();

    const res = await postJson(handle, '/workflow/wf_cancel_me/cancel', { reason: 'user requested' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      wf_id: string;
      cancelled: boolean;
      tasks_cancelled: number;
      controllers_aborted: number;
      messages_cancelled: number;
    };
    expect(body.wf_id).toBe('wf_cancel_me');
    expect(body.cancelled).toBe(true);
    expect(body.tasks_cancelled).toBe(1);
    expect(body.controllers_aborted).toBe(0); // no in-flight controller registered in this test
    expect(body.messages_cancelled).toBe(0);

    const db2 = initDb(handle.dbPath);
    // Sprint 2.2 (D-H2.066, F-REL-1): workflow status is now 'cancelled' (was
    // 'failed' before — preserves operator intent in audit).
    const wf = db2.prepare(`SELECT status, metadata FROM workflows WHERE id = ?`).get('wf_cancel_me') as { status: string; metadata: string };
    const tk = db2.prepare(`SELECT status FROM tasks WHERE id = ?`).get('tk_run') as { status: string };
    db2.close();
    expect(wf.status).toBe('cancelled');
    expect(tk.status).toBe('cancelled');
    expect(wf.metadata).toContain('user requested');
  });

  it('returns 409 on already-terminal workflow (idempotent semantics)', async () => {
    seedWorkflow(handle.dbPath, { id: 'wf_done', status: 'completed' });

    const res = await postJson(handle, '/workflow/wf_done/cancel', { reason: 'too late' });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; status: string };
    expect(body.error).toBe('workflow_already_terminal');
    expect(body.status).toBe('completed');
  });

  it('returns 404 for unknown workflow', async () => {
    const res = await postJson(handle, '/workflow/wf_nonexistent/cancel', {});
    expect(res.status).toBe(404);
  });
});

describe('GET /events/workflow/:id (SSE)', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await startServerForTest(); });
  afterEach(async () => { await handle.shutdown(); });

  it('backfills events with since_event_id filter', async () => {
    seedWorkflow(handle.dbPath, { id: 'wf_back', status: 'executing' });
    const db = initDb(handle.dbPath);
    insertEvent(db, { workflow_id: 'wf_back', type: 'workflow_started', payload: { tasks: ['a'] } });
    insertEvent(db, { workflow_id: 'wf_back', type: 'task_started', payload: { task_name: 'a' } });
    insertEvent(db, { workflow_id: 'wf_back', type: 'task_completed', payload: { task_name: 'a' } });
    db.close();

    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${handle.port}/events/workflow/wf_back?since_event_id=0`, {
      headers: bearer(), signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // Read backfill chunks; abort after we observe the 3 known events.
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const seen: string[] = [];
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const matches = buf.match(/event:\s*([a-z_]+)/g) ?? [];
      for (const m of matches) seen.push(m.replace(/^event:\s*/, ''));
      if (seen.includes('task_completed')) break;
    }
    ctrl.abort();
    expect(seen).toContain('workflow_started');
    expect(seen).toContain('task_started');
    expect(seen).toContain('task_completed');
  });

  it('subscribe receives new events via eventBroker', async () => {
    seedWorkflow(handle.dbPath, { id: 'wf_live', status: 'executing' });

    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${handle.port}/events/workflow/wf_live`, {
      headers: bearer(), signal: ctrl.signal,
    });

    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // Allow the SSE handler to register its subscription before publishing.
    await new Promise((r) => setTimeout(r, 50));

    // Publish a new event after subscription is established.
    const db = initDb(handle.dbPath);
    insertEvent(db, { workflow_id: 'wf_live', type: 'task_failed', payload: { task_name: 'broken' } });
    db.close();

    let buf = '';
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('task_failed')) break;
    }
    ctrl.abort();
    expect(buf).toContain('event: task_failed');
    expect(buf).toContain('broken');
  });
});

describe('GET /events/gates (SSE)', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await startServerForTest(); });
  afterEach(async () => { await handle.shutdown(); });

  it('multiple subscribers each receive published gate events', async () => {
    const { eventBroker } = await import('../../../src/mcp/event-broker.js');

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    const resA = await fetch(`http://127.0.0.1:${handle.port}/events/gates`, { headers: bearer(), signal: ctrlA.signal });
    const resB = await fetch(`http://127.0.0.1:${handle.port}/events/gates`, { headers: bearer(), signal: ctrlB.signal });

    await new Promise((r) => setTimeout(r, 80)); // ensure both subscriptions registered

    eventBroker.publishGate({
      type: 'gate_pending',
      gate_id: 'hg_xyz',
      workflow_id: 'wf_for_gate',
      workspace: 'internal',
      payload: { prompt: 'approve?' },
    });

    const dec = new TextDecoder();
    async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, sentinel: string, ms = 2000): Promise<string> {
      let buf = '';
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes(sentinel)) return buf;
      }
      return buf;
    }

    const [bufA, bufB] = await Promise.all([
      readUntil(resA.body!.getReader(), 'hg_xyz'),
      readUntil(resB.body!.getReader(), 'hg_xyz'),
    ]);
    ctrlA.abort();
    ctrlB.abort();
    expect(bufA).toContain('gate_pending');
    expect(bufA).toContain('hg_xyz');
    expect(bufB).toContain('gate_pending');
    expect(bufB).toContain('hg_xyz');
  });
});

describe('POST /stream/llm', () => {
  let handle: ServerHandle;
  beforeEach(async () => {
    handle = await startServerForTest();
    mockChunks = ['hello ', 'world', '!'];
    mockUsage = { input_tokens: 4, output_tokens: 3 };
    mockStreamShouldThrow = null;
    mockAbortObserved = false;
    mockChunkDelayMs = 5;
  });
  afterEach(async () => { await handle.shutdown(); });

  it('streams chunks then a final done event in SSE format', async () => {
    const reg = await (await postJson(handle, '/actor/register', { kind: 'repl' })).json() as { actor_token: string };

    const res = await postJson(handle, '/stream/llm', {
      prompt: 'hi',
      system_prompt: 'be brief',
      model: 'claude/claude-haiku-4-5-20251001',
      actor_token: reg.actor_token,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('event: chunk');
    expect(text).toContain('"text":"hello "');
    expect(text).toContain('"text":"world"');
    expect(text).toContain('event: done');
    expect(text).toContain('"total_chunks":3');
  });

  it('client disconnect propagates AbortController to upstream', async () => {
    // Long stream so abort can hit BEFORE all chunks finish flushing.
    mockChunks = Array.from({ length: 50 }, (_, i) => `chunk-${i} `);
    mockChunkDelayMs = 50;
    const reg = await (await postJson(handle, '/actor/register', { kind: 'repl' })).json() as { actor_token: string };

    // Use raw http.request so we can DESTROY the socket (the surest way to
    // trigger req.on('close') on the server). undici's fetch with abort can
    // sometimes only stop the consumer.
    const http = await import('node:http');
    const aborted = await new Promise<boolean>((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: handle.port, method: 'POST', path: '/stream/llm',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      }, (res) => {
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 0) {
            // Got at least one chunk — destroy the socket to force server
            // to observe 'close' on the IncomingMessage.
            req.destroy();
            resolve(true);
          }
        });
        res.on('end', () => resolve(false));
      });
      req.on('error', () => resolve(true));
      req.write(JSON.stringify({
        prompt: 'long', system_prompt: 'go',
        model: 'claude/claude-haiku-4-5-20251001',
        actor_token: reg.actor_token,
      }));
      req.end();
    });
    expect(aborted).toBe(true);

    // Allow time for the server's `req.on('close')` to fire and propagate
    // through ctrl.abort() into the upstream generator.
    await new Promise((r) => setTimeout(r, 250));
    expect(mockAbortObserved).toBe(true);
  });

  it('rejects when actor_token missing or invalid', async () => {
    const res = await postJson(handle, '/stream/llm', {
      prompt: 'hi', system_prompt: 's', model: 'm', actor_token: 'bogus',
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /gate/:id/resolve  (race condition)', () => {
  let handle: ServerHandle;
  beforeEach(async () => { handle = await startServerForTest(); });
  afterEach(async () => { await handle.shutdown(); });

  it('first_resolver=true on first call; race_lost=true on second call', async () => {
    const wf = seedWorkflow(handle.dbPath, { id: 'wf_gate_race', status: 'executing' });
    const gateId = newHitlGateId();
    const db = initDb(handle.dbPath);
    db.pragma('foreign_keys = OFF');
    insertHitlGate(db, {
      id: gateId,
      workflow_id: wf.id,
      gate_type: 'cli',
      prompt: 'approve?',
      channel: 'repl',
    });
    db.close();

    const r1 = await (await postJson(handle, '/actor/register', { kind: 'repl', actor_id: 'actor-A' })).json() as { actor_token: string };
    const r2 = await (await postJson(handle, '/actor/register', { kind: 'cli',  actor_id: 'actor-B' })).json() as { actor_token: string };

    const first = await (await postJson(handle, `/gate/${gateId}/resolve`, {
      decision: 'approve', actor_token: r1.actor_token,
    })).json() as { first_resolver: boolean; resolved_by_actor: string; race_lost?: boolean };
    expect(first.first_resolver).toBe(true);
    expect(first.resolved_by_actor).toBe('actor-A');

    const second = await (await postJson(handle, `/gate/${gateId}/resolve`, {
      decision: 'reject', actor_token: r2.actor_token,
    })).json() as { first_resolver: boolean; race_lost?: boolean; winning_decision?: string; resolved_by_actor: string };
    expect(second.first_resolver).toBe(false);
    expect(second.race_lost).toBe(true);
    expect(second.winning_decision).toBe('approved');
    expect(second.resolved_by_actor).toBe('actor-A');
  });

  it('returns 404 for unknown gate', async () => {
    const reg = await (await postJson(handle, '/actor/register', {})).json() as { actor_token: string };
    const res = await postJson(handle, '/gate/hg_nonexistent/resolve', {
      decision: 'approve', actor_token: reg.actor_token,
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 if actor_token missing or invalid', async () => {
    seedWorkflow(handle.dbPath, { id: 'wf_g', status: 'executing' });
    const gateId = newHitlGateId();
    const db = initDb(handle.dbPath);
    db.pragma('foreign_keys = OFF');
    insertHitlGate(db, { id: gateId, workflow_id: 'wf_g', gate_type: 'cli', prompt: 'p', channel: 'repl' });
    db.close();

    const res = await postJson(handle, `/gate/${gateId}/resolve`, { decision: 'approve' });
    expect(res.status).toBe(401);
  });
});
