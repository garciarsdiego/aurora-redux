/**
 * Test Script - Orchestrator Evaluation
 *
 * Tests the orchestrator evaluator (no LLM calls - should be fast)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  type TestCase,
  type AgentEvaluationConfig,
  runEvaluation,
} from '../src/v2/evals/agent-evaluation/framework.js';
import { OrchestratorEvaluator } from '../src/v2/evals/agent-evaluation/orchestrator-evaluator.js';

async function main() {
  console.log('Testing orchestrator evaluation (no LLM calls)...');

  // Load a single test case
  const testCaseFile = join(__dirname, '../data/golden-test-cases/orchestrator-test-cases.json');
  const content = readFileSync(testCaseFile, 'utf-8');
  const data = JSON.parse(content);

  // Use just the first test case
  const singleTestCase = [data.testCases[0]];

  console.log('Test case:', singleTestCase[0].name);
  console.log('Description:', singleTestCase[0].description);

  // Create evaluator
  const evaluator = new OrchestratorEvaluator();

  // Run evaluation
  const config: AgentEvaluationConfig = {
    agent: 'orchestrator',
    model: 'any', // Orchestrator doesn't use LLM
    testCases: singleTestCase,
    timeout: 10000, // 10 second timeout should be plenty
    maxRetries: 0,
  };

  try {
    console.log('\nRunning evaluation...');
    const summary = await runEvaluation(config, evaluator);

    console.log('\n✓ Evaluation complete!');
    console.log('Success rate:', (summary.successRate * 100).toFixed(1) + '%');
    console.log('Quality score:', (summary.averageQualityScore * 100).toFixed(1) + '%');
    console.log('Duration:', (summary.totalDuration / 1000).toFixed(1) + 's');
    console.log('Cost:', '$' + summary.totalCost.toFixed(4));

    if (summary.results.length > 0) {
      const result = summary.results[0];
      console.log('\nResult details:');
      console.log('  Success:', result.success);
      console.log('  Error:', result.error || 'None');
      if (result.output) {
        console.log('  Output keys:', Object.keys(result.output));
        console.log('  Metadata:', result.output.metadata);
      }
    }

  } catch (error: any) {
    console.error('\n✗ Evaluation failed:', error.message);
    console.error('Stack:', error.stack);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});