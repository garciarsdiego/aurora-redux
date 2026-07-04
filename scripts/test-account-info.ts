#!/usr/bin/env tsx
/**
 * Test Account Information through LLM Call
 *
 * Makes a real LLM call and tries to extract account information from response metadata
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function testLLMCall() {
  console.log('🔍 Testing LLM Call to extract account information...\n');

  try {
    const response = await fetch(`${OMNIROUTE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: 'codex/gpt-5.5',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant.'
          },
          {
            role: 'user',
            content: 'Say "Hello from account info test" and nothing else.'
          }
        ],
        max_tokens: 50
      })
    });

    console.log('📊 Response Status:', response.status);
    console.log('📋 Response Headers:');
    response.headers.forEach((value, key) => {
      console.log(`   ${key}: ${value}`);
    });

    const data = await response.json();
    console.log('\n📄 Response Body:');
    console.log(JSON.stringify(data, null, 2));

    if (data.usage) {
      console.log('\n📈 Usage Information:');
      console.log(JSON.stringify(data.usage, null, 2));
    }

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testLLMCall().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});