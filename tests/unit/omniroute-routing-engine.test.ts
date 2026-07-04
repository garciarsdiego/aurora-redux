/**
 * Tests for OmniRoute Routing Engine (Sprint 5)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  routingEngine,
  routeRequest,
  updateRoutingOptions,
  getRoutingEngineStats,
  resetRoutingEngineStats,
  type RoutingContext,
  type RoutingDecision,
  type RoutingOptions,
  type NormalizedModel,
} from '../../src/v2/omniroute-bridge/routing-engine.js';
import type { IntentInference } from '../../src/v2/omniroute-bridge/catalog.js';

// Mock dependencies
vi.mock('../../src/v2/omniroute-bridge/cost-sync.js', () => ({
  getWorkflowCostSummary: vi.fn(() => null),
  getTotalTrackedCost: vi.fn(() => ({ localUsd: 0, remoteUsd: 0 })),
}));

vi.mock('../../src/v2/omniroute-bridge/health-cache.js', () => ({
  getHealthStatus: vi.fn(() => Promise.resolve({
    ok: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: {
        anthropic: { status: 'healthy', latency_ms: 100, last_check: new Date().toISOString() },
        openai: { status: 'healthy', latency_ms: 150, last_check: new Date().toISOString() },
      },
      rate_limits: {},
    },
  })),
}));

vi.mock('../../src/v2/observability/log-aggregation.js', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}));

describe('Routing Engine', () => {
  let testModels: NormalizedModel[];
  let testIntent: IntentInference;

  beforeEach(() => {
    // Reset stats before each test
    resetRoutingEngineStats();

    // Create test models
    testModels = [
      {
        id: 'anthropic/claude-3-opus',
        label: 'Claude 3 Opus',
        provider: 'Anthropic',
        contextLength: 200_000,
        capabilities: {
          attachment: true,
          reasoning: true,
          structured_output: true,
          temperature: true,
          thinking: true,
          tool_calling: true,
          vision: true,
        },
        capabilityTags: ['Visão', 'Anexo', 'Ferramentas', 'Raciocinio', 'Thinking', 'JSON', 'Temperatura'],
        pricing: {
          inputPerMillion: 15.0,
          outputPerMillion: 75.0,
          cacheReadPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
        },
        pricingKnown: true,
        free: false,
        raw: {},
      },
      {
        id: 'openai/gpt-4-turbo',
        label: 'GPT-4 Turbo',
        provider: 'OpenAI',
        contextLength: 128_000,
        capabilities: {
          attachment: true,
          reasoning: true,
          structured_output: true,
          temperature: true,
          thinking: false,
          tool_calling: true,
          vision: true,
        },
        capabilityTags: ['Visão', 'Anexo', 'Ferramentas', 'Raciocinio', 'JSON', 'Temperatura'],
        pricing: {
          inputPerMillion: 10.0,
          outputPerMillion: 30.0,
          cacheReadPerMillion: 0.0,
          cacheWritePerMillion: 0.0,
        },
        pricingKnown: true,
        free: false,
        raw: {},
      },
      {
        id: 'groq/llama3-8b',
        label: 'Llama 3 8B',
        provider: 'Groq',
        contextLength: 8_000,
        capabilities: {
          attachment: false,
          reasoning: false,
          structured_output: true,
          temperature: true,
          thinking: false,
          tool_calling: true,
          vision: false,
        },
        capabilityTags: ['Ferramentas', 'JSON', 'Temperatura'],
        pricing: {
          inputPerMillion: 0.1,
          outputPerMillion: 0.1,
          cacheReadPerMillion: 0.0,
          cacheWritePerMillion: 0.0,
        },
        pricingKnown: true,
        free: false,
        raw: {},
      },
    ];

    // Create test intent
    testIntent = {
      kind: 'reasoning',
      requiresVision: false,
      requiresAttachment: false,
      wantsStructuredOutput: false,
      wantsDeepReasoning: true,
      isQuick: false,
    };
  });

  describe('Quality Strategy', () => {
    it('should select highest quality model for reasoning tasks', async () => {
      const context: RoutingContext = {
        taskKind: 'llm_call',
        priority: 'high',
      };

      updateRoutingOptions({ strategy: 'quality' });
      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.model).not.toBeNull();
      expect(decision.strategy).toBe('quality');
      expect(decision.score).toBeGreaterThan(0);
      expect(decision.ranked.length).toBeGreaterThan(0);
    });

    it('should prioritize models with reasoning capability', async () => {
      const context: RoutingContext = {};
      updateRoutingOptions({ strategy: 'quality' });

      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.model?.capabilities.reasoning).toBe(true);
      expect(decision.reasons.some(r => r.includes('raciocínio'))).toBe(true);
    });
  });

  describe('Cost Strategy', () => {
    it('should select lowest cost model', async () => {
      const context: RoutingContext = {
        priority: 'low',
      };

      updateRoutingOptions({ strategy: 'cost' });
      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.model).not.toBeNull();
      expect(decision.strategy).toBe('cost');
      // Should prefer Groq (cheapest) for cost strategy
      expect(decision.model?.provider).toBe('Groq');
    });

    it('should respect max cost constraint', async () => {
      const context: RoutingContext = {
        maxCostUsd: 0.001, // Very low budget
      };

      updateRoutingOptions({ strategy: 'cost' });
      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.estimatedCostUsd).toBeLessThanOrEqual(0.001);
    });
  });

  describe('Balanced Strategy', () => {
    it('should balance quality and cost', async () => {
      const context: RoutingContext = {
        priority: 'normal',
      };

      updateRoutingOptions({ strategy: 'balanced' });
      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.model).not.toBeNull();
      expect(decision.strategy).toBe('balanced');
      expect(decision.score).toBeGreaterThan(0);
    });

    it('should use custom weights when provided', async () => {
      const customOptions: Partial<RoutingOptions> = {
        strategy: 'balanced',
        costWeight: 0.7,
        qualityWeight: 0.3,
      };

      const context: RoutingContext = {};
      updateRoutingOptions(customOptions);
      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.strategy).toBe('balanced');
    });
  });

  describe('Health Strategy', () => {
    it('should consider health status in routing', async () => {
      const context: RoutingContext = {};
      updateRoutingOptions({ strategy: 'health', considerHealth: true });

      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.model).not.toBeNull();
      expect(decision.strategy).toBe('health');
      expect(decision.healthScore).toBeGreaterThan(0);
    });
  });

  describe('Adaptive Strategy', () => {
    it('should use quality strategy for high priority', async () => {
      const context: RoutingContext = {
        priority: 'critical',
      };

      updateRoutingOptions({ strategy: 'adaptive' });
      const decision = await routeRequest(testModels, testIntent, context);

      // Adaptive should delegate to quality for high priority
      expect(decision.strategy).toBe('quality');
      // Should select high-quality model
      expect(decision.model?.capabilities.reasoning).toBe(true);
    });

    it('should use cost strategy for low priority', async () => {
      const context: RoutingContext = {
        priority: 'low',
      };

      updateRoutingOptions({ strategy: 'adaptive' });
      const decision = await routeRequest(testModels, testIntent, context);

      // Adaptive should delegate to cost for low priority
      expect(decision.strategy).toBe('cost');
      // Should select low-cost model
      expect(decision.model?.provider).toBe('Groq');
    });

    it('should use balanced strategy for normal priority', async () => {
      const context: RoutingContext = {
        priority: 'normal',
      };

      updateRoutingOptions({ strategy: 'adaptive' });
      const decision = await routeRequest(testModels, testIntent, context);

      // Adaptive should delegate to balanced for normal priority
      expect(decision.strategy).toBe('balanced');
    });
  });

  describe('Capability Filtering', () => {
    it('should filter models that lack required capabilities', async () => {
      const visionIntent: IntentInference = {
        kind: 'vision',
        requiresVision: true,
        requiresAttachment: false,
        wantsStructuredOutput: false,
        wantsDeepReasoning: false,
        isQuick: false,
      };

      const context: RoutingContext = {};
      updateRoutingOptions({ strategy: 'quality' });

      const decision = await routeRequest(testModels, visionIntent, context);

      expect(decision.model?.capabilities.vision).toBe(true);
      // Groq should be filtered out (no vision)
      expect(decision.model?.provider).not.toBe('Groq');
    });

    it('should return empty decision when no models match requirements', async () => {
      const modelsWithoutVision = testModels.filter(m => !m.capabilities.vision);
      const visionIntent: IntentInference = {
        kind: 'vision',
        requiresVision: true,
        requiresAttachment: false,
        wantsStructuredOutput: false,
        wantsDeepReasoning: false,
        isQuick: false,
      };

      const context: RoutingContext = {};
      const decision = await routeRequest(modelsWithoutVision, visionIntent, context);

      expect(decision.model).toBeNull();
      expect(decision.reasons).toContain('nenhum modelo disponível');
    });
  });

  describe('Current Model Bias', () => {
    it('should prefer current model when specified', async () => {
      const context: RoutingContext = {
        currentModelId: 'openai/gpt-4-turbo',
      };

      updateRoutingOptions({ strategy: 'balanced' });
      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.model?.id).toBe('openai/gpt-4-turbo');
      expect(decision.reasons.some(r => r.includes('modelo atual'))).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should track routing statistics', async () => {
      const context: RoutingContext = {};
      updateRoutingOptions({ strategy: 'quality' });

      await routeRequest(testModels, testIntent, context);
      await routeRequest(testModels, testIntent, context);

      const stats = getRoutingEngineStats();
      expect(stats.totalRoutings).toBe(2);
      expect(stats.strategyCounts.quality).toBe(2);
      expect(stats.lastRoutingAt).not.toBeNull();
      expect(stats.averageRoutingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('should reset statistics when requested', async () => {
      const context: RoutingContext = {};
      await routeRequest(testModels, testIntent, context);

      resetRoutingEngineStats();
      const stats = getRoutingEngineStats();

      expect(stats.totalRoutings).toBe(0);
      expect(stats.lastRoutingAt).toBeNull();
    });
  });

  describe('Cost Estimation', () => {
    it('should estimate cost for selected model', async () => {
      const context: RoutingContext = {
        content: 'This is a test prompt with some content',
      };

      updateRoutingOptions({ strategy: 'cost' });
      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.estimatedCostUsd).toBeGreaterThanOrEqual(0);
    });

    it('should return zero cost for free models', async () => {
      const freeModel: NormalizedModel = {
        ...testModels[2],
        free: true,
        pricing: {
          inputPerMillion: 0,
          outputPerMillion: 0,
          cacheReadPerMillion: 0,
          cacheWritePerMillion: 0,
        },
      };

      const context: RoutingContext = {};
      updateRoutingOptions({ strategy: 'cost' });
      const decision = await routeRequest([freeModel], testIntent, context);

      expect(decision.estimatedCostUsd).toBe(0);
    });
  });

  describe('Ranked Candidates', () => {
    it('should return ranked list of candidates', async () => {
      const context: RoutingContext = {};
      updateRoutingOptions({ strategy: 'quality', maxCandidates: 5 });

      const decision = await routeRequest(testModels, testIntent, context);

      expect(decision.ranked.length).toBeGreaterThan(0);
      expect(decision.ranked.length).toBeLessThanOrEqual(5);
      
      // Check that scores are in descending order
      for (let i = 1; i < decision.ranked.length; i++) {
        expect(decision.ranked[i - 1].score).toBeGreaterThanOrEqual(decision.ranked[i].score);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle empty model list gracefully', async () => {
      const context: RoutingContext = {};
      const decision = await routeRequest([], testIntent, context);

      expect(decision.model).toBeNull();
      expect(decision.reasons).toContain('nenhum modelo disponível');
    });

    it('should handle routing errors gracefully', async () => {
      // Mock health status to throw error
      vi.doMock('../../src/v2/omniroute-bridge/health-cache.js', () => ({
        getHealthStatus: vi.fn(() => Promise.reject(new Error('Health check failed'))),
      }));

      const context: RoutingContext = {};
      updateRoutingOptions({ strategy: 'health', considerHealth: true });

      const decision = await routeRequest(testModels, testIntent, context);

      // Should still return a decision, not throw
      expect(decision).not.toBeNull();
    });
  });
});