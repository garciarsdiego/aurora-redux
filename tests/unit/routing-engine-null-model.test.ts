/**
 * Regression test for the null-model guard in routing-engine.ts
 *
 * Bug: commit e3e7b44 added `selected.model!` non-null assertions on lines 146/149
 * to silence TypeScript, masking a real code path where selectBestModel returns
 * { model: null, ... }. The guard at line 141 was `if (!selected)` — it never
 * checked `selected.model`, so null-model flowed into estimateCost / getHealthScore.
 *
 * Fix: guard is now `if (!selected || !selected.model)` → returns
 * createEmptyDecision rather than passing null to downstream helpers.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock external I/O dependencies before importing the module under test.
vi.mock('../../src/v2/omniroute-bridge/health-cache.js', () => ({
  getHealthStatus: vi.fn().mockResolvedValue({
    healthy: true,
    latencyMs: 50,
    checkedAt: Date.now(),
    models: {},
  }),
}));

vi.mock('../../src/v2/omniroute-bridge/cost-sync.js', () => ({
  getWorkflowCostSummary: vi.fn().mockResolvedValue(null),
  getTotalTrackedCost: vi.fn().mockReturnValue(0),
}));

vi.mock('../../src/v2/observability/log-aggregation.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

import { routeRequest, resetRoutingEngineStats } from '../../src/v2/omniroute-bridge/routing-engine.js';
import type { NormalizedModel, IntentInference } from '../../src/v2/omniroute-bridge/catalog.js';

// Minimal model factory
function makeModel(overrides: Partial<NormalizedModel> = {}): NormalizedModel {
  return {
    id: 'test/model-1',
    label: 'Test Model',
    provider: 'test',
    contextLength: 8192,
    capabilities: {
      vision: false,
      attachment: false,
      structured_output: false,
      function_calling: false,
      streaming: true,
    } as NormalizedModel['capabilities'],
    capabilityTags: [],
    pricing: { inputPerMillion: 1.0, outputPerMillion: 3.0 },
    pricingKnown: true,
    free: false,
    raw: {},
    ...overrides,
  };
}

const QUICK_INTENT: IntentInference = {
  kind: 'quick',
  requiresVision: false,
  requiresAttachment: false,
  wantsStructuredOutput: false,
  wantsDeepReasoning: false,
  isQuick: true,
};

describe('routing-engine null-model guard', () => {
  beforeEach(() => {
    resetRoutingEngineStats();
  });

  it('returns { model: null } without throwing when models array is empty', async () => {
    const decision = await routeRequest([], QUICK_INTENT);
    expect(decision.model).toBeNull();
    expect(decision.score).toBe(0);
    expect(decision.estimatedCostUsd).toBe(0);
    expect(decision.healthScore).toBe(0);
  });

  it('returns { model: null } without throwing when all candidates are filtered out by capability', async () => {
    // model has vision: false, but intent requires vision → filterCandidates removes it
    // → candidates.length === 0 → createEmptyDecision (NOT a throw)
    const visionModel = makeModel({ id: 'test/no-vision' });
    const visionIntent: IntentInference = {
      ...QUICK_INTENT,
      kind: 'vision',
      requiresVision: true,
    };

    const decision = await routeRequest([visionModel], visionIntent);
    expect(decision.model).toBeNull();
    expect(decision.score).toBe(0);
    expect(decision.estimatedCostUsd).toBe(0);
  });

  it('returns { model: null } without throwing when cost budget eliminates all candidates', async () => {
    // model costs ~$0.001 per request; budget is $0.000001
    const expensiveModel = makeModel({
      id: 'test/expensive',
      pricingKnown: true,
      pricing: { inputPerMillion: 1000, outputPerMillion: 3000 },
    });

    const decision = await routeRequest([expensiveModel], QUICK_INTENT, {
      content: 'hello world',
      maxCostUsd: 0.000000001, // impossibly small → filtered out
    });

    expect(decision.model).toBeNull();
    expect(decision.estimatedCostUsd).toBe(0);
  });

  it('returns a valid model when a capable candidate exists — normal path unaffected', async () => {
    const model = makeModel({ id: 'test/good-model' });

    const decision = await routeRequest([model], QUICK_INTENT);
    expect(decision.model).not.toBeNull();
    expect(decision.model?.id).toBe('test/good-model');
    expect(decision.score).toBeGreaterThanOrEqual(0);
  });

  it('does not throw when selectBestModel would receive an empty ranked list (null model path)', async () => {
    // Verifies the guard `if (!selected || !selected.model)` is non-throwing.
    // This is the exact path that was broken: old code threw 'No suitable model found';
    // new code returns the empty/fallback decision.
    await expect(routeRequest([], QUICK_INTENT)).resolves.toMatchObject({
      model: null,
      score: 0,
      reasons: expect.any(Array),
      ranked: [],
    });
  });
});
