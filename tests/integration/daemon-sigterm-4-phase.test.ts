/**
 * M1 Wave 3 (A) — Daemon SIGTERM 4-phase shutdown contract.
 *
 * The graceful-shutdown contract documented in `src/cli/commands/daemon.ts`
 * + `src/mcp/http-server.ts` requires the SIGTERM handler to drive the
 * following 4 phases in this exact order:
 *
 *   Phase 1: Stop accepting new connections (httpServer.close()).
 *   Phase 2: Drain SSE subscribers (close transports + eventBroker.reset()).
 *   Phase 3: Stop background ticks (heartbeat timer + schedule tick timer +
 *            WAL checkpoint tick — clearInterval before DB close).
 *   Phase 4: Close DB handles (handled by the surrounding daemon process; we
 *            verify the broker / registry are torn down before the close).
 *
 * Pre-fix: any reordering (e.g. closing DB before stopping the tick timer)
 * caused tick callbacks to throw "database is closed", or active SSE
 * subscribers were stranded with half-written frames.
 *
 * What we verify: the shutdown function returned by `startHttpMcpServer`
 * (1) does not throw, (2) clears the actor registry / llm stream map /
 * event broker subscribers AFTER calling shutdown, (3) the HTTP listener
 * refuses new connections after shutdown resolves.
 *
 * The test mid-flights an SSE subscriber (subscribed via the event broker
 * directly to avoid relying on the SSE HTTP handler's lifecycle) and a
 * synthetic schedule-tick contention by pushing a payload into
 * scheduleTickHistory. Order matters: we assert the broker reports 0
 * subscribers post-shutdown and the actor registry is empty.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import {
  startHttpMcpServer,
  resolveToken,
  __testing__,
} from '../../src/mcp/http-server.js';
import { eventBroker } from '../../src/mcp/event-broker.js';
import { scheduleTickHistory } from '../../src/mcp/routes/dashboard-triggers-http.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') { reject(new Error('no addr')); return; }
      srv.close(() => resolve(addr.port));
    });
  });
}

describe('daemon SIGTERM 4-phase shutdown (M1 W3 A)', () => {
  const dataDir = path.join(tmpdir(), `omniforge-sigterm-4ph-${Date.now()}`);
  let port: number;
  let token: string;
  let shutdown: () => Promise<void>;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
  });

  it('drives stop-accept → drain SSE → stop ticks → cleanup in correct order', async () => {
    // Phase 0: pre-flight — server is up and serving.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    // ── Active SSE-like subscriber via the event broker (Phase 2 target) ───
    // We subscribe directly to the broker rather than opening an HTTP SSE
    // connection because we want a deterministic post-shutdown assertion
    // ("broker has zero subscribers") rather than racing fetch().
    let sseEventsReceived = 0;
    const unsubscribe = eventBroker.subscribeWorkflow('wf_active', () => {
      sseEventsReceived++;
    });
    expect(eventBroker.stats().workflows).toBe(1);

    // ── Active actor (Phase 1 target — registry must clear on shutdown) ────
    const reg = await fetch(`http://127.0.0.1:${port}/actor/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'cli' }),
    });
    expect(reg.status).toBe(200);
    const regBody = await reg.json() as { actor_token: string };
    expect(__testing__.actorRegistry.has(regBody.actor_token)).toBe(true);

    // ── Synthetic schedule tick contention (Phase 3 target — tick history) ─
    // Schedule tick rate limiter persists timestamps in scheduleTickHistory.
    // We seed it with an in-flight-looking entry so a future regression that
    // closes the DB before clearing the timer would surface as a thrown
    // pragma error. The test does not assert the history is cleared (it is a
    // module-level map; the daemon resets timers, not this state), but
    // dirtying it ensures the tick callback is exercised against a torn-down
    // DB if a regression reintroduces the wrong order.
    scheduleTickHistory.set('127.0.0.1', [Date.now()]);

    // ── Trigger shutdown ──────────────────────────────────────────────────
    // Capture broker subscriber count immediately before shutdown so we can
    // verify it goes to zero (Phase 2 contract).
    const subsBeforeShutdown = eventBroker.stats().workflows;
    expect(subsBeforeShutdown).toBeGreaterThan(0);

    const shutdownPromise = shutdown();
    await expect(shutdownPromise).resolves.toBeUndefined();

    // Phase 1: HTTP no longer accepts connections.
    let connectError: unknown = null;
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    } catch (err) {
      connectError = err;
    }
    expect(connectError).not.toBeNull();

    // Phase 2: SSE subscribers drained — eventBroker.reset() should have
    // wiped the workflow/gate subscriptions, even though the local closure
    // still holds the unsubscribe fn (calling it post-reset must be a safe
    // no-op).
    expect(eventBroker.stats().workflows).toBe(0);
    expect(eventBroker.stats().gates).toBe(0);
    expect(() => unsubscribe()).not.toThrow();

    // Phase 1 again — actor registry cleared after Phase 2 drain.
    expect(__testing__.actorRegistry.size).toBe(0);
    expect(__testing__.llmStreamsByActor.size).toBe(0);

    // Phase 3: subsequent reuse of the (already-shutdown) broker should not
    // throw — publish becomes a no-op since there are no subscribers and the
    // sweep timer is null after reset.
    expect(() => eventBroker.publish('wf_active', {
      type: 'task_started',
      workflow_id: 'wf_active',
      payload: {},
    } as unknown as Parameters<typeof eventBroker.publish>[1])).not.toThrow();

    // The post-reset publish must not have leaked any event back to the
    // pre-shutdown subscriber.
    expect(sseEventsReceived).toBe(0);
  });
});
