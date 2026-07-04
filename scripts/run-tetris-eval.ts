#!/usr/bin/env tsx
import { initDb } from '../src/db/client.js';
import { runEvalSuite } from '../src/v2/evals/harness.js';
import { decompose } from '../src/brain/decomposer.js';
import { validateDag } from '../src/brain/dag-validator.js';

const db = initDb('data/omniforge.db');

async function runTetrisEval() {
  console.log('🎮 Running Tetris Decomposer Eval');
  console.log('====================================\n');

  console.log('Starting eval suite...');
  const report = await runEvalSuite(db, {
    workspace: 'internal',
    suiteName: 'tetris-decomposer-test',
    tags: ['tetris-only'],
    threshold: 0.7,
    runner: async (testCase) => {
      try {
        console.log('Test case:', testCase.id);
        console.log('Input:', testCase.input);
        console.log('Expected:', testCase.expected);

        const input = testCase.input as { objective: string };
        console.log(`\n📋 Objective: ${input.objective}`);

        // Executar decomposer
        const result = await decompose(input.objective, {
          workspace: testCase.workspace,
        });

        // Validar DAG
        const validation = validateDag(result);
        console.log(`✅ DAG valid: ${validation.ok}`);
        console.log(`📊 Tasks: ${result.tasks.length}`);

        return {
          success: true,
          dag: result,
          validation,
          task_count: result.tasks.length,
        };
      } catch (err) {
        console.error('Runner error:', err);
        throw err;
      }
    },
    judge: async ({ output, expected, testCase }) => {
      // Métricas do decomposer
      const tasks = output.dag.tasks;
      const scores = [];

      // H1: Granularidade (3-7 tasks ideal)
      const granularityScore = tasks.length >= 3 && tasks.length <= 7 ? 1 : 0.5;
      scores.push(granularityScore);
      console.log(`  H1 Granularity: ${granularityScore.toFixed(2)} (tasks: ${tasks.length})`);

      // H2: Fan-out (max 4 dependencies por task)
      let maxFanOut = 0;
      for (const task of tasks) {
        const fanOut = tasks.filter(t => t.depends_on?.includes(task.id)).length;
        maxFanOut = Math.max(maxFanOut, fanOut);
      }
      const fanOutScore = maxFanOut <= 4 ? 1 : 0.5;
      scores.push(fanOutScore);
      console.log(`  H2 Fan-out: ${fanOutScore.toFixed(2)} (max: ${maxFanOut})`);

      // H7: Falsifiable criteria
      let falsifiableCount = 0;
      for (const task of tasks) {
        if (task.acceptance_criteria) {
          const hasMust = task.acceptance_criteria.includes('MUST');
          const hasShould = task.acceptance_criteria.includes('SHOULD');
          if (hasMust || hasShould) falsifiableCount++;
        }
      }
      const falsifiableScore = falsifiableCount / tasks.length;
      scores.push(falsifiableScore);
      console.log(`  H7 Falsifiable: ${falsifiableScore.toFixed(2)} (${falsifiableCount}/${tasks.length} tasks)`);

      // H10: Model-CLI compatibility
      let cliSpawnCount = 0;
      for (const task of tasks) {
        if (task.kind === 'cli_spawn') cliSpawnCount++;
      }
      const cliScore = cliSpawnCount > 0 ? 1 : 0;
      scores.push(cliScore);
      console.log(`  H10 CLI compatibility: ${cliScore.toFixed(2)} (${cliSpawnCount} cli_spawn tasks)`);

      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const passed = avgScore >= 0.7;

      console.log(`\n📈 Average Score: ${avgScore.toFixed(2)}`);
      console.log(`${passed ? '✅ PASSED' : '❌ FAILED'} (threshold: 0.70)\n`);

      return {
        score: avgScore,
        passed,
        feedback: passed ? 'Decomposer metrics within acceptable range' : 'Decomposer metrics below threshold',
      };
    },
  });

  console.log('Eval suite completed');
  console.log('Report:', report);

  console.log('\n📊 Final Report');
  console.log('================');
  console.log(`Run ID: ${report.id}`);
  console.log(`Score: ${report.score.toFixed(4)}`);
  console.log(`Cases: ${report.case_count}`);
  console.log(`Status: ${report.status}`);

  // Carregar resultados detalhados
  const results = db.prepare('SELECT * FROM eval_results WHERE run_id = ?').all(report.id);
  console.log(`\nDetailed Results:`);
  for (const result of results) {
    console.log(`  Case ${result.case_id}: ${result.status} (score: ${result.score.toFixed(4)})`);
    if (result.feedback) console.log(`    Feedback: ${result.feedback}`);
    if (result.error) console.log(`    Error: ${result.error}`);
  }

  db.close();
}

runTetrisEval().catch((err) => {
  console.error('Fatal error:', err);
  db.close();
  process.exit(1);
});