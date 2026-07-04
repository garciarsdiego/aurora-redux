#!/usr/bin/env tsx
/**
 * Test MiniMax Solution
 *
 * Test if max_tokens >= 50 consistently fixes the issue
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function testMinimaxModel(model: string, maxTokens: number, iteration: number): Promise<boolean> {
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

async function main() {
  console.log('🧪 Testing MiniMax Solution\n');
  console.log('='.repeat(60));

  const models = ['minimax/MiniMax-M2.7-highspeed', 'opencode-go/minimax-m2.7'];
  const testValues = [50, 75, 100];
  const iterations = 5;

  const results: any[] = [];

  for (const model of models) {
    console.log(`\n🔍 Testing: ${model}`);
    console.log('-'.repeat(40));

    for (const maxTokens of testValues) {
      console.log(`\n   max_tokens=${maxTokens} (${iterations} iterations):`);

      let successes = 0;
      for (let i = 0; i < iterations; i++) {
        const success = await testMinimaxModel(model, maxTokens, i);
        if (success) successes++;
        process.stdout.write(`      Iteration ${i+1}: ${success ? '✅' : '❌'} `);
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      const successRate = (successes / iterations) * 100;
      console.log(`\n      Success rate: ${successRate}% (${successes}/${iterations})`);

      results.push({
        model,
        maxTokens,
        successRate,
        successes,
        total: iterations
      });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));

  const stableConfigs = results.filter(r => r.successRate === 100);
  console.log(`\n✅ Stable configurations (100% success):`);
  stableConfigs.forEach(r => {
    console.log(`   ${r.model} with max_tokens=${r.maxTokens}`);
  });

  // Recommendation
  console.log('\n💡 RECOMMENDATION:');
  if (stableConfigs.length > 0) {
    const minStableTokens = Math.min(...stableConfigs.map(r => r.maxTokens));
    console.log(`   Use max_tokens >= ${minStableTokens} for MiniMax models`);
  } else {
    console.log('   MiniMax models are unstable - consider not using them');
  }

  // Save results
  const fs = await import('node:fs');
  fs.writeFileSync(
    'data/minimax-solution-test.json',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      results,
      recommendation: stableConfigs.length > 0 ? `max_tokens >= ${Math.min(...stableConfigs.map(r => r.maxTokens))}` : 'unstable'
    }, null, 2)
  );

  console.log('\n📄 Results saved to data/minimax-solution-test.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});