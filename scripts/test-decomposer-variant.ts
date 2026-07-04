#!/usr/bin/env tsx
/**
 * Test Decomposer Prompt Variant
 *
 * Tests a specific prompt variant by temporarily modifying the decomposer
 * and running evals to measure improvement.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { decompose } from '../src/brain/decomposer.js';
import { validateDag } from '../src/brain/dag-validator.js';

const DECOMPOSER_PATH = 'src/brain/decomposer.ts';

async function testVariant(variantId: string) {
  console.log(`🧪 Testing Decomposer Variant: ${variantId}`);
  console.log('============================================\n');

  // Load the analysis result
  const analysis = JSON.parse(
    readFileSync('data/decomposer-multi-provider-analysis.json', 'utf-8')
  );

  const variant = analysis.consensus.promptVariants.find(
    (v: any) => v.id === variantId
  );

  if (!variant) {
    console.error(`❌ Variant ${variantId} not found`);
    process.exit(1);
  }

  console.log(`📋 Variant: ${variant.id}`);
  console.log(`Rationale: ${variant.rationale}`);
  console.log(`\nProposed Addition:\n"${variant.addition}"\n`);

  // Read current decomposer
  const currentDecomposer = readFileSync(DECOMPOSER_PATH, 'utf-8');

  // Find the system prompt section (simplified search)
  const systemPromptMatch = currentDecomposer.match(/const SYSTEM_PROMPT = [`']([\s\S]*?)[`'];/);
  if (!systemPromptMatch) {
    console.error('❌ Could not find SYSTEM_PROMPT in decomposer.ts');
    process.exit(1);
  }

  const currentPrompt = systemPromptMatch[1];
  console.log(`Current prompt length: ${currentPrompt.length} characters`);

  // Create modified prompt
  const modifiedPrompt = currentPrompt + '\n\n' + variant.addition;
  console.log(`Modified prompt length: ${modifiedPrompt.length} characters`);
  console.log(`Addition: +${variant.addition.length} characters\n`);

  // Backup original
  const backupPath = `${DECOMPOSER_PATH}.backup`;
  writeFileSync(backupPath, currentDecomposer);
  console.log(`✅ Backed up original to ${backupPath}`);

  // Apply variant
  const modifiedDecomposer = currentDecomposer.replace(
    /const SYSTEM_PROMPT = [`']([\s\S]*?)[`'];/,
    `const SYSTEM_PROMPT = \`${modifiedPrompt}\`;`
  );

  writeFileSync(DECOMPOSER_PATH, modifiedDecomposer);
  console.log(`✅ Applied variant to ${DECOMPOSER_PATH}`);

  let h7_improved = false;
  let avgScore = 0;
  let h7_falsifiable = 0;

  // Test with Tetris objective
  console.log('\n🎮 Testing with Tetris objective...');
  try {
    const result = await decompose('Tetris Web app', { workspace: 'internal' });
    const validation = validateDag(result);

    // Calculate metrics
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
    h7_falsifiable = (() => {
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

    avgScore = (h1_granularity + h2_fanout + h7_falsifiable + h10_cli) / 4;

    console.log('\n📊 Metrics with Variant:');
    console.log(`  Tasks: ${tasks.length}`);
    console.log(`  H1 Granularity: ${(h1_granularity * 100).toFixed(0)}%`);
    console.log(`  H2 Fan-out: ${(h2_fanout * 100).toFixed(0)}%`);
    console.log(`  H7 Falsifiable: ${(h7_falsifiable * 100).toFixed(0)}% ⭐ (TARGET METRIC)`);
    console.log(`  H10 CLI: ${(h10_cli * 100).toFixed(0)}%`);
    console.log(`\n🎯 Average Score: ${(avgScore * 100).toFixed(1)}%`);
    console.log(`${avgScore >= 0.7 ? '✅ PASSED' : '❌ FAILED'} (threshold: 70%)\n`);

    // Show improvement
    console.log('📈 Improvement Analysis:');
    console.log(`  H7 (Target): ${(h7_falsifiable * 100).toFixed(0)}% vs 0% baseline = +${(h7_falsifiable * 100).toFixed(0)}%`);
    console.log(`  Overall: ${(avgScore * 100).toFixed(1)}% vs 50% baseline = +${((avgScore - 0.5) * 100).toFixed(1)}%`);

    h7_improved = h7_falsifiable > 0;
    if (h7_improved) {
      console.log('\n✅ SUCCESS: Variant improved H7 metric!');
      console.log('Tasks with MUST/SHOULD:');
      tasks.forEach((task, i) => {
        if (task.acceptance_criteria &&
            (task.acceptance_criteria.includes('MUST') || task.acceptance_criteria.includes('SHOULD'))) {
          console.log(`  ${i + 1}. ${task.name}: "${task.acceptance_criteria.substring(0, 60)}..."`);
        }
      });
    } else {
      console.log('\n⚠️  WARNING: Variant did NOT improve H7 metric');
      console.log('Consider trying a different variant or adjusting the prompt addition.');
    }

  } catch (err) {
    console.error('❌ Error during testing:', err);
  }

  // Restore original
  writeFileSync(DECOMPOSER_PATH, currentDecomposer);
  console.log(`\n🔄 Restored original ${DECOMPOSER_PATH}`);
  console.log(`💡 Backup still available at ${backupPath}`);

  console.log('\n🚀 Next Steps:');
  if (h7_improved) {
    console.log('   1. Review the modified decomposer in the backup file');
    console.log('   2. Manually apply the variant to src/brain/decomposer.ts');
    console.log('   3. Run full regression test suite');
    console.log('   4. Deploy to production');
  } else {
    console.log('   1. Try a different variant:');
    console.log('      - h7-fix-direct-instruction');
    console.log('      - h7-fix-structured-template');
    console.log('   2. Or modify the prompt addition manually');
    console.log('   3. Re-test with: npx tsx scripts/test-decomposer-variant.ts <variant-id>');
  }
}

// Get variant ID from command line
const variantId = process.argv[2];
if (!variantId) {
  console.log('Usage: npx tsx scripts/test-decomposer-variant.ts <variant-id>');
  console.log('\nAvailable variants:');
  console.log('  - h7-fix-direct-instruction');
  console.log('  - h7-fix-fewshot-examples');
  console.log('  - h7-fix-structured-template');
  process.exit(1);
}

testVariant(variantId).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});