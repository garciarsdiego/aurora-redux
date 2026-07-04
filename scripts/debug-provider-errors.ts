#!/usr/bin/env tsx
/**
 * Debug Provider Errors
 *
 * Tests problematic providers with different configurations to identify root causes
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function testWithConfig(model: string, config: any): Promise<any> {
  try {
    const response = await fetch(`${OMNIROUTE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model,
        ...config
      })
    });

    const status = response.status;
    const contentType = response.headers.get('content-type');

    let body;
    if (contentType?.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return {
      success: response.ok,
      status,
      contentType,
      body: body
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message
    };
  }
}

async function debugProvider(providerName: string, model: string) {
  console.log(`\n🔍 Debugging ${providerName}: ${model}`);
  console.log('='.repeat(60));

  // Test 1: Standard config
  console.log('\n📋 Test 1: Standard config (stream=true)');
  const test1 = await testWithConfig(model, {
    messages: [{ role: 'user', content: 'Say "test"' }],
    max_tokens: 5,
    stream: true
  });
  console.log(`   Result: ${test1.success ? '✅' : '❌'} Status: ${test1.status}`);
  if (!test1.success && test1.body) {
    console.log(`   Error: ${JSON.stringify(test1.body).substring(0, 200)}`);
  } else if (!test1.success) {
    console.log(`   Error: ${test1.error || 'Unknown error'}`);
  }

  // Test 2: Stream=false
  console.log('\n📋 Test 2: Stream=false');
  const test2 = await testWithConfig(model, {
    messages: [{ role: 'user', content: 'Say "test"' }],
    max_tokens: 5,
    stream: false
  });
  console.log(`   Result: ${test2.success ? '✅' : '❌'} Status: ${test2.status}`);
  if (!test2.success && test2.body) {
    console.log(`   Error: ${JSON.stringify(test2.body).substring(0, 200)}`);
  } else if (!test2.success) {
    console.log(`   Error: ${test2.error || 'Unknown error'}`);
  }

  // Test 3: No stream parameter
  console.log('\n📋 Test 3: No stream parameter');
  const test3 = await testWithConfig(model, {
    messages: [{ role: 'user', content: 'Say "test"' }],
    max_tokens: 5
  });
  console.log(`   Result: ${test3.success ? '✅' : '❌'} Status: ${test3.status}`);
  if (!test3.success && test3.body) {
    console.log(`   Error: ${JSON.stringify(test3.body).substring(0, 200)}`);
  } else if (!test3.success) {
    console.log(`   Error: ${test3.error || 'Unknown error'}`);
  }

  // Test 4: With stream_options (for DeepSeek)
  console.log('\n📋 Test 4: With stream_options');
  const test4 = await testWithConfig(model, {
    messages: [{ role: 'user', content: 'Say "test"' }],
    max_tokens: 5,
    stream: true,
    stream_options: { include_usage: true }
  });
  console.log(`   Result: ${test4.success ? '✅' : '❌'} Status: ${test4.status}`);
  if (!test4.success && test4.body) {
    console.log(`   Error: ${JSON.stringify(test4.body).substring(0, 200)}`);
  } else if (!test4.success) {
    console.log(`   Error: ${test4.error || 'Unknown error'}`);
  }

  // Test 5: Minimal config
  console.log('\n📋 Test 5: Minimal config');
  const test5 = await testWithConfig(model, {
    messages: [{ role: 'user', content: 'Say "test"' }]
  });
  console.log(`   Result: ${test5.success ? '✅' : '❌'} Status: ${test5.status}`);
  if (!test5.success && test5.body) {
    console.log(`   Error: ${JSON.stringify(test5.body).substring(0, 200)}`);
  } else if (!test5.success) {
    console.log(`   Error: ${test5.error || 'Unknown error'}`);
  }

  return {
    provider: providerName,
    model,
    tests: {
      standardStream: test1,
      noStream: test2,
      noStreamParam: test3,
      withStreamOptions: test4,
      minimal: test5
    }
  };
}

async function main() {
  console.log('🔍 Debugging Provider Errors');
  console.log('='.repeat(60));

  const problematicProviders = [
    { name: 'DeepSeek', model: 'ds/deepseek-v4-pro' },
    { name: 'Minimax', model: 'minimax/MiniMax-M2.7-highspeed' },
    { name: 'OpenCode Go', model: 'opencode-go/glm-5.1' },
    { name: 'Xiaomi', model: 'mimo/mimo-v2.5-pro' }
  ];

  const results = [];

  for (const provider of problematicProviders) {
    const result = await debugProvider(provider.name, provider.model);
    results.push(result);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between providers
  }

  // Save results
  const fs = await import('node:fs');
  fs.writeFileSync(
    'data/provider-error-debug.json',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      results
    }, null, 2)
  );

  console.log('\n' + '='.repeat(60));
  console.log('✅ Debug complete. Results saved to data/provider-error-debug.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});