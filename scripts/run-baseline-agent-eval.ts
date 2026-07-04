/**
 * Baseline Agent Evaluation Runner
 *
 * Runs comprehensive baseline evaluation across all 4 critical agents
 * and 18 approved models to establish performance baselines.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  type TestCase,
  type AgentEvaluationConfig,
  type EvaluationResult,
  type EvaluationSummary,
  runEvaluation,
} from '../src/v2/evals/agent-evaluation/framework.js';
import {
  DecomposerEvaluator,
  PlannerEvaluator,
  ReviewerEvaluator,
  OrchestratorEvaluator,
} from '../src/v2/evals/agent-evaluation/index.js';
import type { AgentType } from '../src/v2/evals/agent-evaluation/framework.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Models to evaluate
  models: [
    // Premium
    'cc/claude-opus-4-6',
    'cx/gpt-5.5',
    // Balanced
    'cc/claude-sonnet-4-6',
    'kimi-coding/kimi-k2.6',
    'kimi-coding/kimi-k2.6-thinking',
    // Cost-optimized
    'gemini-cli/gemini-3.1-flash-lite-preview',
    'glm/glm-5.1',
    'minimax/MiniMax-M2.7-highspeed',
    'ds/deepseek-v4-pro',
    // Ollama Cloud
    'ollamacloud/deepseek-v4-pro',
    'ollamacloud/deepseek-v4-flash',
    'ollamacloud/kimi-k2.6',
    'ollamacloud/glm-5.1',
    'ollamacloud/minimax-m2.7',
    // OpenCode Go
    'opencode-go/glm-5.1',
    'opencode-go/kimi-k2.6',
    'opencode-go/mimo-v2.5-pro',
    'opencode-go/minimax-m2.7',
    // Alternative
    'mimo/mimo-v2.5-pro',
  ],

  // Agents to evaluate
  agents: ['decomposer', 'planner', 'reviewer', 'orchestrator'] as AgentType[],

  // Test case files
  testCaseFiles: {
    decomposer: join(__dirname, '../data/golden-test-cases/decomposer-test-cases.json'),
    planner: join(__dirname, '../data/golden-test-cases/planner-test-cases.json'),
    reviewer: join(__dirname, '../data/golden-test-cases/reviewer-test-cases.json'),
    orchestrator: join(__dirname, '../data/golden-test-cases/orchestrator-test-cases.json'),
  },

  // Output directory
  outputDir: join(__dirname, '../data/evaluation-results'),

  // Evaluation options
  timeout: 120000, // 2 minutes per evaluation
  maxRetries: 1,
};

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  Omniforge Agent Evaluation - Baseline Runner                ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log();

  // Create output directory
  mkdirSync(CONFIG.outputDir, { recursive: true });

  // Load test cases for all agents
  console.log('Loading test cases...');
  const testCasesByAgent = new Map<AgentType, TestCase[]>();

  for (const agent of CONFIG.agents) {
    const file = CONFIG.testCaseFiles[agent];
    const content = readFileSync(file, 'utf-8');
    const data = JSON.parse(content);
    testCasesByAgent.set(agent, data.testCases);
    console.log(`  ✓ ${agent}: ${data.testCases.length} test cases`);
  }
  console.log();

  // Create evaluators
  const evaluators = {
    decomposer: new DecomposerEvaluator(),
    planner: new PlannerEvaluator(),
    reviewer: new ReviewerEvaluator(),
    orchestrator: new OrchestratorEvaluator(),
  };

  // Run evaluations
  const allResults: EvaluationResult[] = [];
  const summaries: EvaluationSummary[] = [];

  console.log('Running evaluations...');
  console.log(`  Models: ${CONFIG.models.length}`);
  console.log(`  Agents: ${CONFIG.agents.length}`);
  console.log(`  Total combinations: ${CONFIG.models.length * CONFIG.agents.length}`);
  console.log();

  for (const agent of CONFIG.agents) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Evaluating ${agent.toUpperCase()}`);
    console.log('='.repeat(60));

    const testCases = testCasesByAgent.get(agent)!;
    const evaluator = evaluators[agent];

    for (const model of CONFIG.models) {
      console.log(`\n  Model: ${model}`);
      console.log(`  Test cases: ${testCases.length}`);

      const config: AgentEvaluationConfig = {
        agent,
        model,
        testCases,
        timeout: CONFIG.timeout,
        maxRetries: CONFIG.maxRetries,
      };

      try {
        const summary = await runEvaluation(config, evaluator);
        summaries.push(summary);
        allResults.push(...summary.results);

        console.log(`  ✓ Success rate: ${(summary.successRate * 100).toFixed(1)}%`);
        console.log(`  ✓ Avg quality: ${(summary.averageQualityScore * 100).toFixed(1)}%`);
        console.log(`  ✓ Total cost: $${summary.totalCost.toFixed(4)}`);
        console.log(`  ✓ Total time: ${(summary.totalDuration / 1000).toFixed(1)}s`);
      } catch (error: any) {
        console.error(`  ✗ Error: ${error.message}`);
      }
    }
  }

  // Generate overall summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('OVERALL SUMMARY');
  console.log('='.repeat(60));

  const totalEvaluations = allResults.length;
  const successfulEvaluations = allResults.filter(r => r.success).length;
  const overallSuccessRate = successfulEvaluations / totalEvaluations;

  const totalCost = allResults.reduce((sum, r) => sum + r.cost, 0);
  const totalDuration = allResults.reduce((sum, r) => sum + r.duration, 0);

  const avgQualityScore = allResults.reduce((sum, r) => sum + r.metrics.qualityScore, 0) / totalEvaluations;

  console.log(`  Total evaluations: ${totalEvaluations}`);
  console.log(`  Successful: ${successfulEvaluations} (${(overallSuccessRate * 100).toFixed(1)}%)`);
  console.log(`  Average quality score: ${(avgQualityScore * 100).toFixed(1)}%`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);
  console.log(`  Total time: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log();

  // Save results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsFile = join(CONFIG.outputDir, `baseline-${timestamp}.json`);
  const summaryFile = join(CONFIG.outputDir, `baseline-summary-${timestamp}.json`);

  writeFileSync(resultsFile, JSON.stringify(allResults, null, 2));
  writeFileSync(summaryFile, JSON.stringify(summaries, null, 2));

  console.log(`Results saved:`);
  console.log(`  ${resultsFile}`);
  console.log(`  ${summaryFile}`);
  console.log();

  // Generate performance matrix
  generatePerformanceMatrix(summaries, CONFIG.outputDir, timestamp);

  console.log('✓ Baseline evaluation complete!');
}

/**
 * Generate performance matrix for visualization
 */
function generatePerformanceMatrix(
  summaries: EvaluationSummary[],
  outputDir: string,
  timestamp: string,
) {
  console.log('Generating performance matrix...');

  const matrix: Record<string, Record<string, any>> = {};

  for (const summary of summaries) {
    if (!matrix[summary.agent]) {
      matrix[summary.agent] = {};
    }

    matrix[summary.agent][summary.model] = {
      successRate: summary.successRate,
      averageQualityScore: summary.averageQualityScore,
      averageAccuracy: summary.averageAccuracy,
      averageCost: summary.averageCost,
      averageLatency: summary.averageLatency,
      totalCost: summary.totalCost,
      totalDuration: summary.totalDuration,
    };
  }

  const matrixFile = join(outputDir, `performance-matrix-${timestamp}.json`);
  writeFileSync(matrixFile, JSON.stringify(matrix, null, 2));

  console.log(`  ✓ ${matrixFile}`);
}

// Run main
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});