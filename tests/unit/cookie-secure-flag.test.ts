// M1 / Wave 1-E (A9): Set-Cookie Secure attribute is emitted only when
// OMNIFORGE_BEHIND_TLS=true. On localhost (default) the cookie must NOT carry
// Secure because browsers refuse Secure cookies over plain HTTP, which would
// break the dashboard for the dogfood operator.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToken, startHttpMcpServer, type ShutdownFn } from '../../src/mcp/http-server.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer();
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

describe('dashboard Set-Cookie Secure flag', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-cookie-secure-${Date.now()}`);
  const originalBehindTls = process.env.OMNIFORGE_BEHIND_TLS;
  const originalDbPath = process.env.DB_PATH;
  const originalDaemonAuth = process.env.OMNIFORGE_DAEMON_AUTH;

  beforeEach(async () => {
    mkdirSync(dataDir, { recursive: true });
    process.env.DB_PATH = join(dataDir, 'omniforge.db');
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
  });

  afterEach(async () => {
    if (shutdown) await shutdown();
    if (originalBehindTls === undefined) delete process.env.OMNIFORGE_BEHIND_TLS;
    else process.env.OMNIFORGE_BEHIND_TLS = originalBehindTls;
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalDaemonAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalDaemonAuth;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    await sleep(50);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('does NOT set Secure when OMNIFORGE_BEHIND_TLS is unset (localhost default)', async () => {
    delete process.env.OMNIFORGE_BEHIND_TLS;
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);

    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('omniforge_daemon_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    // The negative assertion is the heart of this test: localhost MUST NOT
    // get Secure or browsers will reject the cookie.
    expect(setCookie).not.toMatch(/;\s*Secure(\b|$)/);
  });

  it('sets Secure when OMNIFORGE_BEHIND_TLS=true (production behind TLS)', async () => {
    process.env.OMNIFORGE_BEHIND_TLS = 'true';
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);

    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('omniforge_daemon_token=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toMatch(/;\s*Secure(\b|$)/);
  });

  it('does NOT set Secure when OMNIFORGE_BEHIND_TLS is any non-"true" value', async () => {
    // Explicit guard against accidental truthy values: only the literal "true"
    // unlocks Secure. Operators with `OMNIFORGE_BEHIND_TLS=1` or `=yes`
    // should not get a broken cookie silently.
    process.env.OMNIFORGE_BEHIND_TLS = '1';
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);

    const res = await fetch(`http://127.0.0.1:${port}/dashboard?token=${token}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toMatch(/;\s*Secure(\b|$)/);
  });
});
