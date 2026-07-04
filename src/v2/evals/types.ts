/**
 * Core types & Zod schemas for the Omniforge Agent Harness.
 *
 * Design ref: docs/AGENT-HARNESS-DESIGN.md
 * Migration:  src/db/migrations/050_agent_harness.sql
 *
 * Backward compat note: existing `EvalCase` / `EvalRun` / `EvalResult`
 * in src/v2/evals/harness.ts are RE-EXPORTED below and extended via
 * the new TestCase<I,E> generic surface.
 */

import { z } from 'zod';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';

// ────────────────────────────────────────────────────────────────────
//  1. TEST CASES
// ────────────────────────────────────────────────────────────────────

export const SuiteKindSchema = z.enum([
  'decomposer',
  'planner',
  'reviewer',
  'integration',
  'custom',
]);
export type SuiteKind = z.infer<typeof SuiteKindSchema>;

export const CaseSourceSchema = z.enum(['manual', 'synthetic', 'replay']);
export type CaseSource = z.infer<typeof CaseSourceSchema>;

export const TestCaseSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  suite: SuiteKindSchema,
  name: z.string().min(1).max(160),
  input: z.unknown(),
  expected: z.unknown(),
  context: z.record(z.string(), z.unknown()).optional(),
  tags: z.array(z.string().min(1)).default([]),
  source: CaseSourceSchema.default('manual'),
  variant_id: z.string().nullable().optional(),
  created_at: z.number().int(),
});
export type TestCase<I = unknown, E = unknown> =
  Omit<z.infer<typeof TestCaseSchema>, 'input' | 'expected'> & {
    input: I;
    expected: E;
  };

export const RegisterTestCaseInputSchema = TestCaseSchema
  .omit({ id: true, created_at: true })
  .partial({ source: true, tags: true });
export type RegisterTestCaseInput = z.infer<typeof RegisterTestCaseInputSchema>;

// ────────────────────────────────────────────────────────────────────
//  2. METRICS
// ────────────────────────────────────────────────────────────────────

export interface MetricInput<O = unknown, E = unknown> {
  testCase: TestCase<unknown, E>;
  output: O;
  expected: E;
  /** Optional supporting context for retrieval/CoT metrics. */
  context?: Record<string, unknown>;
}

export const MetricScoreSchema = z.object({
  score: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  passed: z.boolean(),
  reason: z.string().optional(),
  cost_usd: z.number().nonnegative().default(0),
  latency_ms: z.number().int().nonnegative().default(0),
  /** Optional opaque metadata (e.g., per-step breakdowns from G-Eval). */
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type MetricScore = z.infer<typeof MetricScoreSchema>;

export interface Metric<O = unknown, E = unknown> {
  /** Unique within a run; used as DB key (`eval_metric_scores.metric_name`). */
  readonly name: string;
  /** Score threshold ∈ [0,1]; `score >= threshold` ⇒ `passed=true`. */
  readonly threshold: number;
  /** strict=true → metric gates pass/fail at suite level. */
  readonly strict?: boolean;
  /** Optional human description for reports. */
  readonly description?: string;
  measure(input: MetricInput<O, E>): Promise<MetricScore>;
}

// ────────────────────────────────────────────────────────────────────
//  3. JUDGES
// ────────────────────────────────────────────────────────────────────

export interface JudgeInput<O = unknown, E = unknown> {
  testCase: TestCase<unknown, E>;
  output: O;
  expected: E;
  rubric: string;
  /** Stringified evaluation steps (G-Eval style). */
  steps?: string[];
}

export interface JudgeOutput {
  /** Normalized score 0..1 (judge implementations rescale). */
  score: number;
  /** Free-text rationale; cached. */
  reason: string;
  /** Raw LLM JSON before parsing (for audit). */
  raw: string;
  cost_usd: number;
  latency_ms: number;
  cache_hit: boolean;
}

export interface Judge {
  readonly name: string;
  /** Identifier used for cache key derivation (e.g., 'g-eval-v1'). */
  readonly version: string;
  evaluate(input: JudgeInput): Promise<JudgeOutput>;
}

// LLM-judge runtime config (used by `judges/llm-judge.ts`)
export const LlmJudgeConfigSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0),
  max_tokens: z.number().int().positive().default(1024),
  cache: z.boolean().default(true),
  iterations: z.number().int().min(1).max(10).default(1),
  /** Aggregation across iterations when iterations > 1. */
  aggregate: z.enum(['mean', 'median', 'min']).default('mean'),
});
export type LlmJudgeConfig = z.infer<typeof LlmJudgeConfigSchema>;

// ────────────────────────────────────────────────────────────────────
//  4. EVAL RESULTS  (extends harness.ts surface)
// ────────────────────────────────────────────────────────────────────

export const EvalResultStatusSchema = z.enum(['passed', 'failed', 'error', 'skipped']);
export type EvalResultStatus = z.infer<typeof EvalResultStatusSchema>;

