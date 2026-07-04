/**
 * F-SEC-2 regression: every /dashboard/* static asset MUST require Bearer
 * auth. Sprint 3.1 (D-H2.066) moved the dashboard static router from the
 * pre-auth chain to the post-auth chain so that anonymous probing can no
 * longer leak the UI version, bundle internals, or sniff which build is
 * deployed.
 *
 * Three asset surfaces exist:
 *
 *   1. /dashboard               (HTML shell)
 *   2. /dashboard/styles.css    (inline-fallback CSS)
 *   3. /dashboard/app.js        (inline-fallback JS)
 *   4. /dashboard/assets/<vite-hashed-name>.{js,css}  (built bundle)
 *
 * All four must return 401 without a token and 200 with the cookie
 * (the production credential after the W14 redirect handshake) OR a
 * Bearer header OR a `?token=` query.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import path from 'node:path';

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

/** Find the first asset path of the requested extension referenced from
 *  the rendered dashboard shell. Returns null if the legacy inline shell
 *  is being served (which has no `/dashboard/assets/...` references). */
function firstBuiltAssetPath(html: string, extension: 'js' | 'css'): string | null {
  const m = html.match(new RegExp(`/dashboard/assets/[^"']+\.${extension}`));
  return m ? m[0] : null;
}

describe('F-SEC-2 — /dashboard/* static assets require Bearer (Sprint 3.1)', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = path.join(tmpdir(), `omniforge-assets-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (originalAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalAuth;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
  });

  it('GET /dashboard WITHOUT auth → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`);
    expect(res.status).toBe(401);
  });

  it('GET /dashboard/styles.css WITHOUT auth → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/styles.css`);
    expect(res.status).toBe(401);
  });

  it('GET /dashboard/app.js WITHOUT auth → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/app.js`);
    expect(res.status).toBe(401);
  });

  it('GET /dashboard/styles.css WITH cookie → 200 + correct content-type', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/styles.css`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('GET /dashboard/app.js WITH cookie → 200 + application/javascript', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/app.js`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('GET /dashboard WITH cookie → 200 + text/html', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /dashboard/assets/<built-bundle>.js WITHOUT auth → 401', async () => {
    // First fetch the shell (authenticated) so we can discover the actual
    // hashed asset path. If the built dashboard-v2 bundle isn't shipped
    // in this snapshot, the inline fallback HTML has no assets/ paths and
    // we skip the assertion (covered by /dashboard/app.js above).
    const shell = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    const html = await shell.text();
    const assetPath = firstBuiltAssetPath(html, 'js');
    if (!assetPath) {
      // Built dashboard-v2 not available in this test run — inline-fallback
      // shell is what we got. The /dashboard/app.js coverage above is
      // sufficient.
      return;
    }
    const res = await fetch(`http://127.0.0.1:${port}${assetPath}`);
    expect(res.status).toBe(401);
  });

  it('GET /dashboard/assets/<built-bundle>.js WITH cookie → 200 + application/javascript', async () => {
    const shell = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    const html = await shell.text();
    const assetPath = firstBuiltAssetPath(html, 'js');
    if (!assetPath) return;
    const res = await fetch(`http://127.0.0.1:${port}${assetPath}`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('GET /dashboard/assets/<built-bundle>.css WITHOUT auth → 401', async () => {
    const shell = await fetch(`http://127.0.0.1:${port}/dashboard`, {
      headers: { Cookie: `omniforge_daemon_token=${token}` },
    });
    const html = await shell.text();
    const assetPath = firstBuiltAssetPath(html, 'css');
    if (!assetPath) return;
    const res = await fetch(`http://127.0.0.1:${port}${assetPath}`);
    expect(res.status).toBe(401);
  });

  it('Bearer header is an alternative credential — 200 with proper Authorization', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/app.js`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('Wrong cookie → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/styles.css`, {
      headers: { Cookie: 'omniforge_daemon_token=not-the-real-token' },
    });
    expect(res.status).toBe(401);
  });

  it('Empty Authorization header → 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/dashboard/styles.css`, {
      headers: { Authorization: '' },
    });
    expect(res.status).toBe(401);
  });
});
