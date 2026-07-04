/**
 * Wave 2 Agent M1-W2-C (B7, 2026-05-12) — POST /api/dashboard/preview-cost.
 *
 * Closes the dead UX bullet where AskScreen.tsx + CommandCenter.tsx
 * showed "~$0.XX" with a comment "preview cost API not yet wired".
 *
 * The heuristic is intentionally loose (±50% accuracy per the brief):
 *   tokens ≈ estimateTokens([{role:'user', content: objective}], model)
 *   total_input_tokens = tokens × 3   (decompose + tasks fan-out)
 *   usd               = estimateCost(model, total_input_tokens, 0)
 *
 * Tests pin:
 *   1. Happy path: a non-empty objective returns positive integers
 *      and a USD number that respects the chosen pricing tier.
 *   2. Auth gate: 401 without Bearer.
 *   3. Validation: empty objective → 400, oversized objective → 400.
 *   4. Model override: an explicit `model` field flows through and the
 *      cost respects that model's row in pricing.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  resolveToken,
  startHttpMcpServer,
  type ShutdownFn,
} from '../../src/mcp/http-server.js';
import { setDashboardPlannerForTests } from '../../src/mcp/dashboard-plan-ops.js';

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

describe('POST /api/dashboard/preview-cost — cost heuristic (B7)', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-cost-preview-${Date.now()}`);
  const dbPath = join(dataDir, 'omniforge.db');
  let originalDbPath: string | undefined;
  let originalTaskModel: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalDbPath = process.env.DB_PATH;
    originalTaskModel = process.env.TASK_MODEL;
    process.env.DB_PATH = dbPath;
    // Pin TASK_MODEL so the default-model case is deterministic.
    process.env.TASK_MODEL = 'cc/claude-sonnet-4-6';
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    setDashboardPlannerForTests(async () => JSON.stringify({
      status: 'plan_ready',
      workspace: 'internal',
      objective: 'noop',
      task_count: 0,
      plan: [],
      dag_json: JSON.stringify({ tasks: [] }),
    }));

    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
  });

  afterAll(async () => {
    await shutdown();
    setDashboardPlannerForTests(null);
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalTaskModel === undefined) delete process.env.TASK_MODEL;
    else process.env.TASK_MODEL = originalTaskModel;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns 401 without a Bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/preview-cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: 'plan a migration' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns a positive estimate for a non-empty objective with default TASK_MODEL', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/preview-cost?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'Migrate the auth service to passkeys, keep TOTP fallback during rollout.',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      estimated_tokens: number;
      estimated_usd: number;
      model: string;
      fanout_multiplier: number;
    };
    expect(body.estimated_tokens).toBeGreaterThan(0);
    expect(body.estimated_usd).toBeGreaterThan(0);
    expect(body.fanout_multiplier).toBe(3);
    // Default model from beforeAll env override.
    expect(body.model).toBe('cc/claude-sonnet-4-6');
  });

  it('rejects empty objective', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/preview-cost?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects objective over the 20K cap', async () => {
    const huge = 'x'.repeat(20_001);
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/preview-cost?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objective: huge }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/20K|20000|too long/i);
  });

  it('honors an explicit model override and prices accordingly', async () => {
    // cc/* prices ($3 input per Mtok) — given a short objective, the USD
    // should still be tiny but the model field must round-trip.
    const cc = await fetch(`http://127.0.0.1:${port}/api/dashboard/preview-cost?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'audit the workflow cancel path',
        model: 'cc/claude-opus-4-6',
      }),
    });
    expect(cc.status).toBe(200);
    const ccBody = await cc.json() as { estimated_usd: number; model: string };
    expect(ccBody.model).toBe('cc/claude-opus-4-6');
    expect(ccBody.estimated_usd).toBeGreaterThan(0);

    // cx/* prices ($1.25 input per Mtok) — should be cheaper for the same
    // input.
    const cx = await fetch(`http://127.0.0.1:${port}/api/dashboard/preview-cost?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: 'audit the workflow cancel path',
        model: 'cx/gpt-5.5',
      }),
    });
    expect(cx.status).toBe(200);
    const cxBody = await cx.json() as { estimated_usd: number; model: string };
    expect(cxBody.model).toBe('cx/gpt-5.5');
    expect(cxBody.estimated_usd).toBeLessThan(ccBody.estimated_usd);
  });
});
