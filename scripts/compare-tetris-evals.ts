#!/usr/bin/env tsx
import { initDb } from '../src/db/client.js';
import { runEvalSuite } from '../src/v2/evals/harness.js';
import { decompose } from '../src/brain/decomposer.js';
import { validateDag } from '../src/brain/dag-validator.js';

const db = initDb('data/omniforge.db');

async function runComparison() {
  console.log('🎮 Tetris Objective Comparison Test');
  console.log('====================================\n');

  const cases = [
    { id: 'gc_tetris_webapp_real', name: 'Original: "Tetris Web app"' },
    { id: 'gc_tetris_improved_template', name: 'Improved: Structured Template' }
  ];

  const results = [];

  for (const testCase of cases) {
    console.log(`\n📋 Testing: ${testCase.name}`);
    console.log('─'.repeat(50));

    try {
      const caseData = db.prepare('SELECT * FROM eval_cases WHERE id = ?').get(testCase.id);
      if (!caseData) {
        console.log(`❌ Case not found: ${testCase.id}`);
        continue;
      }

      const input = JSON.parse(caseData.input_json);
      console.log(`Objective preview: ${input.objective.substring(0, 100)}...`);

      // Executar decomposer
      const result = await decompose(input.objective, {
        workspace: caseData.workspace,
      });

      // Validar DAG
      const validation = validateDag(result);

      // Calcular métricas
      const tasks = result.tasks;
      const h1_granularity = tasks.length >= 3 && tasks.length <= 7 ? 1 : 0.5;
      const h2_fanout = (() => {
        let maxFanOut = 0;
        for (const task of tasks) {
          const fanOut = tasks.filter(t => t.depends_on?.includes(task.id)).length;
          maxFanOut = Math.max(maxFanOut, fanOut);
        }
        return maxFanOut <= 4 ? 1 : 0.5;
      })();
      const h7_falsifiable = (() => {
        let falsifiableCount = 0;
        for (const task of tasks) {
          if (task.acceptance_criteria) {
            const hasMust = task.acceptance_criteria.includes('MUST');
            const hasShould = task.acceptance_criteria.includes('SHOULD');
            if (hasMust || hasShould) falsifiableCount++;
          }
        }
        return falsifiableCount / tasks.length;
      })();
      const h10_cli = (() => {
        let cliSpawnCount = 0;
        for (const task of tasks) {
          if (task.kind === 'cli_spawn') cliSpawnCount++;
        }
        return cliSpawnCount > 0 ? 1 : 0;
      })();

      const metrics = {
        task_count: tasks.length,
        h1_granularity,
        h2_fanout,
        h7_falsifiable,
        h10_cli
      };

      const avgScore = (h1_granularity + h2_fanout + h7_falsifiable + h10_cli) / 4;

      console.log(`\n📊 Metrics:`);
      console.log(`  Tasks: ${metrics.task_count}`);
      console.log(`  H1 Granularity: ${(metrics.h1_granularity * 100).toFixed(0)}%`);
      console.log(`  H2 Fan-out: ${(metrics.h2_fanout * 100).toFixed(0)}%`);
      console.log(`  H7 Falsifiable: ${(metrics.h7_falsifiable * 100).toFixed(0)}%`);
      console.log(`  H10 CLI: ${(metrics.h10_cli * 100).toFixed(0)}%`);
      console.log(`\n🎯 Average Score: ${(avgScore * 100).toFixed(1)}%`);
      console.log(`${avgScore >= 0.7 ? '✅ PASSED' : '❌ FAILED'} (threshold: 70%)\n`);

      results.push({
        case: testCase.name,
        ...metrics,
        avg_score: avgScore,
        passed: avgScore >= 0.7
      });

    } catch (err) {
      console.error(`❌ Error testing ${testCase.id}:`, err.message);
      results.push({
        case: testCase.name,
        error: err.message,
        passed: false
      });
    }
  }

  // Comparação final
  console.log('\n' + '='.repeat(50));
  console.log('📈 COMPARISON SUMMARY');
  console.log('='.repeat(50));

  if (results.length === 2 && !results[0].error && !results[1].error) {
    const improvement = results[1].avg_score - results[0].avg_score;
    const improvementPct = (improvement * 100).toFixed(1);

    console.log(`\nOriginal:  ${(results[0].avg_score * 100).toFixed(1)}% (${results[0].passed ? '✅' : '❌'})`);
    console.log(`Improved:  ${(results[1].avg_score * 100).toFixed(1)}% (${results[1].passed ? '✅' : '❌'})`);
    console.log(`\n🚀 Improvement: +${improvementPct}%`);

    if (improvement > 0) {
      console.log('\n✅ The structured template IMPROVED decomposer performance!');
    } else {
      console.log('\n⚠️  The structured template did not improve performance.');
    }
  }

  db.close();
}

runComparison().catch((err) => {
  console.error('Fatal error:', err);
  db.close();
  process.exit(1);
});