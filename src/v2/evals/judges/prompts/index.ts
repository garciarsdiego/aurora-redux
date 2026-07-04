/**
 * Central export for all LLM-as-judge prompts.
 *
 * Provides factory functions for creating configured prompts for:
 * - Decomposer: H1-H19 heuristic compliance evaluation
 * - Planner: Plan quality evaluation (completeness, feasibility, logical order, etc.)
 * - Reviewer: Review quality evaluation (evidence-based, actionable, fair, etc.)
 */

import {
  DECOMPOSER_JUDGE_SYSTEM_PROMPT,
  buildDecomposerJudgePrompt,
  createDecomposerJudgePrompt,
  type DecomposerJudgeInput,
  type DecomposerJudgeConfig,
} from './decomposer-judge-prompt.js';

import {
  PLANNER_JUDGE_SYSTEM_PROMPT,
  buildPlannerJudgePrompt,
  createPlannerJudgePrompt,
  type PlannerJudgeInput,
  type PlannerJudgeConfig,
} from './planner-judge-prompt.js';

import {
  REVIEWER_JUDGE_SYSTEM_PROMPT,
  buildReviewerJudgePrompt,
  createReviewerJudgePrompt,
  type ReviewerJudgeInput,
  type ReviewerJudgeConfig,
} from './reviewer-judge-prompt.js';

// Re-export all functions and types
export {
  DECOMPOSER_JUDGE_SYSTEM_PROMPT,
  buildDecomposerJudgePrompt,
  createDecomposerJudgePrompt,
  type DecomposerJudgeInput,
  type DecomposerJudgeConfig,
  PLANNER_JUDGE_SYSTEM_PROMPT,
  buildPlannerJudgePrompt,
  createPlannerJudgePrompt,
  type PlannerJudgeInput,
  type PlannerJudgeConfig,
  REVIEWER_JUDGE_SYSTEM_PROMPT,
  buildReviewerJudgePrompt,
  createReviewerJudgePrompt,
  type ReviewerJudgeInput,
  type ReviewerJudgeConfig,
};

/**
 * Unified prompt factory for all agent types.
 *
 * This factory function provides a single entry point for creating
 * judge prompts for any agent type (decomposer, planner, reviewer).
 */
export type AgentType = 'decomposer' | 'planner' | 'reviewer';

export type UnifiedJudgeInput =
  | { agentType: 'decomposer'; input: DecomposerJudgeInput }
  | { agentType: 'planner'; input: PlannerJudgeInput }
  | { agentType: 'reviewer'; input: ReviewerJudgeInput };

export type UnifiedJudgeConfig =
  | { agentType: 'decomposer'; config?: DecomposerJudgeConfig }
  | { agentType: 'planner'; config?: PlannerJudgeConfig }
  | { agentType: 'reviewer'; config?: ReviewerJudgeConfig };

/**
 * Create a judge prompt for any agent type.
 *
 * @param params - Agent type, input, and optional config
 * @returns System prompt and user prompt for the LLM judge
 *
 * @example
 * ```typescript
 * const { systemPrompt, userPrompt } = createJudgePrompt({
 *   agentType: 'decomposer',
 *   input: { objective: '...', dag: {...} },
 *   config: { mandatoryOnly: false }
 * });
 * ```
 */
export function createJudgePrompt(
  params: UnifiedJudgeInput & (UnifiedJudgeConfig | { config?: undefined })
): { systemPrompt: string; userPrompt: string } {
  const { agentType } = params;

  switch (agentType) {
    case 'decomposer': {
      const config = 'config' in params ? params.config : undefined;
      return createDecomposerJudgePrompt(
        params.input as DecomposerJudgeInput,
        config as DecomposerJudgeConfig | undefined
      );
    }

    case 'planner': {
      const config = 'config' in params ? params.config : undefined;
      return createPlannerJudgePrompt(
        params.input as PlannerJudgeInput,
        config as PlannerJudgeConfig | undefined
      );
    }

    case 'reviewer': {
      const config = 'config' in params ? params.config : undefined;
      return createReviewerJudgePrompt(
        params.input as ReviewerJudgeInput,
        config as ReviewerJudgeConfig | undefined
      );
    }

    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }
}

/**
 * Get the default system prompt for an agent type.
 */
export function getDefaultSystemPrompt(agentType: AgentType): string {
  switch (agentType) {
    case 'decomposer':
      return DECOMPOSER_JUDGE_SYSTEM_PROMPT;
    case 'planner':
      return PLANNER_JUDGE_SYSTEM_PROMPT;
    case 'reviewer':
      return REVIEWER_JUDGE_SYSTEM_PROMPT;
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }
}

/**
 * Validation schema for judge prompt outputs.
 *
 * This can be used to validate that the LLM judge returns properly
 * structured JSON with the required fields.
 */
export interface JudgePromptOutput {
  /** Overall score between 0 and 1 */
  score: number;
  /** Detailed reasoning for the score */
  reasoning: string;
  /** Whether the evaluation passed (score >= threshold) */
  passed: boolean;
  /** Optional dimension-specific scores */
  dimension_scores?: Record<string, number>;
  /** Optional list of strengths */
  strengths?: string[];
  /** Optional list of weaknesses */
  weaknesses?: string[];
  /** Optional actionable recommendations */
  recommendations?: string[];
  /** Optional violation details (for decomposer) */
  mandatory_violations?: Array<{
    heuristic: string;
    severity: string;
    task_id: string;
    description: string;
  }>;
  /** Optional violation details (for decomposer) */
  recommended_violations?: Array<{
    heuristic: string;
    severity: string;
    task_id: string;
    description: string;
  }>;
}

/**
 * Validate a judge prompt output.
 *
 * @param output - The output to validate
 * @returns True if valid, throws error if invalid
 */
export function validateJudgeOutput(output: unknown): output is JudgePromptOutput {
  if (typeof output !== 'object' || output === null) {
    throw new Error('Judge output must be an object');
  }

  const obj = output as Record<string, unknown>;

  if (typeof obj.score !== 'number' || obj.score < 0 || obj.score > 1) {
    throw new Error('Judge output must have a valid score (number between 0 and 1)');
  }

  if (typeof obj.reasoning !== 'string') {
    throw new Error('Judge output must have a reasoning string');
  }

  if (typeof obj.passed !== 'boolean') {
    throw new Error('Judge output must have a passed boolean');
  }

  return true;
}

/**
 * Extract JSON from an LLM response.
 *
 * LLM responses may include markdown code blocks or other text.
 * This function attempts to extract the JSON object.
 *
 * @param response - The raw LLM response text
 * @returns The parsed JSON object
 * @throws Error if JSON cannot be extracted or parsed
 */
export function extractJsonFromResponse(response: string): unknown {
  // Try to extract JSON from markdown code block
  const codeBlockMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return JSON.parse(codeBlockMatch[1]);
  }

  // Try to extract JSON from plain code block
  const plainBlockMatch = response.match(/```\s*([\s\S]*?)\s*```/);
  if (plainBlockMatch) {
    try {
      return JSON.parse(plainBlockMatch[1]);
    } catch {
      // Continue to next attempt
    }
  }

  // Try to parse the entire response as JSON
  try {
    return JSON.parse(response);
  } catch {
    // Try to find the first JSON object in the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  }

  throw new Error('Could not extract valid JSON from LLM response');
}