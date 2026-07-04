// tests/unit/mock-opencode-acp-server.test.ts
//
// Wave 2 Agent L — smoke tests for the in-process opencode ACP mock server.
//
// These tests double as the canonical contract: they exercise the same
// JSON-RPC client logic that `scripts/runtime-resume-harness/opencode-acp-probe.mjs`
// runs against real opencode, but pointed at our mock. If a Wave 3 ACP
// adapter speaks the protocol the same way the probe + this client speak it,
// it will work against both real opencode AND the mock.

import { describe, it, expect } from 'vitest';

import { startMockOpencodeAcpServer } from '../fixtures/mock-opencode-acp-server.js';
import { AcpStdioClient, JsonRpcRequestError, type CapturedNotification } from '../fixtures/acp-stdio-client.js';

const TEST_TIMEOUT_MS = 5_000;

interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession: boolean;
    sessionCapabilities: {
      close: unknown;
      fork: unknown;
      list: unknown;
      resume: unknown;
    };
  };
  authMethods: unknown[];
}

interface SessionNewResult {
  sessionId: string;
}

describe('mock-opencode-acp-server', () => {
  it(
    'initialize success — returns protocolVersion + agentCapabilities',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const handle = await startMockOpencodeAcpServer();
      const client = new AcpStdioClient(handle.stdin, handle.stdout, { defaultTimeoutMs: 1_000 });
      try {
        const result = await client.request<InitializeResult>('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'mock-test', version: '0.0.0' },
        });

        expect(result.protocolVersion).toBe(1);
        expect(result.agentCapabilities.loadSession).toBe(true);
        // Canonical sessionCapabilities keys observed in the real opencode artifact.
        expect(Object.keys(result.agentCapabilities.sessionCapabilities).sort()).toEqual(
          ['close', 'fork', 'list', 'resume'],
        );
        expect(Array.isArray(result.authMethods)).toBe(true);

        // History must include the inbound request + outbound response, in order.
        expect(handle.history.length).toBeGreaterThanOrEqual(2);
        expect(handle.history[0].dir).toBe('in');
        expect(handle.history[1].dir).toBe('out');
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    'session/new success — returns deterministic sessionId',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const handle = await startMockOpencodeAcpServer();
      const client = new AcpStdioClient(handle.stdin, handle.stdout, { defaultTimeoutMs: 1_000 });
      try {
        await client.request('initialize', { protocolVersion: 1 });
        const result = await client.request<SessionNewResult>('session/new', {
          cwd: '/tmp/mock-cwd',
          mcpServers: [],
        });

        expect(typeof result.sessionId).toBe('string');
        // First session in a fresh server instance must be deterministic.
        expect(result.sessionId).toBe('mock-ses-1');
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    'session/new no-models — returns -32603 Internal error with details:"No models available"',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const handle = await startMockOpencodeAcpServer({
        scenarios: { sessionNew: 'no-models' },
      });
      const client = new AcpStdioClient(handle.stdin, handle.stdout, { defaultTimeoutMs: 1_000 });
      try {
        await client.request('initialize', { protocolVersion: 1 });

        const err = await client
          .request('session/new', { cwd: '/tmp/mock-cwd', mcpServers: [] })
          .then(
            () => {
              throw new Error('expected session/new to reject under no-models scenario');
            },
            (e: unknown) => e,
          );

        expect(err).toBeInstanceOf(JsonRpcRequestError);
        const rpcErr = (err as JsonRpcRequestError).jsonRpcError as {
          code: number;
          message: string;
          data?: { details?: string };
        };
        expect(rpcErr.code).toBe(-32603);
        expect(rpcErr.message).toBe('Internal error');
        expect(rpcErr.data?.details).toBe('No models available');
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    'session/prompt stream-3-then-complete — emits 3 message_chunks + 1 completed update + a result',
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const handle = await startMockOpencodeAcpServer();
      const client = new AcpStdioClient(handle.stdin, handle.stdout, { defaultTimeoutMs: 2_000 });
      try {
        await client.request('initialize', { protocolVersion: 1 });
        const newRes = await client.request<SessionNewResult>('session/new', {
          cwd: '/tmp/mock-cwd',
          mcpServers: [],
        });

        const collectedUpdates: CapturedNotification[] = [];
        client.onNotification((notif) => {
          if (notif.method === 'session/update') collectedUpdates.push(notif);
        });

        const promptResult = await client.request<{ stopReason: string }>('session/prompt', {
          sessionId: newRes.sessionId,
          prompt: [{ type: 'text', text: 'Reply with exactly the two characters: OK' }],
        });

        // We expect exactly 3 message_chunk updates + 1 completed update.
        const chunks = collectedUpdates.filter((u) => {
          const update = (u.params as { update?: { type?: string } } | undefined)?.update;
          return update?.type === 'message_chunk';
        });
        const completed = collectedUpdates.filter((u) => {
          const update = (u.params as { update?: { type?: string } } | undefined)?.update;
          return update?.type === 'completed';
        });

        expect(chunks.length).toBe(3);
        expect(completed.length).toBe(1);
        expect(promptResult.stopReason).toBe('end_turn');

        // Each update must carry the sessionId we passed in.
        for (const chunk of chunks) {
          const sid = (chunk.params as { sessionId?: string } | undefined)?.sessionId;
          expect(sid).toBe(newRes.sessionId);
        }

        // History captured every wire message (3 requests in + 3 responses out + 4 updates out = 10).
        const outFrames = handle.history.filter((h) => h.dir === 'out').length;
        expect(outFrames).toBeGreaterThanOrEqual(7); // 3 responses + 4 notifications
      } finally {
        await handle.stop();
      }
    },
  );
});
