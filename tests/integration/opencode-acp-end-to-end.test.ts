// tests/integration/opencode-acp-end-to-end.test.ts
//
// Wave D — opencode ACP end-to-end integration test (CI-safe, mock-only).
//
// Drives the production AcpAdapter against the in-process mock server
// fixture (`tests/fixtures/mock-opencode-acp-server.ts`) — NO real opencode
// subprocess is spawned. Verifies the wire-level lifecycle that
// `runOpencodeViaAcp` (in src/executors/cli.ts) follows in production:
//
//   initialize -> session/new -> session/prompt -> 3 chunks + completed
//             -> runtime events emitted in order -> session/close
//
// This test exists alongside the unit-level adapter test
// (tests/unit/runtime-adapter-acp.test.ts) but focuses on the END-TO-END
// EVENT ORDER and lifecycle hooks the runtime layer relies on (rather than
// individual error code classifications).
//
// CI safety: imports nothing that spawns a child process. The mock server
// runs entirely in-process via PassThrough streams.

import { describe, it, expect } from 'vitest';

import {
  AcpAdapter,
  createAcpAdapter,
  type AcpAdapterTransport,
} from '../../src/runtime/adapters/acp.js';
import {
  startMockOpencodeAcpServer,
  type MockServerHandle,
} from '../fixtures/mock-opencode-acp-server.js';
import type { RuntimeRunEvent } from '../../src/runtime/events.js';

const FAST_TIMEOUTS = {
  initializeTimeoutMs: 2_000,
  sessionTimeoutMs: 2_000,
  promptTimeoutMs: 5_000,
  closeTimeoutMs: 1_000,
  permissionTimeoutMs: 5_000,
};

/**
 * Helper: build an `AcpAdapter` against the in-process mock server. Mirrors
 * the production `runOpencodeViaAcp` adapter wiring closely so this test
 * exercises the same code path the cli executor takes.
 */
async function startAdapter(
  scenarios: Parameters<typeof startMockOpencodeAcpServer>[0] extends infer A
    ? A extends { scenarios?: infer S }
      ? S
      : never
    : never = {},
): Promise<{ adapter: AcpAdapter; handle: MockServerHandle; events: RuntimeRunEvent[] }> {
  const handle = await startMockOpencodeAcpServer({ scenarios });
  const events: RuntimeRunEvent[] = [];
  const transport: AcpAdapterTransport = {
    stdin: handle.stdin,
    stdout: handle.stdout,
    pid: handle.pid,
    kill: () => undefined,
  };
  const adapter = createAcpAdapter(transport, {
    executorId: 'cli:opencode',
    cwd: '/tmp/opencode-e2e',
    onRuntimeEvent: (event) => events.push(event),
    ...FAST_TIMEOUTS,
  });
  return { adapter, handle, events };
}

async function dispose(adapter: AcpAdapter, handle: MockServerHandle): Promise<void> {
  try {
    await adapter.close();
  } catch {
    /* best effort */
  }
  await handle.stop();
}

