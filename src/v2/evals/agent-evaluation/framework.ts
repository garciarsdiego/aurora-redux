/**
 * Agent Evaluation Framework
 *
 * Comprehensive framework for evaluating Omniforge agents across multiple models
 * to establish performance baselines and guide optimization efforts.
 */

// Real evaluator implementations (integrate with actual Omniforge agents).
// Imported via direct file paths (not the barrel) to avoid a name clash with the
// `export *` from this same module, and so `initializeEvaluators()` wires the
// real classes instead of the former in-file stubs (INTEL-02 / STUB-01).
import { DecomposerEvaluator } from './decomposer-evaluator.js';
import { PlannerEvaluator } from './planner-evaluator.js';
import { ReviewerEvaluator } from './reviewer-evaluator.js';
import { OrchestratorEvaluator } from './orchestrator-evaluator.js';

// ============================================================================
// TYPES AND INTERFACES
// ============================================================================

export type AgentType = 'decomposer' | 'planner' | 'reviewer' | 'orchestrator';

export interface TestCase {
  id: string;
  agent: AgentType;
  name: string;
  description: string;
  input: any;
  expectedOutput: any;
  complexity: 'simple' | 'medium' | 'complex';
  category: string;
  tags: string[];
  metadata?: Record<string, any>;
}

export interface AgentEvaluationConfig {
  agent: AgentType;
  model: string;
  testCases: TestCase[];
  timeout?: number;
  maxRetries?: number;
}

export interface EvaluationResult {
  testCaseId: string;
  agent: AgentType;
  model: string;
  success: boolean;
  duration: number;
  cost: number;
  output: any;
  error?: string;
  metrics: EvaluationMetrics;
}

export interface EvaluationMetrics {
  // Quality metrics
  qualityScore: number;        // 0-1 overall quality
  accuracy: number;            // Output matches expected
  completeness: number;        // All required elements present
  correctness: number;         // Factual correctness

  // Performance metrics
  latency: number;             // Response time in ms
  tokenUsage: number;          // Total tokens used
  cost: number;                // Cost in USD

  // Agent-specific metrics
  agentSpecific: Record<string, number>;
}

export interface AgentBenchmark {
  agent: AgentType;
  model: string;
  results: EvaluationResult[];
  summary: BenchmarkSummary;
}

export interface BenchmarkSummary {
  totalTests: number;
  successfulTests: number;
  successRate: number;
  avgQualityScore: number;
  avgLatency: number;
  avgCost: number;
  totalCost: number;
  byComplexity: {
    simple: { successRate: number; avgQuality: number; count: number };
    medium: { successRate: number; avgQuality: number; count: number };
    complex: { successRate: number; avgQuality: number; count: number };
  };
  byCategory: Record<string, { successRate: number; avgQuality: number; count: number }>;
  strengths: string[];
  weaknesses: string[];
}

export interface ComparativeMatrix {
  agents: Record<AgentType, Record<string, BenchmarkSummary>>;
  bestModelByAgent: Record<AgentType, { model: string; summary: BenchmarkSummary }>;
  bestModelByMetric: Record<string, { agent: AgentType; model: string; value: number }>;
  recommendations: string[];
}

export interface EvaluationSummary {
  agent: AgentType;
  model: string;
  results: EvaluationResult[];
  successRate: number;
  averageQualityScore: number;
  averageAccuracy: number;
  averageCost: number;
  averageLatency: number;
  totalCost: number;
  totalDuration: number;
}

// ============================================================================
// MODEL CONFIGURATIONS
// ============================================================================

