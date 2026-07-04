#!/usr/bin/env tsx
/**
 * Test All Models with Correct Configurations
 *
 * Tests all previously failing models with their specific required configurations
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

// Provider-specific configurations
const PROVIDER_CONFIGS: Record<string, any> = {
  'ds': { stream: true, stream_options: { include_usage: true } }, // DeepSeek
  'minimax': {}, // Minimax - no streaming
  'opencode-go': { stream: true, stream_options: { include_usage: true } }, // OpenCode Go
  'mimo': { stream: true, stream_options: { include_usage: true } }, // Xiaomi
  'ollamacloud': { stream: true, stream_options: { include_usage: true } }, // Ollama Cloud
  'default': { stream: true } // Default for others
};

function getConfigForModel(model: string): any {
  // Extract provider prefix
  const provider = model.split('/')[0];
  return PROVIDER_CONFIGS[provider] || PROVIDER_CONFIGS['default'];
}

async function testModel(model: string): Promise<{ success: boolean; latency?: number; error?: string; config?: any }> {
  const startTime = Date.now();
  const config = getConfigForModel(model);

  try {
    const response = await fetch(`${OMNIROUTE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant.'
          },
          {
            role: 'user',
            content: 'Say "OK" and nothing else.'
          }
        ],
        max_tokens: 5,
        ...config
      })
    });

    const latency = Date.now() - startTime;

    if (response.ok) {
      return { success: true, latency, config };
    } else {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 100)}`, config };
    }
  } catch (error: any) {
    return { success: false, error: error.message, config };
  }
}

async function main() {
  console.log('🧪 Testing All Models with Correct Configurations\n');
  console.log('='.repeat(60));

  // All models that were previously failing + working ones
  const allModels = [
    // Previously working
    'cc/claude-opus-4-6',
    'cc/claude-sonnet-4-6',
    'cx/gpt-5.5',
    'kimi-coding/kimi-k2.6',
    'kimi-coding/kimi-k2.6-thinking',
    'gemini-cli/gemini-3.1-flash-lite-preview',
    'glm/glm-5.1',
    // Previously failing
    'ds/deepseek-v4-pro',
    'minimax/MiniMax-M2.7-highspeed',
    'opencode-go/glm-5.1',
    'opencode-go/kimi-k2.6',
    'opencode-go/mimo-v2.5-pro',
    'opencode-go/minimax-m2.7',
    'opencode-go/qwen3.6-plus',
    'opencode-go/deepseek-v4-pro',
    'opencode-go/deepseek-v4-flash',
    'mimo/mimo-v2.5-pro',
    'mimo/mimo-v2.5'
  ];

  const results: Array<{
    model: string;
    success: boolean;
    latency?: number;
    error?: string;
    config?: any;
  }> = [];

  let totalTests = 0;
  let passedTests = 0;

  for (const model of allModels) {
    totalTests++;
    process.stdout.write(`Testing ${model}... `);

    const result = await testModel(model);

    if (result.success) {
      passedTests++;
      console.log(`✅ ${result.latency}ms (config: ${JSON.stringify(result.config)})`);
    } else {
      console.log(`❌ ${result.error}`);
    }

    results.push({
      model,
      success: result.success,
      latency: result.latency,
      error: result.error,
      config: result.config
    });

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Tests: ${totalTests}`);
  console.log(`Passed: ${passedTests} (${((passedTests / totalTests) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${totalTests - passedTests} (${(((totalTests - passedTests) / totalTests) * 100).toFixed(1)}%)`);

  // Save results
  const fs = await import('node:fs');
  fs.writeFileSync(
    'data/all-models-fixed-test-results.json',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: {
        total: totalTests,
        passed: passedTests,
        failed: totalTests - passedTests,
        passRate: (passedTests / totalTests) * 100
      },
      results
    }, null, 2)
  );

  console.log('\n📄 Detailed results saved to data/all-models-fixed-test-results.json');

  if (passedTests === totalTests) {
    console.log('\n🎉 All models are now working with correct configurations!');
  } else {
    console.log(`\n⚠️ ${totalTests - passedTests} model(s) still failing. Check the results file for details.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});