/**
 * De-mock coverage for the cost/benchmark stack (MCP-01/02/03, OPS-05/08).
 *
 * Pins the load-bearing primitives the MCP cost tools were repointed onto:
 *   1. CostDatabase.getRealSpendByModel / getTotalRealSpend aggregate REAL
 *      spend from the usage_costs + model_calls ledgers (NOT pricing rates),
 *      union the two ledgers by model, and fail safe to [] on a fresh DB.
 *   2. getCatalogQuality sources model quality from the live provider matrix
 *      (capability registry) instead of a stale hardcoded map.
 *   3. RealTimeCostTracker no longer exposes the pseudo-random fake streamer
 *      (trackTokenStream) — the dead path is gone; recordStreamUsage records
 *      a REAL measured delta instead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../src/db/client.js';

let tmpDir: string;
let prevDbPath: string | undefined;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cost-demock-'));
  prevDbPath = process.env.DB_PATH;
  process.env.DB_PATH = join(tmpDir, 'cost-demock.db');
  // Run migrations so usage_costs / model_calls / model_costs exist.
  initDb(process.env.DB_PATH).close();
});

afterAll(() => {
  if (prevDbPath === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = prevDbPath;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort temp cleanup
  }
});

function seedWorkflow(db: ReturnType<typeof initDb>, wfId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, 'internal', 'demock', 'completed', ?)`,
  ).run(wfId, Date.now());
}

describe('CostDatabase real-spend aggregation (MCP-01/02/03)', () => {
  beforeEach(() => {
    const db = initDb(process.env.DB_PATH!);
    db.prepare('DELETE FROM usage_costs').run();
    db.prepare('DELETE FROM model_calls').run();
    db.close();
  });

  it('aggregates real spend from usage_costs', async () => {
    const { CostDatabase } = await import('../../src/cost/CostDatabase.js');
    const cdb = new CostDatabase();
    cdb.recordUsageCost({
      model: 'cc/claude-sonnet-4-6',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.05,
      workflow_id: 'wf_a',
      task_id: 'tk_a',
      task_type: 'general',
      timestamp: Date.now(),
    });
    cdb.recordUsageCost({
      model: 'cc/claude-sonnet-4-6',
      input_tokens: 2000,
      output_tokens: 1000,
      cost_usd: 0.10,
      workflow_id: 'wf_a',
      task_id: 'tk_b',
      task_type: 'general',
      timestamp: Date.now(),
    });

    const byModel = cdb.getRealSpendByModel();
    const sonnet = byModel.find((m) => m.model === 'cc/claude-sonnet-4-6');
    expect(sonnet).toBeDefined();
    // Real spend = 0.05 + 0.10, NOT a sum of per-1k pricing rates.
    expect(sonnet!.total_cost_usd).toBeCloseTo(0.15, 6);
    expect(sonnet!.total_input_tokens).toBe(3000);
    expect(sonnet!.total_output_tokens).toBe(1500);
    expect(sonnet!.call_count).toBe(2);

    const totals = cdb.getTotalRealSpend();
    expect(totals.total_cost_usd).toBeCloseTo(0.15, 6);
    expect(totals.total_calls).toBe(2);
    cdb.close();
  });

  it('unions usage_costs and model_calls ledgers by model', async () => {
    const dbPath = process.env.DB_PATH!;
    const raw = initDb(dbPath);
    seedWorkflow(raw, 'wf_union');
    const { CostDatabase } = await import('../../src/cost/CostDatabase.js');
    const cdb = new CostDatabase();

    // usage_costs ledger row.
    cdb.recordUsageCost({
      model: 'gh/gpt-4o',
      input_tokens: 100,
      output_tokens: 50,
      cost_usd: 0.02,
      workflow_id: 'wf_union',
      timestamp: Date.now(),
    });
    // model_calls ledger row for the SAME model.
    raw.prepare(
      `INSERT INTO model_calls
         (id, workflow_id, task_id, model, provider, input_tokens, output_tokens,
          cost_usd, latency_ms, source, created_at)
       VALUES ('mc_union', 'wf_union', NULL, 'gh/gpt-4o', 'gh', 200, 100, 0.03, 800, 'executor', ?)`,
    ).run(Date.now());

    const byModel = cdb.getRealSpendByModel({ model: 'gh/gpt-4o' });
    const gpt = byModel.find((m) => m.model === 'gh/gpt-4o');
    expect(gpt).toBeDefined();
    // 0.02 (usage_costs) + 0.03 (model_calls) merged.
    expect(gpt!.total_cost_usd).toBeCloseTo(0.05, 6);
    expect(gpt!.call_count).toBe(2);
    expect(gpt!.total_input_tokens).toBe(300);
    cdb.close();
    raw.close();
  });

  it('returns empty totals on an empty ledger (no fabrication, no throw)', async () => {
    const { CostDatabase } = await import('../../src/cost/CostDatabase.js');
    const cdb = new CostDatabase();
    const totals = cdb.getTotalRealSpend();
    expect(totals.total_cost_usd).toBe(0);
    expect(totals.total_calls).toBe(0);
    expect(cdb.getRealSpendByModel()).toEqual([]);
    cdb.close();
  });
});

describe('catalog-sourced quality (OPS-08)', () => {
  it('sources quality from the live provider matrix, normalized to 0..1', async () => {
    const { getCatalogQuality, DEFAULT_CATALOG_QUALITY, resetCatalogQualityCache } = await import(
      '../../src/cost/catalog-quality.js'
    );
    resetCatalogQualityCache();
    // cc/claude-opus-4-6 has score_primary 95/100 in the matrix CSV.
    const opus = getCatalogQuality('cc/claude-opus-4-6');
    expect(opus).toBeGreaterThan(0.8);
    expect(opus).toBeLessThanOrEqual(1);
    // Unknown model falls back to the neutral default, not a fabricated value.
    const unknown = getCatalogQuality('totally/unknown-model-xyz');
    expect(unknown).toBe(DEFAULT_CATALOG_QUALITY);
  });
});

describe('RealTimeCostTracker fake-streamer removed (OPS-05)', () => {
  it('no longer exposes trackTokenStream and records real measured usage', async () => {
    const { getRealTimeCostTracker } = await import('../../src/cost/RealTimeCostTracker.js');
    const tracker = getRealTimeCostTracker();
    expect((tracker as unknown as Record<string, unknown>).trackTokenStream).toBeUndefined();
    expect(typeof (tracker as unknown as Record<string, unknown>).recordStreamUsage).toBe('function');

    tracker.resetWorkflow('wf_stream');
    const event = tracker.recordStreamUsage({
      workflow_id: 'wf_stream',
      task_id: 'tk_stream',
      model: 'cc/claude-sonnet-4-6',
      tokens_in: 1000,
      tokens_out: 1000,
    });
    // Cost is computed from the pricing table, not random simulation.
    expect(event.tokens_in).toBe(1000);
    expect(event.tokens_out).toBe(1000);
    expect(event.cost_usd).toBeGreaterThanOrEqual(0);
    expect(tracker.getWorkflowCost('wf_stream')).toBeCloseTo(event.cost_usd, 6);
  });
});
