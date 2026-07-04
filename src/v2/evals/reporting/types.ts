/**
 * Reporting types for the Agent Harness observability system.
 * These types are used for dashboard integration, alerts, and API responses.
 */

import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────
//  DASHBOARD REPORTING TYPES
// ────────────────────────────────────────────────────────────────────

export const EvalRunEventTypeSchema = z.enum([
  'started',
  'completed',
  'failed',
  'metric_scored',
  'case_completed',
  'case_failed',
  'optimization_iteration',
  'optimization_completed',
]);
export type EvalRunEventType = z.infer<typeof EvalRunEventTypeSchema>;

export const EvalRunEventSchema = z.object({
  id: z.string(),
  run_id: z.string(),
  event_type: EvalRunEventTypeSchema,
  message: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.number().int(),
});
export type EvalRunEvent = z.infer<typeof EvalRunEventSchema>;

export const EvalRunSummarySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  suite_name: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
  score: z.number(),
  case_count: z.number(),
  variant_id: z.string().nullable(),
  ab_test_id: z.string().nullable(),
  agent_type: z.enum(['decomposer', 'planner', 'reviewer']).nullable(),
  total_cost_usd: z.number(),
  total_clock_ms: z.number(),
  created_at: z.number(),
  completed_at: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EvalRunSummary = z.infer<typeof EvalRunSummarySchema>;

export const MetricScoreDetailSchema = z.object({
  id: z.string(),
  metric_name: z.string(),
  score: z.number(),
  threshold: z.number(),
  passed: z.boolean(),
  reason: z.string().optional(),
  cost_usd: z.number(),
  latency_ms: z.number(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type MetricScoreDetail = z.infer<typeof MetricScoreDetailSchema>;

export const TestCaseResultSchema = z.object({
  id: z.string(),
  case_id: z.string(),
  case_name: z.string(),
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
  score: z.number(),
  output_json: z.string().nullable(),
  feedback: z.string().nullable(),
  error: z.string().nullable(),
  metric_scores: z.array(MetricScoreDetailSchema),
  created_at: z.number(),
});
export type TestCaseResult = z.infer<typeof TestCaseResultSchema>;

export const EvalRunDetailsSchema = z.object({
  run: EvalRunSummarySchema,
  results: z.array(TestCaseResultSchema),
  per_metric_summary: z.record(z.string(), z.object({
    mean: z.number(),
    median: z.number(),
    pass_rate: z.number(),
    n: z.number(),
  })),
  events: z.array(EvalRunEventSchema),
});
export type EvalRunDetails = z.infer<typeof EvalRunDetailsSchema>;

// ────────────────────────────────────────────────────────────────────
//  A/B TEST REPORTING TYPES
// ────────────────────────────────────────────────────────────────────

export const ABTestSummarySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  variant_a_id: z.string(),
  variant_b_id: z.string(),
  variant_a_name: z.string(),
  variant_b_name: z.string(),
  run_a_id: z.string(),
  run_b_id: z.string(),
  winner: z.enum(['a', 'b', 'tie']),
  confidence: z.number(),
  delta_score: z.number(),
  ci95_low: z.number(),
  ci95_high: z.number(),
  per_metric: z.record(z.string(), z.object({
    delta_score: z.number(),
    winner: z.enum(['a', 'b', 'tie']),
  })),
  created_at: z.number(),
});
export type ABTestSummary = z.infer<typeof ABTestSummarySchema>;

export const ABTestDetailsSchema = z.object({
  test: ABTestSummarySchema,
  run_a: EvalRunDetailsSchema,
  run_b: EvalRunDetailsSchema,
});
export type ABTestDetails = z.infer<typeof ABTestDetailsSchema>;

// ────────────────────────────────────────────────────────────────────
//  OPTIMIZATION REPORTING TYPES
// ────────────────────────────────────────────────────────────────────

export const OptimizationStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type OptimizationStatus = z.infer<typeof OptimizationStatusSchema>;

export const OptimizationStrategySchema = z.enum([
  'bootstrap-fewshot',
  'miprov2',
  'gepa',
  'random',
  'grid',
  'bandit-ucb1',
]);
export type OptimizationStrategy = z.infer<typeof OptimizationStrategySchema>;

export const OptimizationRunSummarySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  base_variant_id: z.string(),
  strategy: OptimizationStrategySchema,
  target_metric: z.string(),
  max_iterations: z.number().int(),
  max_cost_usd: z.number(),
  max_clock_ms: z.number().int(),
  status: OptimizationStatusSchema,
  current_iteration: z.number().int(),
  best_score: z.number().nullable(),
  best_variant_id: z.string().nullable(),
  total_cost_usd: z.number(),
  total_clock_ms: z.number().int(),
  stopped_reason: z.string().nullable(),
  created_at: z.number(),
  completed_at: z.number().nullable(),
});
export type OptimizationRunSummary = z.infer<typeof OptimizationRunSummarySchema>;

