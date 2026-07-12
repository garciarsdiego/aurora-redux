import { getCostDatabase } from './CostDatabase.js';
import { estimateUseCaseQuality } from './catalog-quality.js';
import type { CostRecord } from './types.js';

interface OptimizationContext {
  current_cost: number;
  budget: number;
  remaining_tasks: number;
  current_model: string;
  task_kind: string;
  use_case: string;
}

interface OptimizationAction {
  action: 'continue' | 'downgrade_model' | 'early_terminate';
  new_model?: string;
  reasoning: string;
}

/** Average of input/output pricing per 1k tokens — used for cheapness comparisons. */
function avgCostPerToken(record: CostRecord): number {
  return (record.input_cost_per_1k + record.output_cost_per_1k) / 2;
}

/** Estimated cost of one average-sized request for a model. */
function avgCostPerRequest(record: CostRecord): number {
  return (record.avg_tokens_per_request / 1000) * (record.input_cost_per_1k + record.output_cost_per_1k);
}

export class CostOptimizer {
  private costDatabase = getCostDatabase();

  /**
   * Determine if optimization is needed
   */
  async shouldOptimize(context: OptimizationContext): Promise<boolean> {
    // Optimize if:
    // 1. Over 75% of budget used with remaining tasks
    // 2. Current cost is significantly higher than alternatives
    const budgetUsage = context.current_cost / context.budget;
    
    if (budgetUsage >= 0.75 && context.remaining_tasks > 0) {
      return true;
    }

    // Check if there's a cheaper model with acceptable quality
    const cheaperModel = await this.findCheaperModel(
      context.current_model,
      0.7, // Minimum quality threshold
      context.use_case
    );

    if (cheaperModel && this.isSignificantlyCheaper(context.current_model, cheaperModel)) {
      return true;
    }

    return false;
  }

  /**
   * Recommend optimization action
   */
  async recommendAction(context: OptimizationContext): Promise<OptimizationAction> {
    const budgetUsage = context.current_cost / context.budget;

    // Critical: over 100% budget
    if (budgetUsage >= 1.0) {
      return {
        action: 'early_terminate',
        reasoning: `Budget exceeded: $${context.current_cost.toFixed(4)} / $${context.budget.toFixed(4)}`
      };
    }

    // High usage: over 90% budget
    if (budgetUsage >= 0.9) {
      const cheaperModel = await this.findCheaperModel(context.current_model, 0.6, context.use_case);
      if (cheaperModel) {
        return {
          action: 'downgrade_model',
          new_model: cheaperModel,
          reasoning: `Budget at ${Math.round(budgetUsage * 100)}%. Downgrade to ${cheaperModel} to stay within budget.`
        };
      }
    }

    return {
      action: 'continue',
      reasoning: `Budget usage at ${Math.round(budgetUsage * 100)}%. No optimization needed.`
    };
  }

  /**
   * Find a cheaper model with minimum quality threshold
   */
  async findCheaperModel(
    currentModel: string,
    minQuality: number,
    use_case: string
  ): Promise<string | null> {
    const currentCost = this.costDatabase.getCost(currentModel);
    if (!currentCost) {
      return null;
    }

    const currentCostPerToken = avgCostPerToken(currentCost);

    const allCosts = this.costDatabase.getAllCosts();
    const candidates = allCosts
      .filter(cost => avgCostPerToken(cost) < currentCostPerToken * 0.7) // At least 30% cheaper
      .map(cost => ({
        model: cost.model,
        costPerToken: avgCostPerToken(cost),
        quality: this.estimateQuality(cost.model, use_case)
      }))
      .filter(c => c.quality >= minQuality)
      .sort((a, b) => a.costPerToken - b.costPerToken);

    return candidates.length > 0 ? candidates[0].model : null;
  }

  /**
   * Estimate remaining cost for workflow
   */
  async estimateRemainingCost(context: OptimizationContext): Promise<number> {
    const currentModel = this.costDatabase.getCost(context.current_model);
    if (!currentModel) {
      return 0;
    }

    return avgCostPerRequest(currentModel) * context.remaining_tasks;
  }

  /**
   * Check if a model is significantly cheaper than another
   */
  private isSignificantlyCheaper(currentModel: string, candidateModel: string): boolean {
    const currentCost = this.costDatabase.getCost(currentModel);
    const candidateCost = this.costDatabase.getCost(candidateModel);

    if (!currentCost || !candidateCost) {
      return false;
    }

    return avgCostPerToken(candidateCost) < avgCostPerToken(currentCost) * 0.7; // At least 30% cheaper
  }

  /**
   * Estimate quality for a model (0-1).
   *
   * Delegates to the shared catalog-quality helper so this heuristic stays in
   * sync with CostAwareRouter (same base quality source, same use-case table).
   */
  private estimateQuality(model: string, use_case: string): number {
    return estimateUseCaseQuality(model, use_case);
  }

  /**
   * Get cost optimization recommendations for a workflow
   */
  async getOptimizationPlan(
    workflow_id: string,
    currentModel: string,
    budget: number,
    remainingTasks: number,
    use_case: string
  ): Promise<{
    should_optimize: boolean;
    action: OptimizationAction;
    estimated_savings: number;
  }> {
    // De-mock (MCP-02): ground the plan in REAL recorded spend for this
    // workflow from the usage ledger, instead of the hardcoded current_cost: 0.
    const currentCost = this.costDatabase.getTotalRealSpend({ workflow_id }).total_cost_usd;
    const context: OptimizationContext = {
      current_cost: currentCost,
      budget,
      remaining_tasks: remainingTasks,
      current_model: currentModel,
      task_kind: 'general',
      use_case: use_case || 'general'
    };

    const shouldOptimize = await this.shouldOptimize(context);
    const action = await this.recommendAction(context);
    
    // Estimate savings if downgrading
    let estimatedSavings = 0;
    if (action.action === 'downgrade_model' && action.new_model) {
      const currentRecord = this.costDatabase.getCost(currentModel);
      const newRecord = this.costDatabase.getCost(action.new_model);

      if (currentRecord && newRecord) {
        estimatedSavings = (avgCostPerRequest(currentRecord) - avgCostPerRequest(newRecord)) * remainingTasks;
      }
    }

    return {
      should_optimize: shouldOptimize,
      action,
      estimated_savings: estimatedSavings
    };
  }
}