import { getCostDatabase } from './CostDatabase.js';
import { getCatalogQuality } from './catalog-quality.js';
import { inferCapabilities } from '../v2/models/capability-registry.js';
import type {
  CostAwareRouteRequest,
  CostAwareRouteResponse,
  ModelCandidate
} from './types.js';

/** Result of the lightweight per-call selectModel() decision. */
export interface SelectModelResult {
  recommended_model: string;
  reasoning: string;
  /** Whether the RETURNED model is expected to fit budget_usd (see selectModel). */
  within_budget: boolean;
  /** Estimated USD cost of the returned model (0 when not evaluated). */
  estimated_cost_usd: number;
}

export class CostAwareRouter {
  private costDatabase = getCostDatabase();

  /**
   * Route a request to the best model based on cost constraints and quality requirements
   */
  async route(request: CostAwareRouteRequest): Promise<CostAwareRouteResponse> {
    // Get all available models
    const allCosts = this.costDatabase.getAllCosts();
    
    // Filter by exclude_models if provided
    let candidates = allCosts;
    if (request.exclude_models && request.exclude_models.length > 0) {
      candidates = candidates.filter(c => !request.exclude_models!.includes(c.model));
    }

    // Quality from the live provider matrix; latency from the real model_calls
    // ledger when measured; features from the capability registry (OPS-08).
    let modelCandidates: ModelCandidate[] = candidates.map(cost => ({
      model: cost.model,
      provider: cost.provider,
      estimated_cost_usd: this.estimateRequestCost(cost, request.objective),
      estimated_quality: this.estimateQuality(cost.model, request.use_case),
      avg_latency_ms: this.estimateLatency(cost.model),
      features: this.getModelFeatures(cost.model)
    }));

    // Filter by budget if specified
    if (request.budget_usd) {
      modelCandidates = modelCandidates.filter(c => c.estimated_cost_usd <= request.budget_usd!);
      
      // If no candidates within budget, issue warning
      if (modelCandidates.length === 0) {
        // Get cheapest option anyway for warning
        const cheapest = candidates
          .map(c => ({
            model: c.model,
            provider: c.provider,
            estimated_cost_usd: this.estimateRequestCost(c, request.objective)
          }))
          .sort((a, b) => a.estimated_cost_usd - b.estimated_cost_usd)[0];

        return {
          selected_model: cheapest.model,
          selected_provider: cheapest.provider,
          estimated_cost_usd: cheapest.estimated_cost_usd,
          estimated_quality: this.estimateQuality(cheapest.model, request.use_case),
          reasoning: `No models within budget $${request.budget_usd.toFixed(4)}. Selected cheapest option.`,
          alternatives: [],
          budget_warning: {
            current_cost: cheapest.estimated_cost_usd,
            budget: request.budget_usd,
            percentage: (cheapest.estimated_cost_usd / request.budget_usd) * 100
          }
        };
      }
    }

    // Filter by quality threshold if specified
    if (request.quality_threshold) {
      const qualityFiltered = modelCandidates.filter(
        c => c.estimated_quality >= request.quality_threshold!
      );
      
      if (qualityFiltered.length > 0) {
        modelCandidates.length = 0;
        modelCandidates.push(...qualityFiltered);
      }
    }

    // Select based on strategy
    const selected = this.selectByStrategy(modelCandidates, request.strategy);

    return {
      selected_model: selected.model,
      selected_provider: selected.provider,
      estimated_cost_usd: selected.estimated_cost_usd,
      estimated_quality: selected.estimated_quality,
      reasoning: this.generateReasoning(selected, request),
      alternatives: modelCandidates
        .filter(c => c.model !== selected.model)
        .slice(0, 3) // Top 3 alternatives
    };
  }

  /**
   * Select model based on strategy (quality/cost/balanced)
   */
  private selectByStrategy(candidates: ModelCandidate[], strategy: string): ModelCandidate {
    switch (strategy) {
      case 'quality':
        // Select highest quality
        return candidates.reduce((best, current) => 
          current.estimated_quality > best.estimated_quality ? current : best
        );
      
      case 'cost':
        // Select lowest cost
        return candidates.reduce((best, current) => 
          current.estimated_cost_usd < best.estimated_cost_usd ? current : best
        );
      
      case 'balanced':
      default:
        // Select best value (quality/cost ratio)
        return candidates.reduce((best, current) => {
          const bestValue = best.estimated_quality / Math.max(best.estimated_cost_usd, 0.0001);
          const currentValue = current.estimated_quality / Math.max(current.estimated_cost_usd, 0.0001);
          return currentValue > bestValue ? current : best;
        });
    }
  }