export const OptimizationTrialSchema = z.object({
  id: z.string(),
  optimization_id: z.string(),
  iteration: z.number().int(),
  variant_id: z.string(),
  axis_values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  objective_score: z.number(),
  metric_scores: z.record(z.string(), z.number()),
  cost_usd: z.number(),
  clock_ms: z.number().int(),
  created_at: z.number(),
});
export type OptimizationTrial = z.infer<typeof OptimizationTrialSchema>;

export const OptimizationRunDetailsSchema = z.object({
  run: OptimizationRunSummarySchema,
  trials: z.array(OptimizationTrialSchema),
});
export type OptimizationRunDetails = z.infer<typeof OptimizationRunDetailsSchema>;

// ────────────────────────────────────────────────────────────────────
//  ALERTING TYPES
// ────────────────────────────────────────────────────────────────────

export const RegressionAlertSchema = z.object({
  run_id: z.string(),
  workspace: z.string(),
  suite_name: z.string(),
  baseline_run_id: z.string(),
  metric: z.string(),
  baseline_score: z.number(),
  current_score: z.number(),
  delta_pct: z.number(),
  threshold_pct: z.number(),
  timestamp: z.number(),
});
export type RegressionAlert = z.infer<typeof RegressionAlertSchema>;

export const ABTestWinnerAlertSchema = z.object({
  test_id: z.string(),
  workspace: z.string(),
  winner: z.enum(['a', 'b', 'tie']),
  variant_a_name: z.string(),
  variant_b_name: z.string(),
  confidence: z.number(),
  delta_score: z.number(),
  timestamp: z.number(),
});
export type ABTestWinnerAlert = z.infer<typeof ABTestWinnerAlertSchema>;

export const OptimizationCompleteAlertSchema = z.object({
  optimization_id: z.string(),
  workspace: z.string(),
  strategy: OptimizationStrategySchema,
  best_score: z.number(),
  baseline_score: z.number(),
  improvement: z.number(),
  total_cost_usd: z.number(),
  total_iterations: z.number().int(),
  stopped_reason: z.string(),
  timestamp: z.number(),
});
export type OptimizationCompleteAlert = z.infer<typeof OptimizationCompleteAlertSchema>;

// ────────────────────────────────────────────────────────────────────
//  API REQUEST/RESPONSE TYPES
// ────────────────────────────────────────────────────────────────────

export const ListEvalRunsFilterSchema = z.object({
  workspace: z.string().optional(),
  agent_type: z.enum(['decomposer', 'planner', 'reviewer']).optional(),
  variant_id: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed']).optional(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListEvalRunsFilter = z.infer<typeof ListEvalRunsFilterSchema>;

export const ListEvalRunsResponseSchema = z.object({
  runs: z.array(EvalRunSummarySchema),
  total: z.number().int(),
});
export type ListEvalRunsResponse = z.infer<typeof ListEvalRunsResponseSchema>;

export const ListABTestsFilterSchema = z.object({
  workspace: z.string().optional(),
  variant_id: z.string().optional(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListABTestsFilter = z.infer<typeof ListABTestsFilterSchema>;

export const ListABTestsResponseSchema = z.object({
  tests: z.array(ABTestSummarySchema),
  total: z.number().int(),
});
export type ListABTestsResponse = z.infer<typeof ListABTestsResponseSchema>;

export const ListOptimizationsFilterSchema = z.object({
  workspace: z.string().optional(),
  strategy: OptimizationStrategySchema.optional(),
  status: OptimizationStatusSchema.optional(),
  since: z.number().int().optional(),
  until: z.number().int().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListOptimizationsFilter = z.infer<typeof ListOptimizationsFilterSchema>;

export const ListOptimizationsResponseSchema = z.object({
  optimizations: z.array(OptimizationRunSummarySchema),
  total: z.number().int(),
});
export type ListOptimizationsResponse = z.infer<typeof ListOptimizationsResponseSchema>;

export const ListVariantsFilterSchema = z.object({
  workspace: z.string().optional(),
  component: z.enum(['decomposer', 'planner', 'reviewer']).optional(),
  active_only: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListVariantsFilter = z.infer<typeof ListVariantsFilterSchema>;

export const PromptVariantSummarySchema = z.object({
  id: z.string(),
  workspace: z.string(),
  component: z.enum(['decomposer', 'planner', 'reviewer']),
  name: z.string(),
  parent_id: z.string().nullable(),
  created_at: z.number(),
  is_active: z.boolean(),
});
export type PromptVariantSummary = z.infer<typeof PromptVariantSummarySchema>;

export const ListVariantsResponseSchema = z.object({
  variants: z.array(PromptVariantSummarySchema),
  total: z.number().int(),
});
export type ListVariantsResponse = z.infer<typeof ListVariantsResponseSchema>;

export const ActivateVariantRequestSchema = z.object({
  workspace: z.string(),
  component: z.enum(['decomposer', 'planner', 'reviewer']),
  variant_id: z.string(),
});
export type ActivateVariantRequest = z.infer<typeof ActivateVariantRequestSchema>;

export const ActivateVariantResponseSchema = z.object({
  success: z.boolean(),
  activated_at: z.number(),
});
export type ActivateVariantResponse = z.infer<typeof ActivateVariantResponseSchema>;