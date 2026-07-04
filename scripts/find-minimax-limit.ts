#!/usr/bin/env tsx
/**
 * Find MiniMax max_tokens Limit
 *
 * Binary search to find the exact threshold where MiniMax starts working
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function testMaxTokens(model: string, maxTokens: number): Promise<boolean> {
  try {
    const response = await fetch(`${OMNIROUTE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "OK"' }],
        max_tokens: maxTokens
      })
    });

    return response.ok;
  } catch {
    return false;
  }
}

async function binarySearchThreshold(model: string, min: number, max: number): Promise<number> {
  console.log(`🔍 Binary search between ${min} and ${max}`);

  while (min < max) {
    const mid = Math.floor((min + max) / 2);
    const works = await testMaxTokens(model, mid);

    console.log(`   Testing max_tokens=${mid}: ${works ? '✅' : '❌'}`);

    if (works) {
      max = mid;
    } else {
      min = mid + 1;
    }
  }

  return min;
}

async function main() {
  console.log('🔍 Finding MiniMax max_tokens Threshold\n');
  console.log('='.repeat(60));

  const model = 'minimax/MiniMax-M2.7-highspeed';

  // First, test specific values to narrow down
  console.log('\n📋 Testing specific values:');
  const testValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 75, 100];

  for (const value of testValues) {
    const works = await testMaxTokens(model, value);
    console.log(`   max_tokens=${value}: ${works ? '✅' : '❌'}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Binary search for exact threshold
  console.log('\n📋 Binary search for exact threshold:');
  const threshold = await binarySearchThreshold(model, 1, 100);

  console.log(`\n🎯 THRESHOLD FOUND: ${threshold}`);
  console.log(`   max_tokens < ${threshold}: ❌ FAILS`);
  console.log(`   max_tokens >= ${threshold}: ✅ WORKS`);

  // Test both minimax models
  console.log('\n📋 Testing both models with threshold:');
  const models = ['minimax/MiniMax-M2.7-highspeed', 'opencode-go/minimax-m2.7'];

  for (const testModel of models) {
    const belowThreshold = await testMaxTokens(testModel, threshold - 1);
    const atThreshold = await testMaxTokens(testModel, threshold);
    const aboveThreshold = await testMaxTokens(testModel, threshold + 10);

    console.log(`\n   ${testModel}:`);
    console.log(`      max_tokens=${threshold - 1}: ${belowThreshold ? '✅' : '❌'}`);
    console.log(`      max_tokens=${threshold}: ${atThreshold ? '✅' : '❌'}`);
    console.log(`      max_tokens=${threshold + 10}: ${aboveThreshold ? '✅' : '❌'}`);
  }

  // Save results
  const fs = await import('node:fs');
  fs.writeFileSync(
    'data/minimax-threshold-analysis.json',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      threshold,
      models: models,
      recommendation: `Use max_tokens >= ${threshold} for MiniMax models`
    }, null, 2)
  );

  console.log('\n📄 Results saved to data/minimax-threshold-analysis.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});