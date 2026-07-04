#!/usr/bin/env tsx
/**
 * Parameter-specific Debug for MiniMax
 *
 * Test which specific parameters cause the 502 error
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function testWithParams(model: string, params: Record<string, any>, description: string) {
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
        ...params
      })
    });

    const success = response.ok;
    const status = response.status;

    let error = '';
    if (!success) {
      try {
        const body = await response.json();
        error = body.error?.message || JSON.stringify(body).substring(0, 100);
      } catch {
        error = 'Unknown error';
      }
    }

    return { success, status, error, description };
  } catch (error: any) {
    return { success: false, status: 'ERROR', error: error.message, description };
  }
}

async function main() {
  console.log('🔍 Parameter-specific Debug for MiniMax\n');
  console.log('='.repeat(60));

  const model = 'minimax/MiniMax-M2.7-highspeed';

  const parameterTests = [
    { params: {}, desc: 'No extra parameters (baseline)' },
    { params: { max_tokens: 5 }, desc: 'max_tokens only' },
    { params: { temperature: 0.7 }, desc: 'temperature only' },
    { params: { top_p: 0.9 }, desc: 'top_p only' },
    { params: { stream: false }, desc: 'stream: false' },
    { params: { stream: true }, desc: 'stream: true' },
    { params: { max_tokens: 5, temperature: 0.7 }, desc: 'max_tokens + temperature' },
    { params: { max_tokens: 5, stream: false }, desc: 'max_tokens + stream: false' },
    { params: { temperature: 0.7, stream: false }, desc: 'temperature + stream: false' },
    { params: { max_tokens: 10, temperature: 0.5, top_p: 0.9 }, desc: 'All common params' },
    { params: { max_tokens: 100 }, desc: 'max_tokens: 100' },
    { params: { max_tokens: 1000 }, desc: 'max_tokens: 1000' },
    { params: { max_tokens: 5, temperature: 0.7, stream: true }, desc: 'All params with stream' },
  ];

  const results = [];

  for (const { params, desc } of parameterTests) {
    process.stdout.write(`${desc}... `);
    const result = await testWithParams(model, params, desc);

    if (result.success) {
      console.log(`✅ Status: ${result.status}`);
    } else {
      console.log(`❌ Status: ${result.status} - ${result.error}`);
    }

    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Analyze results
  console.log('\n' + '='.repeat(60));
  console.log('📊 ANALYSIS');
  console.log('='.repeat(60));

  const workingConfigs = results.filter(r => r.success);
  const failingConfigs = results.filter(r => !r.success);

  console.log(`\n✅ Working configurations (${workingConfigs.length}):`);
  workingConfigs.forEach(r => {
    console.log(`   - ${r.description}`);
  });

  console.log(`\n❌ Failing configurations (${failingConfigs.length}):`);
  failingConfigs.forEach(r => {
    console.log(`   - ${r.description} (${r.error})`);
  });

  // Find pattern
  console.log('\n🔍 PATTERN ANALYSIS:');
  const workingWithoutMaxTokens = workingConfigs.filter(r => !r.description.includes('max_tokens'));
  const workingWithMaxTokens = workingConfigs.filter(r => r.description.includes('max_tokens'));

  console.log(`   Working without max_tokens: ${workingWithoutMaxTokens.length}`);
  console.log(`   Working with max_tokens: ${workingWithMaxTokens.length}`);

  const workingWithoutStream = workingConfigs.filter(r => !r.description.includes('stream'));
  const workingWithStream = workingConfigs.filter(r => r.description.includes('stream'));

  console.log(`   Working without stream: ${workingWithoutStream.length}`);
  console.log(`   Working with stream: ${workingWithStream.length}`);

  // Save results
  const fs = await import('node:fs');
  fs.writeFileSync(
    'data/minimax-parameter-debug.json',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      model,
      results,
      analysis: {
        working: workingConfigs.length,
        failing: failingConfigs.length,
        pattern: {
          maxTokensIssue: workingWithMaxTokens.length === 0,
          streamIssue: workingWithStream.length === 0
        }
      }
    }, null, 2)
  );

  console.log('\n📄 Results saved to data/minimax-parameter-debug.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});