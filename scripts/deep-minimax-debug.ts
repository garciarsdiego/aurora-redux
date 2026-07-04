#!/usr/bin/env tsx
/**
 * Deep Debug MiniMax Provider
 *
 * Detailed investigation of MiniMax-specific issues
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function testWithHeaders(model: string, additionalHeaders: Record<string, string> = {}) {
  try {
    const response = await fetch(`${OMNIROUTE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        ...additionalHeaders
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Say "OK"' }],
        max_tokens: 5
      })
    });

    const status = response.status;
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let body;
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    return { status, headers, body, success: response.ok };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function checkModelAvailability(model: string) {
  console.log(`\n🔍 Checking availability: ${model}`);
  console.log('='.repeat(60));

  // Test 1: Check if model exists in model list
  console.log('\n📋 Test 1: Model in catalog');
  try {
    const modelsResponse = await fetch(`${OMNIROUTE_URL}/api/v1/models`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const modelsData = await modelsResponse.json();
    const modelExists = modelsData.data.some((m: any) => m.id === model);
    console.log(`   Model in catalog: ${modelExists ? '✅ Yes' : '❌ No'}`);

    if (modelExists) {
      const modelInfo = modelsData.data.find((m: any) => m.id === model);
      console.log(`   Capabilities: ${JSON.stringify(modelInfo.capabilities)}`);
      console.log(`   Context length: ${modelInfo.context_length}`);
    }
  } catch (error: any) {
    console.log(`   Error checking catalog: ${error.message}`);
  }

  // Test 2: Simple request with different headers
  console.log('\n📋 Test 2: Request with different headers');
  const headerVariants = [
    { name: 'Standard', headers: {} },
    { name: 'No stream', headers: { 'X-Stream': 'false' } },
    { name: 'JSON mode', headers: { 'Accept': 'application/json' } },
    { name: 'No streaming', headers: { 'X-Prefer-Streaming': 'false' } }
  ];

  for (const variant of headerVariants) {
    process.stdout.write(`   ${variant.name}... `);
    const result = await testWithHeaders(model, variant.headers);
    console.log(`${result.success ? '✅' : '❌'} Status: ${result.status}`);
    if (!result.success && result.body) {
      if (typeof result.body === 'object' && result.body.error) {
        console.log(`      Error: ${result.body.error.message}`);
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Test 3: Check provider-specific endpoints
  console.log('\n📋 Test 3: Provider health check');
  const provider = model.split('/')[0];
  try {
    const healthResponse = await fetch(`${OMNIROUTE_URL}/api/v1/providers/${provider}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    console.log(`   Provider endpoint status: ${healthResponse.status}`);
  } catch (error: any) {
    console.log(`   Provider endpoint error: ${error.message}`);
  }

  // Test 4: Try with very minimal request
  console.log('\n📋 Test 4: Minimal request (only model + messages)');
  try {
    const response = await fetch(`${OMNIROUTE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Hi' }]
      })
    });
    console.log(`   Minimal request: ${response.ok ? '✅' : '❌'} Status: ${response.status}`);
    if (!response.ok) {
      const errorBody = await response.json();
      console.log(`      Error: ${JSON.stringify(errorBody).substring(0, 200)}`);
    }
  } catch (error: any) {
    console.log(`   Minimal request error: ${error.message}`);
  }
}

async function main() {
  console.log('🔍 Deep Debug MiniMax Provider Issues\n');
  console.log('='.repeat(60));

  const minimaxModels = [
    'minimax/MiniMax-M2.7-highspeed',
    'opencode-go/minimax-m2.7'
  ];

  for (const model of minimaxModels) {
    await checkModelAvailability(model);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ Deep debug complete');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});