/** Composite result for a single test case across N metrics. */
export interface EvalResult {
  id: string;
  run_id: string;
  case_id: string;
  status: EvalResultStatus;
  /** Aggregated score (mean across non-strict metrics; gated by strict ones). */
  score: number;
  output_json: string | null;
  feedback: string | null;
  error: string | null;
  metric_scores: PersistedMetricScore[];
  created_at: number;
}

export interface PersistedMetricScore extends MetricScore {
  id: string;
  metric_name: string;
  result_id: string;
  created_at: number;
}

export interface EvalRun {
  id: string;
  workspace: string;
  suite_name: string;
  status: 'running' | 'completed' | 'failed';
  score: number;
  case_count: number;
  variant_id: string | null;
  ab_test_id: string | null;
  created_at: number;
  completed_at: number | null;
  total_cost_usd?: number;
  total_clock_ms?: number;
  agent_type?: 'decomposer' | 'planner' | 'reviewer' | null;
  metadata_json?: string;
}

// ────────────────────────────────────────────────────────────────────
//  5. PROMPT VARIANTS
// ────────────────────────────────────────────────────────────────────

export const FewShotExampleSchema = z.object({
  input: z.string().min(1),
  output: z.string().min(1),
  note: z.string().optional(),
});
export type FewShotExample = z.infer<typeof FewShotExampleSchema>;

export const PromptComponentSchema = z.enum(['decomposer', 'planner', 'reviewer']);
export type PromptComponent = z.infer<typeof PromptComponentSchema>;

export const PromptVariantSchema = z.object({
  id: z.string().min(1),
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  component: PromptComponentSchema,
  name: z.string().min(1).max(120),
  prompt_text: z.string().min(1).max(200_000),
  few_shots: z.array(FewShotExampleSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
  parent_id: z.string().nullable().optional(),
  created_at: z.number().int(),
});
export type PromptVariant = z.infer<typeof PromptVariantSchema>;

export const RegisterVariantInputSchema = PromptVariantSchema
  .omit({ id: true, created_at: true })
  .partial({ few_shots: true, metadata: true, parent_id: true });
export type RegisterVariantInput = z.infer<typeof RegisterVariantInputSchema>;

// ────────────────────────────────────────────────────────────────────
//  6. A/B TESTING
// ────────────────────────────────────────────────────────────────────

export const SignificanceMethodSchema = z.enum(['bootstrap', 'mcnemar']);
export type SignificanceMethod = z.infer<typeof SignificanceMethodSchema>;

export const ABTestConfigSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  variantAId: z.string().min(1),
  variantBId: z.string().min(1),
  caseIds: z.array(z.string().min(1)).min(1),
  metricNames: z.array(z.string().min(1)).min(1),
  significance: SignificanceMethodSchema.default('bootstrap'),
  /** Bootstrap resamples (ignored for mcnemar). */
  iterations: z.number().int().min(100).max(100_000).default(10_000),
  /** Alpha (one-sided typically). */
  alpha: z.number().min(0.001).max(0.5).default(0.05),
});
export type ABTestConfig = z.infer<typeof ABTestConfigSchema>;

export interface ABTestResult {
  id: string;
  config: ABTestConfig;
  runA: EvalRun;
  runB: EvalRun;
  winner: 'a' | 'b' | 'tie';
  confidence: number;       // p-value (mcnemar) or 1 - α coverage (bootstrap)
  deltaScore: number;       // meanB - meanA
  ci95: [number, number];   // bootstrap CI on delta
  perMetric: Record<string, { deltaScore: number; winner: 'a' | 'b' | 'tie' }>;
  createdAt: number;
}

// ────────────────────────────────────────────────────────────────────
//  7. OPTIMIZATION
// ────────────────────────────────────────────────────────────────────

export const OptimizationStrategySchema = z.enum(['random', 'grid', 'bandit-ucb1']);
export type OptimizationStrategy = z.infer<typeof OptimizationStrategySchema>;

/** Parameterized prompt search space. Each axis is a discrete enum. */
export const PromptSearchSpaceSchema = z.object({
  /** e.g. {"temperature":[0,0.2,0.5], "fewShotCount":[0,3,5]} */
  axes: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))),
  /** Optional template with `${axis}` placeholders. */
  promptTemplate: z.string().optional(),
});
export type PromptSearchSpace = z.infer<typeof PromptSearchSpaceSchema>;

export const OptimizationBudgetSchema = z.object({
  maxIterations: z.number().int().min(1).max(1000).default(20),
  maxCostUsd: z.number().positive().default(2.0),
  maxClockMs: z.number().int().positive().default(15 * 60 * 1000),
});
export type OptimizationBudget = z.infer<typeof OptimizationBudgetSchema>;

