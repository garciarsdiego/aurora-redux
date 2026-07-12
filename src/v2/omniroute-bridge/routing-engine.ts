/**
 * OmniRoute Routing Engine (Sprint 5)
 *
 * Advanced routing engine with smart strategies, cost-based optimization,
 * and integration with cost sync and health monitoring.
 */

import type { NormalizedModel, IntentInference } from './catalog.js';
import { getHealthStatus } from './health-cache.js';
import { logInfo, logWarn, logError } from '../observability/log-aggregation.js';

export type RoutingStrategy = 'quality' | 'cost' | 'balanced' | 'health' | 'adaptive';

export interface RoutingContext {
  /** Workflow ID for cost tracking */
  workflowId?: string;
  /** Task kind for specialized routing */
  taskKind?: string;
  /** User-provided content for intent inference */
  content?: string;
  /** Reference count for attachment inference */
  referenceCount?: number;
  /** Image reference count for vision inference */
  imageReferenceCount?: number;
  /** Current model ID (for preference bias) */
  currentModelId?: string;
  /** Maximum cost budget for this request */
  maxCostUsd?: number;
  /** Priority level (higher = prefer quality over cost) */
  priority?: 'low' | 'normal' | 'high' | 'critical';
}

export interface RoutingOptions {
  /** Routing strategy to use */
  strategy: RoutingStrategy;
  /** Whether to consider health status in routing */
  considerHealth: boolean;
  /** Whether to consider cost in routing */
  considerCost: boolean;
  /** Maximum number of models to return in ranked list */
  maxCandidates: number;
  /** Minimum health score threshold (0-1) */
  minHealthScore: number;
  /** Cost weight in balanced strategy (0-1) */
  costWeight: number;
  /** Quality weight in balanced strategy (0-1) */
  qualityWeight: number;
}

export interface RoutingDecision {
  /** Selected model */
  model: NormalizedModel | null;
  /** Routing strategy used */
  strategy: RoutingStrategy;
  /** Intent inference result */
  intent: IntentInference;
  /** Score of selected model */
  score: number;
  /** Reasons for selection */
  reasons: string[];
  /** Ranked list of candidate models */
  ranked: Array<{
    model: NormalizedModel;
    score: number;
    reasons: string[];
  }>;
  /** Cost estimate for this request */
  estimatedCostUsd: number;
  /** Health status of selected model */
  healthScore: number;
}

export interface RoutingEngineStats {
  totalRoutings: number;
  strategyCounts: Record<RoutingStrategy, number>;
  averageRoutingTimeMs: number;
  lastRoutingAt: number | null;
}

const DEFAULT_OPTIONS: RoutingOptions = {
  strategy: 'balanced',
  considerHealth: true,
  considerCost: true,
  maxCandidates: 5,
  minHealthScore: 0.5,
  costWeight: 0.5,
  qualityWeight: 0.5,
};

class RoutingEngine {
  private options: RoutingOptions;
  private stats: RoutingEngineStats = {
    totalRoutings: 0,
    strategyCounts: {
      quality: 0,
      cost: 0,
      balanced: 0,
      health: 0,
      adaptive: 0,
    },
    averageRoutingTimeMs: 0,
    lastRoutingAt: null,
  };
  private routingTimes: number[] = [];

