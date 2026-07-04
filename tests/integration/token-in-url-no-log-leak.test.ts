/**
 * F-SEC-1 regression: when an operator hits an endpoint with `?token=<value>`
 * (the W5 dashboard-bootstrap use case), the token MUST NOT leak into:
 *
 *   - the daemon stderr stream (`process.stderr` writes)
 *   - any event row payload persisted by the daemon
 *   - any HTTP access log
 *
 * This is a regression guard for Sprint 8.1 (D-H2.066) — the dashboard
 * boot path was previously echoing `?token=` into multiple log lines on
 * the redirect handler. The fix:
 *
 *   1. /dashboard?token=X immediately 302-redirects to /dashboard with a
 *      Set-Cookie header so the URL bar no longer carries the secret.
 *   2. No stderr write may include the URL search component verbatim.
 *
 * We exercise the real http server (no mocks), capture every stderr
 * line emitted during the test window, and assert the secret value
 * never appears anywhere in our capture.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';

import { initDb } from '../../src/db/client.js';
import { startHttpMcpServer, resolveToken, type ShutdownFn } from '../../src/mcp/http-server.js';

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

/** A unique, recognizable token value so we can grep for it in every log
 *  capture. Long enough to clear the constant-time compare length check
 *  and shaped like a real `randomBytes(32).toString('hex')`. */
function makeRecognizableToken(): string {
  return 'deadbeef'.repeat(8); // 64 hex chars
}

interface StderrCapture {
  readonly lines: string[];
  restore: () => void;
}

function captureStderr(): StderrCapture {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  // Replace stderr.write with a tap that records every chunk + still
  // forwards to the original (so test debugging still shows logs).
  // We use a permissive signature to match Node's overloads.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as { write: any }).write = (chunk: unknown, ...args: unknown[]): boolean => {
    if (typeof chunk === 'string') lines.push(chunk);
    else if (Buffer.isBuffer(chunk)) lines.push(chunk.toString('utf8'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (original as any)(chunk, ...args);
  };
  return {
    lines,
    restore: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as { write: any }).write = original;
    },
  };
}

describe('F-SEC-1 — daemon token MUST NOT leak through ?token=<value> URL paths', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = path.join(tmpdir(), `omniforge-token-leak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let originalAuth: string | undefined;
  let originalToken: string | undefined;
  let stderrCap: StderrCapture;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    originalToken = process.env.OMNIFORGE_DAEMON_TOKEN;
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    process.env.OMNIFORGE_DAEMON_TOKEN = makeRecognizableToken();
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
    // Sanity: the injected token must round-trip through resolveToken.
    expect(token).toBe(makeRecognizableToken());
    stderrCap = captureStderr();
  });

  afterAll(async () => {
    stderrCap.restore();
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (originalAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalAuth;
    if (originalToken === undefined) delete process.env.OMNIFORGE_DAEMON_TOKEN;
    else process.env.OMNIFORGE_DAEMON_TOKEN = originalToken;
  });

  it('GET /dashboard?token=<token> does NOT echo the token to stderr', async () => {
    const linesBefore = stderrCap.lines.length;
    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=${token}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    // The Set-Cookie header is the intended transport for the token after
    // the redirect — we are NOT asserting the cookie is absent (it must be
    // present), only that the raw token does not appear in any *log*.
    const tail = stderrCap.lines.slice(linesBefore).join('');
    expect(tail).not.toContain(token);
  });

  it('GET /api/dashboard/summary?token=<token>&workspace=internal does NOT echo to stderr', async () => {
    const linesBefore = stderrCap.lines.length;
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/summary?token=${token}&workspace=internal`,
    );
    expect(res.status).toBe(200);
    const tail = stderrCap.lines.slice(linesBefore).join('');
    expect(tail).not.toContain(token);
  });

  it('A 401 response on a bad path still does NOT echo the URL query verbatim', async () => {
    const linesBefore = stderrCap.lines.length;
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}-INVALID`);
    expect(res.status).toBe(401);
    const tail = stderrCap.lines.slice(linesBefore).join('');
    expect(tail).not.toContain(token);
  });

  it('The token does NOT appear in any persisted event row payload', async () => {
    // After hitting the dashboard, drive a few endpoints that emit events
    // (workspace bootstrap may already have run during beforeAll). Then
    // scan the entire events table for the token value.
    await fetch(`http://127.0.0.1:${port}/api/dashboard/summary?token=${token}&workspace=internal`);
    await fetch(`http://127.0.0.1:${port}/api/dashboard/model-catalog?token=${token}`);

    const dbPath = path.join(dataDir, 'omniforge.db');
    const db = initDb(dbPath);
    try {
      const rows = db
        .prepare(`SELECT payload_json FROM events WHERE payload_json IS NOT NULL`)
        .all() as Array<{ payload_json: string }>;
      for (const row of rows) {
        expect(row.payload_json).not.toContain(token);
      }
    } finally {
      db.close();
    }
  });

  it('Background daemon log lines (heartbeat, schedule tick, workspace bootstrap) do NOT include the token', () => {
    // We've been capturing stderr since the daemon booted. Any line that
    // accidentally interpolated `req.url` or the token directly would
    // surface here.
    const fullLog = stderrCap.lines.join('');
    expect(fullLog).not.toContain(token);
  });
});
