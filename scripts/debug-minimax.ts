#!/usr/bin/env tsx
/**
 * Debug Minimax Models
 *
 * Specific investigation for Minimax models that are still failing
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function testMinimaxVariant(model: string, description: string, config: any): Promise<any> {
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
        max_tokens: 5,
        ...config
      })
    });

    const success = response.ok;
    const status = response.status;

    let body;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }

    return { success, status, body, description };
  } catch (error: any) {
    return { success: false, error: error.message, description };
  }
}

async function main() {
  console.log('🔍 Debugging Minimax Models\n');
  console.log('='.repeat(60));

  const minimaxModels = [
    'minimax/MiniMax-M2.7-highspeed',
    'opencode-go/minimax-m2.7'
  ];

  for (const model of minimaxModels) {
    console.log(`\n🔍 Testing: ${model}`);
    console.log('-'.repeat(40));

    const variants = [
      { config: {}, desc: 'No config (minimal)' },
      { config: { stream: false }, desc: 'Stream false' },
      { config: { stream: true }, desc: 'Stream true' },
      { config: { stream: true, stream_options: { include_usage: false } }, desc: 'Stream with include_usage false' },
      { config: { stream: true, stream_options: { include_usage: true } }, desc: 'Stream with include_usage true' },
      { config: { temperature: 0.7 }, desc: 'With temperature only' },
      { config: { temperature: 0.7, stream: false }, desc: 'Temperature + stream false' },
      { config: { max_tokens: 10, temperature: 0.5 }, desc: 'Max tokens + temperature' },
    ];

    for (const { config, desc } of variants) {
      process.stdout.write(`   ${desc}... `);
      const result = await testMinimaxVariant(model, desc, config);

      if (result.success) {
        console.log(`✅ Status: ${result.status}`);
      } else {
        console.log(`❌ Status: ${result.status}`);
        if (result.body && typeof result.body === 'object' && result.body.error) {
          console.log(`      Error: ${result.body.error.message}`);
        } else if (result.error) {
          console.log(`      Error: ${result.error}`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Minimax debug complete');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});