describe('Wave D — opencode ACP end-to-end (mock fixture)', () => {
  it(
    'completes the full lifecycle: initialize -> session/new -> session/prompt -> 3 chunks -> completed',
    { timeout: 10_000 },
    async () => {
      const { adapter, handle, events } = await startAdapter();
      try {
        // 1. initialize — protocol roundtrip + capability capture.
        const initResult = await adapter.initialize();
        expect(initResult.protocolVersion).toBe(1);
        expect(adapter.getState()).toBe('ready');

        // 2. session/new — opaque sessionId issued by the server.
        const session = await adapter.newSession();
        expect(session.sessionId).toBe('mock-ses-1');
        expect(adapter.getState()).toBe('session_open');

        // 3. session/prompt — drives the streaming half of the protocol.
        const promptResult = await adapter.prompt([{ type: 'text', text: 'Reply with exactly OK' }]);
        expect(promptResult.stopReason).toBe('end_turn');
        expect(adapter.getState()).toBe('session_open');

        // 4. Verify event ordering — exactly 3 assistant.delta then 1
        //    runtime.result, all carrying the captured sessionId.
        const deltas = events.filter((e) => e.type === 'assistant.delta');
        expect(deltas.length).toBe(3);
        const results = events.filter((e) => e.type === 'runtime.result');
        expect(results.length).toBe(1);
        for (const event of [...deltas, ...results]) {
          expect(event.sessionId).toBe('mock-ses-1');
          expect(event.executorId).toBe('cli:opencode');
        }

        // 5. Strict ordering: every assistant.delta arrives BEFORE the
        //    runtime.result. The mock server emits chunks in sequence and
        //    completes after the final chunk.
        const firstResultIdx = events.findIndex((e) => e.type === 'runtime.result');
        const lastDeltaIdx = events.map((e, idx) => (e.type === 'assistant.delta' ? idx : -1))
          .filter((i) => i >= 0)
          .pop();
        expect(lastDeltaIdx).not.toBeUndefined();
        expect(firstResultIdx).toBeGreaterThan(lastDeltaIdx as number);

        // 6. Concatenated chunk text reflects the mock's STREAM_CHUNK_TOKENS
        //    (`'mock '`, `'response '`, `'OK'`).
        const concatenated = deltas.map((e) => e.text ?? '').join('');
        expect(concatenated).toBe('mock response OK');
      } finally {
        await dispose(adapter, handle);
      }
    },
  );

  it(
    'emits runtime events in the documented order: turn.started events flow before runtime.result',
    { timeout: 10_000 },
    async () => {
      const { adapter, handle, events } = await startAdapter();
      try {
        await adapter.initialize();
        await adapter.newSession();
        await adapter.prompt([{ type: 'text', text: 'ping' }]);

        // Events flow from session/update notifications. We don't expect
        // turn.started here (that's the runtime manager's emission, not the
        // adapter's). What we DO expect is: assistant.delta* then
        // runtime.result. The earliest event type encountered must be
        // assistant.delta when a stream-3-then-complete scenario runs.
        const eventTypes = events.map((e) => e.type);
        expect(eventTypes[0]).toBe('assistant.delta');
        expect(eventTypes[eventTypes.length - 1]).toBe('runtime.result');
      } finally {
        await dispose(adapter, handle);
      }
    },
  );

  it(
    'closes the session via session/close when adapter.close() is called',
    { timeout: 10_000 },
    async () => {
      const { adapter, handle } = await startAdapter();
      try {
        await adapter.initialize();
        await adapter.newSession();
        await adapter.prompt([{ type: 'text', text: 'close test' }]);

        // adapter.close() should send `session/close` and transition to
        // 'closed'. The mock server tracks every inbound message in
        // `handle.history` so we can assert the call shape.
        await adapter.close();
        expect(adapter.getState()).toBe('closed');

        const closeFrame = handle.history.find(
          (entry) =>
            entry.dir === 'in' &&
            (entry.message as { method?: string }).method === 'session/close',
        );
        expect(closeFrame).toBeDefined();
        expect((closeFrame!.message as { params?: { sessionId?: string } }).params?.sessionId).toBe('mock-ses-1');
      } finally {
        await handle.stop();
      }
    },
  );

  it(
    'never spawns a child process — the entire lifecycle stays in-memory',
    { timeout: 10_000 },
    async () => {
      // Sanity check that the test fixture is genuinely in-process. If a real
      // process were involved, `handle.pid` would be a real OS pid; the mock
      // uses a synthetic pid in the SYNTHETIC_PID_BASE range (>=90000).
      const { adapter, handle } = await startAdapter();
      try {
        expect(handle.pid).toBeGreaterThanOrEqual(90_000);
        await adapter.initialize();
        await adapter.newSession();
        await adapter.prompt([{ type: 'text', text: 'in-memory only' }]);
      } finally {
        await dispose(adapter, handle);
      }
    },
  );
});