export const OptimizationConfigSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  baseVariantId: z.string().min(1),
  searchSpace: PromptSearchSpaceSchema,
  caseIds: z.array(z.string().min(1)).min(3),
  metricNames: z.array(z.string().min(1)).min(1),
  /** Single metric used as the optimization target; must be in metricNames. */
  objective: z.string().min(1),
  budget: OptimizationBudgetSchema,
  strategy: OptimizationStrategySchema.default('random'),
  /** Random seed for reproducibility. */
  seed: z.number().int().optional(),
});
export type OptimizationConfig = z.infer<typeof OptimizationConfigSchema>;

export interface OptimizationTrial {
  iteration: number;
  variantId: string;
  axisValues: Record<string, string | number | boolean>;
  objectiveScore: number;
  metricScores: Record<string, number>;
  costUsd: number;
  clockMs: number;
}

export interface OptimizationResult {
  config: OptimizationConfig;
  trials: OptimizationTrial[];
  bestTrial: OptimizationTrial;
  baselineScore: number;
  improvement: number;       // best - baseline
  totalCostUsd: number;
  totalClockMs: number;
  stoppedReason: 'iterations' | 'cost' | 'clock' | 'converged';
}

// ────────────────────────────────────────────────────────────────────
//  8. RUNNER CONFIG
// ────────────────────────────────────────────────────────────────────

export const EvalRunnerConfigSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  suiteName: z.string().min(1).max(160),
  caseIds: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  /** Names of metrics to apply (must be pre-registered). */
  metricNames: z.array(z.string().min(1)).min(1),
  variantId: z.string().nullable().optional(),
  parallelism: z.number().int().min(1).max(32).default(4),
  abortOnError: z.boolean().default(false),
  /** Hard budget for total LLM-judge cost across the run. */
  maxCostUsd: z.number().positive().default(2.0),
});
export type EvalRunnerConfig = z.infer<typeof EvalRunnerConfigSchema>;

/**
 * Runner injects the SUT (system under test).
 * For decomposer evals, runner = `(tc) => decompose(tc.input.objective)`.
 */
export type SystemUnderTest<I = unknown, O = unknown> = (
  testCase: TestCase<I, unknown>,
) => Promise<O>;

// ────────────────────────────────────────────────────────────────────
//  9. REPORTING
// ────────────────────────────────────────────────────────────────────

export interface EvalReport {
  run: EvalRun;
  results: EvalResult[];
  perMetricSummary: Record<string, {
    mean: number;
    median: number;
    passRate: number;
    n: number;
  }>;
  regressionsVsBaseline?: Array<{
    metric: string;
    baselineMean: number;
    currentMean: number;
    deltaPct: number;
  }>;
}

// ────────────────────────────────────────────────────────────────────
// 10. CALIBRATION
// ────────────────────────────────────────────────────────────────────

export interface CalibrationModel {
  kind: 'platt' | 'identity';
  /** Platt: P(positive | score) = sigmoid(a*score + b) */
  a?: number;
  b?: number;
  /** Diagnostic: AUC on calibration set. */
  auc?: number;
  fittedAt: number;
}

export interface CalibratedJudge extends Judge {
  /** Returns raw + calibrated probability. */
  calibrate(raw: number): number;
  readonly calibration: CalibrationModel;
}

// ────────────────────────────────────────────────────────────────────
// 11. JUDGE CACHE
// ────────────────────────────────────────────────────────────────────

export interface JudgeCacheEntry {
  cache_key: string;
  model: string;
  score: number;
  reason: string;
  raw_json: string;
  cost_usd: number;
  created_at: number;
  hit_count: number;
}

// ────────────────────────────────────────────────────────────────────
// 12. SYNTHETIC DATASETS (DeepEval-style evolutions)
// ────────────────────────────────────────────────────────────────────

export const EvolutionKindSchema = z.enum([
  'reasoning',     // add multi-step reasoning requirement
  'multi-context', // require synthesizing multiple contexts
  'breadth',       // broaden scope / coverage
  'depth',         // deepen technical specificity
  'comparative',   // turn into A/B/C choice
]);
export type EvolutionKind = z.infer<typeof EvolutionKindSchema>;

export const SyntheticGenerationConfigSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  suite: SuiteKindSchema,
  seedCaseIds: z.array(z.string().min(1)).min(1),
  evolutions: z.array(EvolutionKindSchema).min(1),
  count: z.number().int().min(1).max(200),
  judgeModel: z.string().min(1),
  /** If true, mark as draft until human review via MCP tool. */
  requireReview: z.boolean().default(true),
});
export type SyntheticGenerationConfig = z.infer<typeof SyntheticGenerationConfigSchema>;

// ────────────────────────────────────────────────────────────────────
// 13. RE-EXPORTS (backward-compat with harness.ts)
// ────────────────────────────────────────────────────────────────────

export type {
  // Legacy surface — keep alive during transition.
  EvalCase,
  JudgeResult,
} from './harness.js';