export const MODEL_CONFIGS = {
  // Premium models
  'cc/claude-opus-4-6': { tier: 'premium', specialty: 'reasoning', cost: 'high', speed: 'medium' },
  'cx/gpt-5.5': { tier: 'premium', specialty: 'coding', cost: 'high', speed: 'medium' },

  // Balanced models
  'cc/claude-sonnet-4-6': { tier: 'balanced', specialty: 'general', cost: 'medium', speed: 'fast' },
  'kimi-coding/kimi-k2.6': { tier: 'balanced', specialty: 'coding', cost: 'medium', speed: 'fast' },
  'kimi-coding/kimi-k2.6-thinking': { tier: 'balanced', specialty: 'reasoning', cost: 'medium', speed: 'medium' },

  // Cost-optimized models
  'gemini-cli/gemini-3.1-flash-lite-preview': { tier: 'cost', specialty: 'speed', cost: 'low', speed: 'fast' },
  'ds/deepseek-v4-pro': { tier: 'cost', specialty: 'coding', cost: 'low', speed: 'fast' },
  'minimax/MiniMax-M2.7-highspeed': { tier: 'cost', specialty: 'speed', cost: 'low', speed: 'fast' },

  // Alternative models
  'glm/glm-5.1': { tier: 'alternative', specialty: 'chinese', cost: 'low', speed: 'slow' },

  // OpenCode Go models
  'opencode-go/glm-5.1': { tier: 'balanced', specialty: 'coding', cost: 'medium', speed: 'medium' },
  'opencode-go/kimi-k2.6': { tier: 'balanced', specialty: 'coding', cost: 'medium', speed: 'medium' },
  'opencode-go/mimo-v2.5-pro': { tier: 'balanced', specialty: 'coding', cost: 'medium', speed: 'medium' },
  'opencode-go/minimax-m2.7': { tier: 'cost', specialty: 'speed', cost: 'low', speed: 'fast' },
  'opencode-go/qwen3.6-plus': { tier: 'balanced', specialty: 'reasoning', cost: 'medium', speed: 'medium' },
  'opencode-go/deepseek-v4-pro': { tier: 'cost', specialty: 'coding', cost: 'low', speed: 'fast' },
  'opencode-go/deepseek-v4-flash': { tier: 'cost', specialty: 'speed', cost: 'low', speed: 'fast' },

  // Xiaomi models
  'mimo/mimo-v2.5-pro': { tier: 'balanced', specialty: 'coding', cost: 'medium', speed: 'medium' },
  'mimo/mimo-v2.5': { tier: 'balanced', specialty: 'coding', cost: 'medium', speed: 'medium' },
} as const;

export const ALL_MODELS = Object.keys(MODEL_CONFIGS);

// ============================================================================
// SHARED EVALUATION HELPERS
// ============================================================================
// AgentEvaluationFramework.evaluate() and the standalone runEvaluation() below
// both loop over test cases building up EvaluationResult[]/summaries the same
// way — these helpers keep the two paths from silently diverging.

/** Mean of a number array; 0 for an empty array (matches the `xs.length > 0 ? … : 0` guard used throughout this file). */
function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((sum, x) => sum + x, 0) / xs.length : 0;
}

/** Zeroed quality-metric fields shared by base metrics and failed-test-case results. */
function zeroQualityMetrics(): Pick<EvaluationMetrics, 'qualityScore' | 'accuracy' | 'completeness' | 'correctness' | 'agentSpecific'> {
  return { qualityScore: 0, accuracy: 0, completeness: 0, correctness: 0, agentSpecific: {} };
}

/** Build an EvaluationResult for a test case that threw before producing output. */
function buildErrorResult(
  testCaseId: string,
  agent: AgentType,
  model: string,
  duration: number,
  latency: number,
  error: unknown,
): EvaluationResult {
  return {
    testCaseId,
    agent,
    model,
    success: false,
    duration,
    cost: 0,
    output: null,
    error: error instanceof Error ? error.message : String(error),
    metrics: {
      ...zeroQualityMetrics(),
      latency,
      tokenUsage: 0,
      cost: 0,
    },
  };
}

// ============================================================================
// EVALUATION FRAMEWORK CLASS
// ============================================================================

export class AgentEvaluationFramework {
  private testCases: Map<AgentType, TestCase[]> = new Map();
  private evaluators: Map<AgentType, AgentEvaluator> = new Map();

  constructor() {
    this.initializeEvaluators();
  }

  private initializeEvaluators() {
    this.evaluators.set('decomposer', new DecomposerEvaluator());
    this.evaluators.set('planner', new PlannerEvaluator());
    this.evaluators.set('reviewer', new ReviewerEvaluator());
    this.evaluators.set('orchestrator', new OrchestratorEvaluator());
  }

  /**
   * Load test cases for a specific agent
   */
  loadTestCases(agent: AgentType, cases: TestCase[]): void {
    this.testCases.set(agent, cases);
  }

  /**
   * Load test cases from a file
   */
  async loadTestCasesFromFile(agent: AgentType, filePath: string): Promise<void> {
    const fs = await import('node:fs');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    this.testCases.set(agent, data.testCases);
  }

  /**
   * Run evaluation for a specific agent and model
   */
  async evaluate(config: AgentEvaluationConfig): Promise<AgentBenchmark> {
    const evaluator = this.evaluators.get(config.agent);
    if (!evaluator) {
      throw new Error(`No evaluator found for agent: ${config.agent}`);
    }

    const results: EvaluationResult[] = [];
    let totalCost = 0;

    for (const testCase of config.testCases) {
      const startTime = Date.now();

      try {
        const result = await evaluator.evaluate(testCase, config.model);
        const duration = Date.now() - startTime;

        const evaluationResult: EvaluationResult = {
          testCaseId: testCase.id,
          agent: config.agent,
          model: config.model,
          success: result.success,
          duration,
          cost: result.cost,
          output: result.output,
          error: result.error,
          metrics: this.calculateMetrics(testCase, result, duration)
        };

        results.push(evaluationResult);
        totalCost += result.cost;
      } catch (error) {
        const duration = Date.now() - startTime;
        results.push(buildErrorResult(testCase.id, config.agent, config.model, duration, duration, error));
      }
    }

    return {
      agent: config.agent,
      model: config.model,
      results,
      summary: this.generateSummary(results, totalCost)
    };
  }

