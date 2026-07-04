// Tier 0 Wave 4 (item 0.5): tests for the advisor POST endpoints.
//
// Covers:
//   1. Sync advisor (chat)      → 200 + { advisor, output, ... }
//   2. Sync advisor bad input    → 400 + structured error
//   3. Stepwise advisor (debug)  → SSE stream with `step` start, `step`
//                                  complete, and a final `done` event.
//   4. Sync advisor unknown name → 404 + unknown_advisor code
//   5. Conversation GET fallback → 404 for unknown id
//
// All advisor LLM dispatch goes through callOmniroute / callOmnirouteWithUsage
// which we stub before any advisor module loads. Tests boot the full
// http-server so we exercise the auth gate + router chain as wired.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi
    .fn()
    .mockResolvedValue('# Advisor stub output\n\nNothing happened upstream — this is a unit-test stub.'),
  callOmnirouteWithUsage: vi.fn().mockResolvedValue({
    content: '# Advisor stub output',
    model_used: 'cc/claude-sonnet-4-6',
    usage: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.0007 },
  }),
}));

import { resolveToken, startHttpMcpServer, type ShutdownFn } from '../../src/mcp/http-server.js';

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

describe('POST /api/dashboard/advisors/:advisor/call', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-advisors-route-${Date.now()}`);
  const dbPath = join(dataDir, 'omniforge.db');
  let originalDbPath: string | undefined;
  let originalDaemonAuth: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalDbPath = process.env.DB_PATH;
    originalDaemonAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    process.env.DB_PATH = dbPath;
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;

    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
  });

  afterAll(async () => {
    await shutdown();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalDaemonAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalDaemonAuth;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    await sleep(100);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns 200 + advisor output for the sync chat advisor', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/advisors/chat/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        input: { prompt: 'Hello there, advisor.' },
        workspace: 'internal',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      advisor: string;
      output: string;
    };
    expect(body.advisor).toBe('chat');
    expect(typeof body.output).toBe('string');
    expect(body.output.length).toBeGreaterThan(0);
  });

  it('returns 400 with structured error on Zod validation failure', async () => {
    // Chat advisor requires a non-empty `prompt`. Empty string trips the
    // schema's min(1) check; the route must surface it as 400.
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/advisors/chat/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ input: { prompt: '' } }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('invalid_input');
    expect(typeof body.error.message).toBe('string');
  });

  it('returns 404 + unknown_advisor for an unregistered advisor name', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/advisors/nonexistent/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ input: { prompt: 'irrelevant' } }),
    });

    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('unknown_advisor');
  });

  it('streams SSE events for the stepwise debug advisor', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/advisors/debug/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        input: {
          prompt: 'My test fails intermittently when running in parallel.',
        },
        workspace: 'internal',
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.body).not.toBeNull();

    // Drain the stream and collect event-type frames.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let raw = '';
    while (true) {
      const { value, done } = await reader.read();
      if (value) raw += decoder.decode(value, { stream: true });
      if (done) break;
    }

    const eventTypes: string[] = [];
    const dones: string[] = [];
    let currentEvent: string | null = null;
    let currentData: string[] = [];
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line === '') {
        if (currentEvent) {
          eventTypes.push(currentEvent);
          if (currentEvent === 'done') dones.push(currentData.join('\n'));
        }
        currentEvent = null;
        currentData = [];
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        currentEvent = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        currentData.push(line.slice('data:'.length).trim());
      }
    }

    // At minimum: 2 step frames (start + complete) and 1 done = 3+ events.
    expect(eventTypes.length).toBeGreaterThanOrEqual(3);
    expect(eventTypes.filter((e) => e === 'step').length).toBeGreaterThanOrEqual(2);
    expect(eventTypes.filter((e) => e === 'done').length).toBe(1);

    // The done payload must include the advisor name and the stubbed output.
    expect(dones.length).toBe(1);
    const donePayload = JSON.parse(dones[0]) as {
      advisor: string;
      output: string;
      conversation_id: string;
    };
    expect(donePayload.advisor).toBe('debug');
    expect(typeof donePayload.output).toBe('string');
    expect(donePayload.output.length).toBeGreaterThan(0);
    expect(typeof donePayload.conversation_id).toBe('string');
    expect(donePayload.conversation_id.length).toBeGreaterThan(0);
  });

  it('returns 401 when the Bearer is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/advisors/chat/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { prompt: 'hi' } }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 404 + JSON for an unknown conversation id', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/advisor-conversations/ac_does_not_exist`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not found');
  });
});