  constructor(options: Partial<RoutingOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Route a request to the best model based on context and strategy
   */
  async route(
    models: NormalizedModel[],
    intent: IntentInference,
    context: RoutingContext = {},
  ): Promise<RoutingDecision> {
    const startTime = Date.now();
    this.stats.totalRoutings++;

    try {
      // Determine routing strategy
      const strategy = this.determineStrategy(context);
      this.stats.strategyCounts[strategy]++;

      // Filter models based on capabilities and health
      const candidates = this.filterCandidates(models, intent, context);

      if (candidates.length === 0) {
        logWarn('No suitable models found for routing', { intent, context }, 'omniroute-routing-engine');
        return this.createEmptyDecision(intent, strategy);
      }

      // Score and rank candidates
      const ranked = await this.scoreCandidates(candidates, intent, context, strategy);

      // Select best model
      const selected = this.selectBestModel(ranked);

      if (!selected || !selected.model) {
        return this.createEmptyDecision(intent, strategy);
      }

      // Estimate cost
      const estimatedCost = this.estimateCost(selected.model, context);

      // Get health score
      const healthScore = await this.getHealthScore(selected.model);

      this.stats.lastRoutingAt = Date.now();
      const routingTime = Date.now() - startTime;
      this.recordRoutingTime(routingTime);

      logInfo('Routing decision made', {
        model: selected.model?.id,
        strategy,
        score: selected.score,
        estimatedCost,
        healthScore,
        routingTimeMs: routingTime,
      }, 'omniroute-routing-engine');

      return {
        model: selected.model,
        strategy,
        intent,
        score: selected.score,
        reasons: selected.reasons,
        ranked: ranked.slice(0, this.options.maxCandidates),
        estimatedCostUsd: estimatedCost,
        healthScore,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logError('Routing engine EXCEPTION', {
        error: errorMsg,
        context,
      }, 'omniroute-routing-engine');

      return this.createEmptyDecision(intent, this.options.strategy);
    }
  }

  /**
   * Determine routing strategy based on context
   */
  private determineStrategy(context: RoutingContext): RoutingStrategy {
    // If strategy is explicitly set in options, use it
    if (this.options.strategy !== 'adaptive') {
      return this.options.strategy;
    }

    // Adaptive strategy: choose based on context
    const priority = context.priority ?? 'normal';

    // Critical/high priority: prefer quality
    if (priority === 'critical' || priority === 'high') {
      return 'quality';
    }

    // Low priority: prefer cost
    if (priority === 'low') {
      return 'cost';
    }

    // If cost budget is tight, prefer cost
    if (context.maxCostUsd && context.maxCostUsd < 0.01) {
      return 'cost';
    }

    // Default to balanced
    return 'balanced';
  }

  /**
   * Filter models based on capabilities, health, and cost constraints
   */
  private filterCandidates(
    models: NormalizedModel[],
    intent: IntentInference,
    context: RoutingContext,
  ): NormalizedModel[] {
    return models.filter((model) => {
      // Check capability requirements
      if (intent.requiresVision && !model.capabilities.vision) return false;
      if (intent.requiresAttachment && !model.capabilities.attachment && !model.capabilities.vision) return false;
      if (intent.wantsStructuredOutput && !model.capabilities.structured_output) return false;

      // Check cost constraint
      if (context.maxCostUsd && model.pricingKnown) {
        const estimatedCost = this.estimateCost(model, context);
        if (estimatedCost > context.maxCostUsd) return false;
      }

      // Health is factored in later via getHealthScore (no per-candidate check here)

      return true;
    });
  }

  /**
   * Score and rank candidates based on strategy
   */
  private async scoreCandidates(
    candidates: NormalizedModel[],
    intent: IntentInference,
    context: RoutingContext,
    strategy: RoutingStrategy,
  ): Promise<Array<{ model: NormalizedModel; score: number; reasons: string[] }>> {
    const scoredPromises = candidates.map(async (model) => {
      let score = 0;
      const reasons: string[] = [];

      switch (strategy) {
        case 'quality':
          score = this.scoreForQuality(model, intent, context, reasons);
          break;
        case 'cost':
          score = this.scoreForCost(model, intent, context, reasons);
          break;
        case 'balanced':
          score = this.scoreForBalanced(model, intent, context, reasons);
          break;
        case 'health':
          score = await this.scoreForHealth(model, intent, context, reasons);
          break;
        case 'adaptive':
          score = this.scoreForAdaptive(model, intent, context, reasons);
          break;
      }

      // Add bias for current model (stickiness)
      if (context.currentModelId && model.id === context.currentModelId) {
        score += 10;
        reasons.push('modelo atual (preferência)');
      }

      return { model, score, reasons };
    });

    const scored = await Promise.all(scoredPromises);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  /**
   * Score model for quality strategy
   */
  private scoreForQuality(
    model: NormalizedModel,
    intent: IntentInference,
    context: RoutingContext,
    reasons: string[],
  ): number {
    let score = 0;

    // Capability matching
    if (intent.requiresVision && model.capabilities.vision) {
      score += 100;
      reasons.push('suporta visão');
    }
    if (intent.requiresAttachment && model.capabilities.attachment) {
      score += 80;
      reasons.push('suporta anexos');
    }
    if (intent.wantsStructuredOutput && model.capabilities.structured_output) {
      score += 60;
      reasons.push('suporta JSON estruturado');
    }
    if (intent.wantsDeepReasoning && model.capabilities.reasoning) {
      score += 70;
      reasons.push('bom para raciocínio');
    }
    if (intent.wantsDeepReasoning && model.capabilities.thinking) {
      score += 30;
      reasons.push('thinking ativo');
    }
    if (model.capabilities.tool_calling) {
      score += 20;
      reasons.push('tool calling');
    }

    // Context length bonus
    score += Math.min(Math.floor(model.contextLength / 50_000), 30);
    reasons.push(`${Math.round(model.contextLength / 1000)}k contexto`);

    // Provider quality heuristics (simplified)
    const highQualityProviders = ['Anthropic', 'OpenAI', 'Google', 'Claude'];
    if (highQualityProviders.includes(model.provider)) {
      score += 15;
      reasons.push('provider de alta qualidade');
    }

    return score;
  }

  /**
   * Score model for cost strategy
   */
  private scoreForCost(
    model: NormalizedModel,
    intent: IntentInference,
    context: RoutingContext,
    reasons: string[],
  ): number {
    let score = 100; // Start high and subtract for cost

    if (!model.pricingKnown) {
      score -= 30;
      reasons.push('preço desconhecido');
      return score;
    }

    // Calculate cost score (lower cost = higher score)
    const avgCostPer1k = (model.pricing.inputPerMillion + model.pricing.outputPerMillion) / 2000;
    const costPenalty = Math.min(avgCostPer1k * 10, 80);
    score -= costPenalty;

    if (model.free) {
      score += 50;
      reasons.push('gratuito');
    } else {
      reasons.push(`$${avgCostPer1k.toFixed(4)}/1k tokens`);
    }

    // Still need to meet basic capability requirements
    if (intent.requiresVision && !model.capabilities.vision) {
      score -= 200; // Heavy penalty for missing required capability
    }
    if (intent.requiresAttachment && !model.capabilities.attachment && !model.capabilities.vision) {
      score -= 200;
    }

    return Math.max(0, score);
  }

  /**
   * Score model for balanced strategy
   */
  private scoreForBalanced(
    model: NormalizedModel,
    intent: IntentInference,
    context: RoutingContext,
    reasons: string[],
  ): number {
    const qualityScore = this.scoreForQuality(model, intent, context, []);
    const costScore = this.scoreForCost(model, intent, context, []);

    // Weighted combination
    const balancedScore =
      qualityScore * this.options.qualityWeight + costScore * this.options.costWeight;

    // Add reasons from both strategies
    if (model.free) reasons.push('gratuito');
    if (model.capabilities.reasoning) reasons.push('bom para raciocínio');
    if (model.contextLength > 100_000) reasons.push('contexto grande');

    return balancedScore;
  }

  /**
   * Score model for health strategy
   */
  private async scoreForHealth(
    model: NormalizedModel,
    intent: IntentInference,
    context: RoutingContext,
    reasons: string[],
  ): Promise<number> {
    let score = 0;

    // Health score is primary
    const healthScore = await this.getHealthScore(model);
    score += healthScore * 100;
    reasons.push(`health: ${(healthScore * 100).toFixed(0)}%`);

    // But still need basic capabilities
    if (intent.requiresVision && model.capabilities.vision) {
      score += 20;
    }
    if (intent.requiresAttachment && model.capabilities.attachment) {
      score += 15;
    }

    return score;
  }

  /**
   * Score model for adaptive strategy
   */
  private scoreForAdaptive(
    model: NormalizedModel,
    intent: IntentInference,
    context: RoutingContext,
    reasons: string[],
  ): number {
    const priority = context.priority ?? 'normal';

    // High priority: weight quality more
    if (priority === 'high' || priority === 'critical') {
      return this.scoreForQuality(model, intent, context, reasons);
    }

    // Low priority: weight cost more
    if (priority === 'low') {
      return this.scoreForCost(model, intent, context, reasons);
    }

    // Normal: balanced
    return this.scoreForBalanced(model, intent, context, reasons);
  }

  /**
   * Select best model from ranked list
   */
  private selectBestModel(
    ranked: Array<{ model: NormalizedModel; score: number; reasons: string[] }>,
  ): { model: NormalizedModel | null; score: number; reasons: string[] } {
    if (ranked.length === 0) {
      return { model: null, score: 0, reasons: [] };
    }

    const best = ranked[0];
    return {
      model: best.model,
      score: best.score,
      reasons: best.reasons.slice(0, 5),
    };
  }

  /**
   * Estimate cost for a model with given context
   */
  private estimateCost(model: NormalizedModel, context: RoutingContext): number {
    if (!model.pricingKnown || model.free) return 0;

    // Simplified cost estimation based on content length
    const contentLength = context.content?.length ?? 0;
    const estimatedInputTokens = Math.ceil(contentLength / 4);
    const estimatedOutputTokens = 1000; // Conservative estimate

    const inputCost = (estimatedInputTokens / 1_000_000) * model.pricing.inputPerMillion;
    const outputCost = (estimatedOutputTokens / 1_000_000) * model.pricing.outputPerMillion;

    return inputCost + outputCost;
  }

  /**
   * Get health score for a model
   */
  private async getHealthScore(model: NormalizedModel | null): Promise<number> {
    if (!model || !this.options.considerHealth) return 1.0;

    try {
      const health = await getHealthStatus();
      if (!health.ok || !health.data) return 0.5;

      // Get provider health status
      const providerHealth = health.data.providers[model.provider.toLowerCase()];
      if (!providerHealth) return 0.7; // Unknown provider

      // Convert status to score
      switch (providerHealth.status) {
        case 'healthy':
          return 1.0;
        case 'degraded':
          return 0.6;
        case 'unhealthy':
          return 0.2;
        default:
          return 0.5;
      }
    } catch {
      return 0.5; // Default to mid score on error
    }
  }

  /**
   * Create empty decision when no models are available
   */
  private createEmptyDecision(intent: IntentInference, strategy: RoutingStrategy): RoutingDecision {
    return {
      model: null,
      strategy,
      intent,
      score: 0,
      reasons: ['nenhum modelo disponível'],
      ranked: [],
      estimatedCostUsd: 0,
      healthScore: 0,
    };
  }

  /**
   * Record routing time for stats
   */
  private recordRoutingTime(timeMs: number): void {
    this.routingTimes.push(timeMs);
    if (this.routingTimes.length > 100) {
      this.routingTimes.shift();
    }
    const avg = this.routingTimes.reduce((a, b) => a + b, 0) / this.routingTimes.length;
    this.stats.averageRoutingTimeMs = avg;
  }

  /**
   * Get routing engine statistics
   */
  getStats(): RoutingEngineStats {
    return { ...this.stats };
  }

  /**
   * Update routing options
   */
  updateOptions(options: Partial<RoutingOptions>): void {
    this.options = { ...this.options, ...options };
    logInfo('Routing engine options updated', { options: this.options }, 'omniroute-routing-engine');
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalRoutings: 0,
      strategyCounts: {
        quality: 0,
        cost: 0,
        balanced: 0,
        health: 0,
        adaptive: 0,
      },
      averageRoutingTimeMs: 0,
      lastRoutingAt: null,
    };
    this.routingTimes = [];
  }
}

/**
 * Global routing engine instance
 */
export const routingEngine = new RoutingEngine();

/**
 * Route a request to the best model
 */
export async function routeRequest(
  models: NormalizedModel[],
  intent: IntentInference,
  context?: RoutingContext,
): Promise<RoutingDecision> {
  return routingEngine.route(models, intent, context);
}

/**
 * Update routing engine options
 */
export function updateRoutingOptions(options: Partial<RoutingOptions>): void {
  routingEngine.updateOptions(options);
}

/**
 * Get routing engine statistics
 */
export function getRoutingEngineStats(): RoutingEngineStats {
  return routingEngine.getStats();
}

/**
 * Reset routing engine statistics
 */
export function resetRoutingEngineStats(): void {
  routingEngine.resetStats();
}