  /**
   * Estimate cost for a request (simplified heuristic).
   *
   * Input tokens are derived from the REAL prompt size when the caller can
   * supply one — either an objective string (route()) or an explicit
   * `inputTokensOverride` (selectModel(), which threads the actual call's
   * prompt size). Without a realistic size the estimate collapses to a sub-cent
   * figure for every model, which is what made the per-call cost-router gate
   * inert: a ~13-char "task: <type>" literal produced ~4 input tokens, so
   * estimatedCost <= budget stayed true until the headroom itself went sub-cent
   * and neither the downshift nor the enforce gate ever fired.
   */
  private estimateRequestCost(
    cost: any,
    objective: string,
    inputTokensOverride?: number,
  ): number {
    const inputTokens =
      inputTokensOverride !== undefined && Number.isFinite(inputTokensOverride) && inputTokensOverride >= 0
        ? Math.ceil(inputTokensOverride)
        : this.costDatabase.estimateTokens(objective);
    const outputTokens = cost.avg_tokens_per_request || 500;

    return this.costDatabase.calculateCost(
      cost.model,
      inputTokens,
      outputTokens,
      cost.provider
    );
  }

  /**
   * Estimate quality for a model (0-1).
   *
   * De-mock (OPS-08): base quality is sourced from the live provider matrix
   * (capability registry) instead of a stale hardcoded map. The use-case
   * multiplier remains a deliberate routing heuristic (not a quality table).
   */
  private estimateQuality(model: string, use_case: string): number {
    const baseQuality = getCatalogQuality(model);

    // Adjust based on use case (routing heuristic, not a quality measurement)
    const useCaseMultiplier: Record<string, number> = {
      'code': 1.0,
      'debug': 0.95,
      'planning': 1.05,
      'review': 1.0,
      'chat': 0.9
    };

    return Math.min(1.0, baseQuality * (useCaseMultiplier[use_case] || 1.0));
  }

  /**
   * Estimate latency in milliseconds.
   *
   * De-mock (OPS-08): prefer REAL measured latency from the model_calls ledger
   * when the model has recorded calls; only fall back to a neutral default
   * when there is no measured data (instead of a stale hardcoded per-model
   * latency table).
   */
  private estimateLatency(model: string): number {
    const measured = this.costDatabase.getRealAvgLatencyMs(model);
    if (measured != null && measured > 0) return Math.round(measured);
    return 1500; // neutral default until real latency is observed
  }

  /**
   * Get features available for a model.
   *
   * De-mock (OPS-08): source capabilities from the live capability registry
   * (provider matrix inference) rather than a stale hardcoded feature table.
   */
  private getModelFeatures(model: string): string[] {
    const caps = inferCapabilities(model);
    const features: string[] = [];
    if (caps.tool_calling) features.push('tools');
    if (caps.structured_output) features.push('structured-output');
    if (caps.multimodal) features.push('vision');
    if (caps.streaming) features.push('streaming');
    if (caps.embeddings) features.push('embeddings');
    if (caps.batch) features.push('batch');
    if (caps.local) features.push('local');
    return features;
  }

  /**
   * Generate human-readable reasoning for the selection
   */
  private generateReasoning(selected: ModelCandidate, request: CostAwareRouteRequest): string {
    const parts: string[] = [];
    
    parts.push(`Selected ${selected.model} (${selected.provider})`);
    parts.push(`with estimated cost $${selected.estimated_cost_usd.toFixed(4)}`);
    parts.push(`and quality ${Math.round(selected.estimated_quality * 100)}%`);
    
    if (request.strategy === 'quality') {
      parts.push('prioritizing quality');
    } else if (request.strategy === 'cost') {
      parts.push('prioritizing cost efficiency');
    } else {
      parts.push('balancing quality and cost');
    }

    if (request.budget_usd) {
      const budgetUsage = (selected.estimated_cost_usd / request.budget_usd) * 100;
      parts.push(`using ${budgetUsage.toFixed(0)}% of budget`);
    }

    return parts.join('. ') + '.';
  }

  /**
   * Get cost comparison between models
   */
  compareModels(models: string[]): Array<{ model: string; cost_usd: number; quality: number }> {
    return models.map(model => {
      const cost = this.costDatabase.getCost(model);
      if (!cost) {
        return {
          model,
          cost_usd: 0,
          quality: 0
        };
      }

      return {
        model,
        cost_usd: (cost.avg_tokens_per_request / 1000) * (cost.input_cost_per_1k + cost.output_cost_per_1k),
        quality: this.estimateQuality(model, 'code')
      };
    }).sort((a, b) => a.cost_usd - b.cost_usd);
  }

