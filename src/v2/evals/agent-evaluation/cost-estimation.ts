/**
 * Shared cost/token estimation helpers for agent evaluators.
 *
 * Rough estimations based on model tier — previously duplicated across the
 * decomposer, planner, and reviewer evaluators. Intentionally not re-exported
 * by the agent-evaluation barrel (internal helper, not public API).
 */

export type ModelTier = 'premium' | 'balanced' | 'cost' | 'alternative';

const COST_PER_SECOND: Record<ModelTier, number> = {
  premium: 0.0001,      // ~$0.36/hour
  balanced: 0.00005,    // ~$0.18/hour
  cost: 0.00001,        // ~$0.036/hour
  alternative: 0.000008 // ~$0.029/hour
};

const COMPLEXITY_MULTIPLIER = {
  simple: 1.0,
  medium: 2.0,
  complex: 4.0
} as const;

/**
 * Get model tier for cost estimation
 */
export function getModelTier(model: string): ModelTier {
  if (model.includes('claude-opus') || model.includes('gpt-5.5')) return 'premium';
  if (model.includes('claude-sonnet') || model.includes('kimi') || model.includes('opencode')) return 'balanced';
  if (model.includes('gemini') || model.includes('deepseek') || model.includes('minimax')) return 'cost';
  return 'alternative';
}

/**
 * Estimate cost based on model tier and duration
 */
export function estimateCost(model: string, duration: number): number {
  const rate = COST_PER_SECOND[getModelTier(model)];
  return (duration / 1000) * rate;
}

/**
 * Estimate token usage based on test case complexity
 */
export function estimateTokens(complexity: string, baseTokens = 1000): number {
  return baseTokens * COMPLEXITY_MULTIPLIER[complexity as keyof typeof COMPLEXITY_MULTIPLIER];
}
