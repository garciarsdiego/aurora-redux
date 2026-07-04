// Sprint 5.4 (D-H2.066, F-AUDIT gap): daemon graceful shutdown.
//
// The audit flagged that no test exercised the shutdown function returned
// by startHttpMcpServer. This test starts the daemon, registers an actor,
// triggers shutdown, and asserts: (1) actor registry was cleared,
// (2) HTTP server stopped accepting new connections, (3) shutdown
// resolved without throwing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';
import { startHttpMcpServer, resolveToken, __testing__ } from '../../src/mcp/http-server.js';

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

describe('daemon graceful shutdown (F-REL gap)', () => {
  const dataDir = path.join(tmpdir(), `omniforge-shutdown-${Date.now()}`);
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

  it('clears actor registry, stops accepting connections, resolves cleanly', async () => {
    // 1. Health check works pre-shutdown
    const healthBefore = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthBefore.status).toBe(200);

    // 2. Register an actor so we have something in the registry
    const reg = await fetch(`http://127.0.0.1:${port}/actor/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'cli' }),
    });
    expect(reg.status).toBe(200);
    const regBody = await reg.json() as { actor_token: string };
    expect(__testing__.actorRegistry.has(regBody.actor_token)).toBe(true);

    // 3. Trigger graceful shutdown
    const shutdownPromise = shutdown();
    await expect(shutdownPromise).resolves.toBeUndefined();

    // 4. Actor registry was cleared
    expect(__testing__.actorRegistry.size).toBe(0);
    expect(__testing__.llmStreamsByActor.size).toBe(0);

    // 5. HTTP server is no longer accepting connections.
    // fetch should fail with ECONNREFUSED / network error.
    let connectError: unknown = null;
    try {
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
    } catch (err) {
      connectError = err;
    }
    expect(connectError).not.toBeNull();
  });
});
