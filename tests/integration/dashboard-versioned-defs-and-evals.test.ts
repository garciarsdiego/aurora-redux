// Integration test for the W1.1 + W1.2 dashboard routes:
//   GET  /api/dashboard/versioned-defs
//   POST /api/dashboard/versioned-defs/:id/pin
//   GET  /api/dashboard/eval-cases
//   POST /api/dashboard/evals/run
//   GET  /api/dashboard/evals/:id
//
// Pins the request/response CONTRACT shapes the Aurora frontend (api.ts)
// depends on: bare JSON arrays (no envelope), version mapped to an integer,
// status derived from the active-pin join, epoch-ms timestamps emitted as ISO
// strings, and the light EvalRun shape (distinct from the rich /evals/runs/:id
// observability envelope).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHttpMcpServer, type ShutdownFn } from '../../src/mcp/http-server.js';
import { initDb } from '../../src/db/client.js';
import { createVersionedDefinition } from '../../src/v2/governance/versioned-registry.js';
import { registerEvalCase } from '../../src/v2/evals/harness.js';

const WORKSPACE = 'vdtest';

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

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe('dashboard versioned-defs + evals routes', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-vd-evals-${Date.now()}`);
  let originalAuth: string | undefined;
  let originalDbPath: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    originalDbPath = process.env.DB_PATH;
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    process.env.OMNIFORGE_DAEMON_TOKEN = 'vd-evals-test-token';
    process.env.DB_PATH = join(dataDir, 'vd-evals-test.db');
    token = process.env.OMNIFORGE_DAEMON_TOKEN;
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
  });

  afterAll(async () => {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    if (originalAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalAuth;
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
  });

  // ── Versioned defs ──────────────────────────────────────────────────────────

  it('lists versioned definitions as a bare array with mapped shapes', async () => {
    const db = initDb(process.env.DB_PATH!);
    let defId: string;
    try {
      const def = createVersionedDefinition(db, {
        workspace: WORKSPACE,
        kind: 'agent',
        name: 'decomposer',
        version: '2.3.4',
        status: 'active',
        spec: { prompt: 'hi' },
      });
      defId = def.id;
    } finally {
      db.close();
    }

    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/versioned-defs?workspace=${WORKSPACE}`, {
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      kind: string;
      version: number;
      status: string;
      workspace: string;
      created_at: string;
    }>;
    // BARE ARRAY (no envelope).
    expect(Array.isArray(body)).toBe(true);
    const row = body.find((d) => d.id === defId);
    expect(row).toBeDefined();
    expect(row!.name).toBe('decomposer');
    expect(row!.kind).toBe('agent');
    // version: semver '2.3.4' → major integer 2.
    expect(row!.version).toBe(2);
    expect(typeof row!.version).toBe('number');
    // Not pinned yet, status active → 'active'.
    expect(row!.status).toBe('active');
    // created_at emitted as ISO string.
    expect(new Date(row!.created_at).toString()).not.toBe('Invalid Date');
    // Summary card never reads spec/checksum/notes — they must be absent.
    expect((row as Record<string, unknown>).spec).toBeUndefined();
    expect((row as Record<string, unknown>).checksum_sha256).toBeUndefined();
  });

  it('pins a versioned definition and reflects pinned status on re-list', async () => {
    const db = initDb(process.env.DB_PATH!);
    let defId: string;
    try {
      const def = createVersionedDefinition(db, {
        workspace: WORKSPACE,
        kind: 'tool',
        name: 'http-client',
        version: '1.0.0',
        status: 'active',
        spec: { url: 'x' },
      });
      defId = def.id;
    } finally {
      db.close();
    }

    const pinRes = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/versioned-defs/${defId}/pin`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(pinRes.status).toBe(200);
    expect(await pinRes.json()).toEqual({ ok: true });

    const listRes = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/versioned-defs?workspace=${WORKSPACE}`,
      { headers: authHeaders(token) },
    );
    const body = (await listRes.json()) as Array<{ id: string; status: string }>;
    const row = body.find((d) => d.id === defId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('pinned');
  });

  it('returns 404 when pinning an unknown versioned definition id', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/versioned-defs/vd_does_not_exist/pin`,
      { method: 'POST', headers: authHeaders(token) },
    );
    expect(res.status).toBe(404);
  });

  it('rejects versioned-defs without a Bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/versioned-defs`);
    expect([401, 403]).toContain(res.status);
  });

  // ── Eval cases + run + get ─────────────────────────────────────────────────

  it('lists eval cases as a bare array with mapped shapes', async () => {
    const db = initDb(process.env.DB_PATH!);
    try {
      registerEvalCase(db, {
        workspace: WORKSPACE,
        name: 'echo-string',
        input: 'hello',
        expected: 'hello',
        tags: ['smoke'],
      });
      registerEvalCase(db, {
        workspace: WORKSPACE,
        name: 'echo-object',
        input: { a: 1 },
        expected: { a: 1 },
        tags: [],
      });
    } finally {
      db.close();
    }

    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/eval-cases?workspace=${WORKSPACE}`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: string;
      name: string;
      workspace: string;
      tags: string[];
      expected_output?: string;
      created_at: string;
    }>;
    expect(Array.isArray(body)).toBe(true);
    const stringCase = body.find((c) => c.name === 'echo-string');
    const objectCase = body.find((c) => c.name === 'echo-object');
    expect(stringCase).toBeDefined();
    expect(objectCase).toBeDefined();
    expect(stringCase!.workspace).toBe(WORKSPACE);
    expect(stringCase!.tags).toEqual(['smoke']);
    // string expected passes through verbatim.
    expect(stringCase!.expected_output).toBe('hello');
    // object expected stringified.
    expect(objectCase!.expected_output).toBe(JSON.stringify({ a: 1 }));
    // created_at as ISO string.
    expect(new Date(stringCase!.created_at).toString()).not.toBe('Invalid Date');
    // input dropped from the summary.
    expect((stringCase as Record<string, unknown>).input).toBeUndefined();
  });

  it('runs a suite and the returned light EvalRun is pollable via GET /evals/:id', async () => {
    const runRes = await fetch(`http://127.0.0.1:${port}/api/dashboard/evals/run`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: WORKSPACE }),
    });
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as {
      id: string;
      status: string;
      score?: number;
      cases_total: number;
      cases_passed: number;
      started_at: string;
      finished_at?: string;
    };
    expect(run.id).toMatch(/^er_/);
    // Echo runner + exact-match judge: both seeded cases pass.
    expect(run.cases_total).toBe(2);
    expect(run.cases_passed).toBe(2);
    expect(run.status).toBe('passed');
    expect(run.score).toBe(1);
    expect(new Date(run.started_at).toString()).not.toBe('Invalid Date');
    expect(run.finished_at).toBeDefined();

    // Polling target returns the SAME light shape.
    const getRes = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/evals/${run.id}`,
      { headers: authHeaders(token) },
    );
    expect(getRes.status).toBe(200);
    const polled = (await getRes.json()) as { id: string; status: string; cases_passed: number };
    expect(polled.id).toBe(run.id);
    expect(polled.status).toBe('passed');
    expect(polled.cases_passed).toBe(2);
    // Must NOT be the rich EvalRunDetails envelope.
    expect((polled as Record<string, unknown>).run).toBeUndefined();
    expect((polled as Record<string, unknown>).results).toBeUndefined();
  });

  it('honors case_ids subset when running a suite', async () => {
    // Look up one case id to run in isolation.
    const casesRes = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/eval-cases?workspace=${WORKSPACE}`,
      { headers: authHeaders(token) },
    );
    const cases = (await casesRes.json()) as Array<{ id: string; name: string }>;
    const single = cases.find((c) => c.name === 'echo-string')!;

    const runRes = await fetch(`http://127.0.0.1:${port}/api/dashboard/evals/run`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: WORKSPACE, case_ids: [single.id] }),
    });
    expect(runRes.status).toBe(200);
    const run = (await runRes.json()) as { cases_total: number; cases_passed: number };
    expect(run.cases_total).toBe(1);
    expect(run.cases_passed).toBe(1);
  });

  it('returns 404 for an unknown eval run id', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/evals/er_unknown`,
      { headers: authHeaders(token) },
    );
    expect(res.status).toBe(404);
  });

  it('rejects eval routes without a Bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/eval-cases`);
    expect([401, 403]).toContain(res.status);
  });
});
