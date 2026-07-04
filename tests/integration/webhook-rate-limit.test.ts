// M1 / Wave 1-E (A8): public webhook endpoint must enforce per-slug rate
// limiting BEFORE HMAC verification. A flood of requests on a known slug
// (even with bad signatures) must not exercise the DB or downstream dispatch.
//
// Flow under test:
//   - Burn through the bucket (default 10/min/slug).
//   - Next request returns HTTP 429 with `Retry-After` header.
//   - Emits a `webhook_rate_limited` event on the _daemon stream.
//
// Note: we use a low-RPM override (WEBHOOK_RATE_LIMIT_RPM=3) to keep the
// test fast and deterministic.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { initDb } from '../../src/db/client.js';
import { removeTempDirSafe } from './_temp-dir.js';

// P3 test-harness stability: spinning the HTTP daemon (startHttpMcpServer
// applies all migrations against a fresh WAL DB) routinely exceeds the global
// 15s hookTimeout on slower CI/Windows runners, surfacing as the flaky
// "Hook timed out in 15000ms". Give beforeAll a generous explicit budget.
const SETUP_HOOK_TIMEOUT_MS = 60_000;

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

describe('webhook rate limit (POST /webhooks/:slug)', () => {
  let shutdown: () => Promise<void>;
  let port: number;
  let token: string;
  let slug: string;
  const dataDir = join(tmpdir(), `omniforge-webhook-ratelimit-${Date.now()}`);
  const dbPath = join(dataDir, 'omniforge.db');
  let originalDbPath: string | undefined;
  let originalDaemonAuth: string | undefined;
  let originalRpm: string | undefined;

  // Use 3 rpm for a fast deterministic test. With the default 60-second
  // bucket, 4 requests fired in a tight loop will exhaust the bucket.
  const RPM_FOR_TEST = 3;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalDbPath = process.env.DB_PATH;
    originalDaemonAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    originalRpm = process.env.WEBHOOK_RATE_LIMIT_RPM;
    process.env.DB_PATH = dbPath;
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    process.env.WEBHOOK_RATE_LIMIT_RPM = String(RPM_FOR_TEST);

    // Import server module AFTER env mutation so the module-level
    // `const WEBHOOK_RATE_LIMIT_RPM = Number(env.WEBHOOK_RATE_LIMIT_RPM)`
    // sees the test value.
    const { resolveToken, startHttpMcpServer } = await import('../../src/mcp/http-server.js');
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);

    // Create one webhook so the receive endpoint matches a real slug.
    const createRes = await fetch(`http://127.0.0.1:${port}/api/dashboard/triggers/webhooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'rate-limit-target',
        slug: 'rate-limit-target',
        workspace: 'internal',
        target_ref: 'No-op target',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { webhook: { slug: string } };
    slug = created.webhook.slug;
  }, SETUP_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (shutdown) await shutdown();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalDaemonAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalDaemonAuth;
    if (originalRpm === undefined) delete process.env.WEBHOOK_RATE_LIMIT_RPM;
    else process.env.WEBHOOK_RATE_LIMIT_RPM = originalRpm;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    // Give Windows time to release the WAL/SHM handles closed above before we
    // delete the dir; removeTempDirSafe adds the retry + swallow safety net.
    await sleep(200);
    removeTempDirSafe(dataDir);
  }, SETUP_HOOK_TIMEOUT_MS);

  it('returns 429 once the per-slug bucket is exhausted', async () => {
    // Fire RPM_FOR_TEST + 2 requests in sequence. All are unsigned so HMAC
    // would normally reject them with 401 — but the rate limiter runs FIRST,
    // so the last requests must come back 429.
    const responses: { status: number; retryAfter: string | null; body: string }[] = [];
    for (let i = 0; i < RPM_FOR_TEST + 2; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flood_index: i }),
      });
      responses.push({
        status: res.status,
        retryAfter: res.headers.get('retry-after'),
        body: await res.text(),
      });
    }

    // First RPM_FOR_TEST responses must NOT be 429 (token was available;
    // they get 401 because the signature is missing/invalid).
    for (let i = 0; i < RPM_FOR_TEST; i += 1) {
      expect(responses[i]!.status).not.toBe(429);
    }

    // The (RPM_FOR_TEST + 1)-th onward MUST be 429 with a Retry-After header.
    const limited = responses[RPM_FOR_TEST];
    expect(limited).toBeDefined();
    expect(limited!.status).toBe(429);
    expect(limited!.retryAfter).not.toBeNull();
    expect(Number(limited!.retryAfter)).toBeGreaterThan(0);
    expect(limited!.body).toContain('rate_limited');
  });

  it('emits webhook_rate_limited event on _daemon stream', async () => {
    // The previous test already pushed the limiter over the cap, so the
    // event should be in the DB. We re-query rather than firing again to
    // keep this test independent of bucket state.
    const db = initDb(dbPath);
    try {
      const row = db.prepare(
        `SELECT type, payload_json FROM events
          WHERE workflow_id = '_daemon' AND type = 'webhook_rate_limited'
          ORDER BY id DESC LIMIT 1`,
      ).get() as { type: string; payload_json: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.type).toBe('webhook_rate_limited');
      const payload = JSON.parse(row!.payload_json) as {
        slug: string;
        retry_after_ms: number;
        rpm_limit: number;
      };
      expect(payload.slug).toBe('rate-limit-target');
      expect(payload.retry_after_ms).toBeGreaterThan(0);
      expect(payload.rpm_limit).toBe(RPM_FOR_TEST);
    } finally {
      db.close();
    }
  });
});
