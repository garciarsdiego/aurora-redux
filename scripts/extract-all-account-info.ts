#!/usr/bin/env tsx
/**
 * Extract Account Information from Multiple Providers
 *
 * Makes test calls to different providers and extracts account information from headers
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

const PROVIDERS_TO_TEST = [
  { model: 'codex/gpt-5.5', name: 'OpenAI Codex' },
  { model: 'claude/claude-sonnet-4-6', name: 'Claude' },
  { model: 'gemini-cli/gemini-3.1-pro-preview', name: 'Gemini CLI' },
  { model: 'cursor/gpt-5.5', name: 'Cursor IDE' },
  { model: 'kimi-coding/kimi-k2.5-thinking', name: 'Kimi Coding' },
];

async function testProvider(provider: { model: string; name: string }) {
  console.log(`\n🔍 Testing ${provider.name} (${provider.model})...`);

  try {
    const response = await fetch(`${OMNIROUTE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant.'
          },
          {
            role: 'user',
            content: 'Say "test" and nothing else.'
          }
        ],
        max_tokens: 10
      })
    });

    // Extract account-related headers
    const accountHeaders: Record<string, string> = {};

    response.headers.forEach((value, key) => {
      if (key.toLowerCase().includes('account') ||
          key.toLowerCase().includes('plan') ||
          key.toLowerCase().includes('limit') ||
          key.toLowerCase().includes('credit') ||
          key.toLowerCase().includes('provider') ||
          key.toLowerCase().includes('omniroute') ||
          key.toLowerCase().includes('codex') ||
          key.toLowerCase().includes('claude') ||
          key.toLowerCase().includes('gemini') ||
          key.toLowerCase().includes('cursor') ||
          key.toLowerCase().includes('kimi')) {
        accountHeaders[key] = value;
      }
    });

    console.log(`   Status: ${response.status}`);
    if (Object.keys(accountHeaders).length > 0) {
      console.log('   📋 Account Information:');
      Object.entries(accountHeaders).forEach(([key, value]) => {
        console.log(`      ${key}: ${value}`);
      });
    } else {
      console.log('   ⚠️ No account information headers found');
    }

    return {
      provider: provider.name,
      model: provider.model,
      status: response.status,
      headers: accountHeaders
    };

  } catch (error) {
    console.error(`   ❌ Error: ${error}`);
    return {
      provider: provider.name,
      model: provider.model,
      status: 'error',
      headers: {},
      error: String(error)
    };
  }
}

async function main() {
  console.log('🔍 Extracting Account Information from Multiple Providers');
  console.log('='.repeat(60));

  const results = [];

  for (const provider of PROVIDERS_TO_TEST) {
    const result = await testProvider(provider);
    results.push(result);
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));

  results.forEach(result => {
    console.log(`\n${result.provider}:`);
    console.log(`   Status: ${result.status}`);
    if (Object.keys(result.headers).length > 0) {
      console.log('   Account Details Found: ✓');
    } else {
      console.log('   Account Details Found: ✗');
    }
  });

  // Save results to file
  const fs = await import('node:fs');
  fs.writeFileSync(
    'data/account-information-summary.json',
    JSON.stringify(results, null, 2)
  );

  console.log('\n✅ Results saved to data/account-information-summary.json');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});