  /**
   * Simplified model selection for direct LLM calls
   * This is a lightweight version of route() for use in omniroute-call.ts
   *
   * `within_budget` reports whether the RETURNED model is expected to fit
   * `budget_usd` — true when there is no budget, the model is unknown to the
   * cost DB (cannot evaluate), the requested model fits, or a cheaper adequate
   * alternative was substituted; FALSE only when the requested model is over
   * budget AND no in-budget alternative meets `min_quality`. Aurora-parity
   * Wave-2 opt-in enforce keys off this signal to decide whether to hard-gate.
   */
  selectModel(params: {
    requested_model: string;
    task_type: string;
    budget_usd?: number;
    min_quality: number;
    use_case: string;
    /**
     * Real prompt size (system + user prompt char length) of the call this
     * decision is about. Threaded by callOmnirouteWithUsage so the budget
     * comparison reflects the ACTUAL call instead of a ~13-char "task: <type>"
     * literal — without it the per-call gate was inert (see estimateRequestCost).
     * Optional with a safe fallback: any caller that omits it keeps the prior
     * (objective-string) estimate behaviour, so no existing caller regresses.
     */
    prompt_chars?: number;
  }): SelectModelResult {
    const { requested_model, task_type, budget_usd, min_quality, use_case, prompt_chars } = params;

    // Convert the real prompt size into an input-token estimate once and reuse
    // it for the requested-model estimate AND every alternative, so all models
    // are compared against the same (true) input cost. undefined → the estimate
    // falls back to the objective-string heuristic inside estimateRequestCost.
    // Mirrors CostDatabase.estimateTokens (~4 chars/token) without allocating a
    // multi-KB filler string for large prompts.
    const inputTokens =
      prompt_chars !== undefined && Number.isFinite(prompt_chars) && prompt_chars >= 0
        ? Math.ceil(prompt_chars / 4)
        : undefined;

    // If no budget constraints, return the requested model
    if (!budget_usd) {
      return {
        recommended_model: requested_model,
        reasoning: 'No budget constraints, using requested model',
        within_budget: true,
        estimated_cost_usd: 0,
      };
    }

    // Get all available models
    const allCosts = this.costDatabase.getAllCosts();

    // Estimate cost for requested model
    const requestedCost = this.costDatabase.getCost(requested_model);
    if (!requestedCost) {
      return {
        recommended_model: requested_model,
        reasoning: 'Requested model not found in cost database, using original',
        within_budget: true,
        estimated_cost_usd: 0,
      };
    }

    const estimatedCost = this.estimateRequestCost(requestedCost, `task: ${task_type}`, inputTokens);

    // If requested model fits budget, use it
    if (estimatedCost <= budget_usd) {
      return {
        recommended_model: requested_model,
        reasoning: `Requested model fits budget ($${estimatedCost.toFixed(4)} <= $${budget_usd.toFixed(4)})`,
        within_budget: true,
        estimated_cost_usd: estimatedCost,
      };
    }

    // Capability preservation (security review): never downshift to a model
    // that DROPS a capability the requested model has — a cheaper model that
    // can't call tools / emit structured output / handle images would silently
    // corrupt a task that needs it. inferCapabilities is heuristic (name-based)
    // but catches the obvious mismatches; quality alone is NOT a capability gate.
    const reqCaps = inferCapabilities(requested_model);
    const preservesCapabilities = (model: string): boolean => {
      const caps = inferCapabilities(model);
      if (reqCaps.tool_calling && !caps.tool_calling) return false;
      if (reqCaps.structured_output && !caps.structured_output) return false;
      if (reqCaps.multimodal && !caps.multimodal) return false;
      return true;
    };

    // Find cheaper alternative that meets the quality threshold AND preserves
    // the requested model's capabilities.
    const alternatives = allCosts
      .filter(cost => {
        const estCost = this.estimateRequestCost(cost, `task: ${task_type}`, inputTokens);
        const quality = this.estimateQuality(cost.model, use_case);
        return estCost <= budget_usd && quality >= min_quality && preservesCapabilities(cost.model);
      })
      .map(cost => ({
        model: cost.model,
        cost: this.estimateRequestCost(cost, `task: ${task_type}`, inputTokens),
        quality: this.estimateQuality(cost.model, use_case)
      }))
      .sort((a, b) => b.quality - a.quality); // Prefer higher quality within budget

    if (alternatives.length > 0) {
      const best = alternatives[0];
      return {
        recommended_model: best.model,
        reasoning: `Requested model over budget ($${estimatedCost.toFixed(4)} > $${budget_usd.toFixed(4)}), selected ${best.model} ($${best.cost.toFixed(4)}, ${Math.round(best.quality * 100)}% quality)`,
        within_budget: true,
        estimated_cost_usd: best.cost,
      };
    }

    // No suitable alternative found, return requested model with warning
    return {
      recommended_model: requested_model,
      reasoning: `No suitable alternative within budget $${budget_usd.toFixed(4)} and quality ${Math.round(min_quality * 100)}%, using requested model (will exceed budget)`,
      within_budget: false,
      estimated_cost_usd: estimatedCost,
    };
  }
}

// Singleton instance for use across the application
let routerInstance: CostAwareRouter | null = null;

export function getCostAwareRouter(): CostAwareRouter {
  if (!routerInstance) {
    routerInstance = new CostAwareRouter();
  }
  return routerInstance;
}