  /**
   * Run evaluation for all models for a specific agent
   */
  async evaluateAgentAcrossModels(agent: AgentType): Promise<Record<string, AgentBenchmark>> {
    const testCases = this.testCases.get(agent);
    if (!testCases || testCases.length === 0) {
      throw new Error(`No test cases loaded for agent: ${agent}`);
    }

    const results: Record<string, AgentBenchmark> = {};

    for (const model of ALL_MODELS) {
      console.log(`Evaluating ${agent} with ${model}...`);
      const benchmark = await this.evaluate({
        agent,
        model,
        testCases
      });
      results[model] = benchmark;
    }

    return results;
  }

  /**
   * Run complete evaluation across all agents and models
   */
  async evaluateAll(): Promise<ComparativeMatrix> {
    const agents: AgentType[] = ['decomposer', 'planner', 'reviewer', 'orchestrator'];
    const allResults: Record<AgentType, Record<string, BenchmarkSummary>> =
      {} as Record<AgentType, Record<string, BenchmarkSummary>>;

    for (const agent of agents) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Evaluating ${agent.toUpperCase()}`);
      console.log('='.repeat(60));

      const benchmarks = await this.evaluateAgentAcrossModels(agent);
      allResults[agent] = {};

      for (const [model, benchmark] of Object.entries(benchmarks)) {
        allResults[agent][model] = benchmark.summary;
      }
    }

    return this.generateComparativeMatrix(allResults);
  }

  /**
   * Calculate metrics for a single evaluation result
   */
  private calculateMetrics(
    testCase: TestCase,
    result: EvaluationOutput,
    duration: number
  ): EvaluationMetrics {
    // Base metrics
    const metrics: EvaluationMetrics = {
      ...zeroQualityMetrics(),
      latency: duration,
      tokenUsage: result.tokenUsage || 0,
      cost: result.cost || 0,
    };

    // Calculate quality metrics based on agent type
    const evaluator = this.evaluators.get(testCase.agent);
    if (evaluator) {
      const agentMetrics = evaluator.calculateMetrics(testCase, result);
      metrics.qualityScore = agentMetrics.qualityScore;
      metrics.accuracy = agentMetrics.accuracy;
      metrics.completeness = agentMetrics.completeness;
      metrics.correctness = agentMetrics.correctness;
      metrics.agentSpecific = agentMetrics.agentSpecific;
    }

    return metrics;
  }

  /**
   * Generate summary statistics from evaluation results
   */
  private generateSummary(results: EvaluationResult[], totalCost: number): BenchmarkSummary {
    const successful = results.filter(r => r.success);
    const successRate = mean(results.map(r => (r.success ? 1 : 0)));
    const avgQuality = mean(results.map(r => r.metrics.qualityScore));
    const avgLatency = mean(results.map(r => r.metrics.latency));
    const avgCost = mean(results.map(r => r.metrics.cost));

    // Group by complexity / category — always zeroed below: EvaluationResult
    // carries no test-case metadata (complexity/category) to group by, only
    // testCaseId. The fields stay populated with zeros because they're part
    // of the exported BenchmarkSummary shape; a real breakdown would need
    // callers to pass the originating TestCase[] alongside results.
    const byComplexity: BenchmarkSummary['byComplexity'] = {
      simple: { successRate: 0, avgQuality: 0, count: 0 },
      medium: { successRate: 0, avgQuality: 0, count: 0 },
      complex: { successRate: 0, avgQuality: 0, count: 0 }
    };
    const byCategory: BenchmarkSummary['byCategory'] = {};

    // Identify strengths and weaknesses
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    if (successRate > 0.8) strengths.push('High success rate');
    if (successRate < 0.6) weaknesses.push('Low success rate');
    if (avgQuality > 0.7) strengths.push('High quality output');
    if (avgQuality < 0.5) weaknesses.push('Low quality output');
    if (avgLatency < 5000) strengths.push('Fast response time');
    if (avgLatency > 15000) weaknesses.push('Slow response time');

    return {
      totalTests: results.length,
      successfulTests: successful.length,
      successRate,
      avgQualityScore: avgQuality,
      avgLatency,
      avgCost,
      totalCost,
      byComplexity,
      byCategory,
      strengths,
      weaknesses
    };
  }

  /**
   * Generate comparative matrix across all agents and models
   */
  private generateComparativeMatrix(
    allResults: Record<AgentType, Record<string, BenchmarkSummary>>
  ): ComparativeMatrix {
    const bestModelByAgent: Record<AgentType, { model: string; summary: BenchmarkSummary }> =
      {} as Record<AgentType, { model: string; summary: BenchmarkSummary }>;

    // Find best model for each agent
    for (const [agent, models] of Object.entries(allResults)) {
      let bestModel = '';
      let bestScore = -1;
      let bestSummary: BenchmarkSummary | null = null;

      for (const [model, summary] of Object.entries(models)) {
        const score = summary.avgQualityScore * 0.6 + summary.successRate * 0.4;
        if (score > bestScore) {
          bestScore = score;
          bestModel = model;
          bestSummary = summary;
        }
      }

      if (bestSummary) {
        bestModelByAgent[agent as AgentType] = { model: bestModel, summary: bestSummary };
      }
    }

    // Find best model for each metric — not computed yet (kept empty; field is
    // part of the exported ComparativeMatrix shape for future per-metric ranking).
    const bestModelByMetric: Record<string, { agent: AgentType; model: string; value: number }> = {};

    // Generate recommendations
    const recommendations: string[] = [];

    for (const [agent, best] of Object.entries(bestModelByAgent)) {
      recommendations.push(`${agent}: Best performance with ${best.model} (${(best.summary.avgQualityScore * 100).toFixed(1)}% quality, ${(best.summary.successRate * 100).toFixed(1)}% success)`);
    }

    return {
      agents: allResults,
      bestModelByAgent,
      bestModelByMetric,
      recommendations
    };
  }
}

// ============================================================================
// AGENT EVALUATOR INTERFACES
// ============================================================================

export interface EvaluationOutput {
  success: boolean;
  output: any;
  cost: number;
  tokenUsage?: number;
  error?: string;
}

export interface AgentEvaluator {
  evaluate(testCase: TestCase, model: string): Promise<EvaluationOutput>;
  calculateMetrics(testCase: TestCase, result: EvaluationOutput): {
    qualityScore: number;
    accuracy: number;
    completeness: number;
    correctness: number;
    agentSpecific: Record<string, number>;
  };
}

// ============================================================================
// EVALUATION ORCHESTRATION
// ============================================================================

/**
 * Run evaluation for a single agent-model configuration
 */
export async function runEvaluation(
  config: AgentEvaluationConfig,
  evaluator: AgentEvaluator,
): Promise<EvaluationSummary> {
  const results: EvaluationResult[] = [];
  const startTime = Date.now();

  for (const testCase of config.testCases) {
    const testStartTime = Date.now();

    try {
      // Add timeout to evaluation
      const timeoutMs = config.timeout || 60000;
      const output = await Promise.race([
        evaluator.evaluate(testCase, config.model),
        new Promise<EvaluationOutput>((_, reject) =>
          setTimeout(() => reject(new Error(`Evaluation timeout after ${timeoutMs}ms`)), timeoutMs)
        )
      ]);
      const duration = Date.now() - testStartTime;

      const partial = evaluator.calculateMetrics(testCase, output);
      const metrics: EvaluationMetrics = {
        qualityScore: partial.qualityScore,
        accuracy: partial.accuracy,
        completeness: partial.completeness,
        correctness: partial.correctness,
        latency: duration,
        tokenUsage: output.tokenUsage ?? 0,
        cost: output.cost,
        agentSpecific: partial.agentSpecific,
      };

      const result: EvaluationResult = {
        testCaseId: testCase.id,
        agent: config.agent,
        model: config.model,
        success: output.success,
        duration,
        cost: output.cost,
        output: output.output,
        error: output.error,
        metrics,
      };

      results.push(result);
    } catch (error) {
      const duration = Date.now() - testStartTime;
      // NB: latency is 0 here (not `duration`) — pre-existing behavior for the
      // timeout/throw path, kept as-is via the explicit `latency` argument.
      results.push(buildErrorResult(testCase.id, config.agent, config.model, duration, 0, error));
    }
  }

  const totalDuration = Date.now() - startTime;

  // Calculate summary statistics
  const successRate = mean(results.map(r => (r.success ? 1 : 0)));
  const averageQualityScore = mean(results.map(r => r.metrics.qualityScore));
  const averageAccuracy = mean(results.map(r => r.metrics.accuracy));
  const averageCost = mean(results.map(r => r.cost));
  const averageLatency = mean(results.map(r => r.duration));
  const totalCost = results.reduce((sum, r) => sum + r.cost, 0);

  return {
    agent: config.agent,
    model: config.model,
    results,
    successRate,
    averageQualityScore,
    averageAccuracy,
    averageCost,
    averageLatency,
    totalCost,
    totalDuration,
  };
}