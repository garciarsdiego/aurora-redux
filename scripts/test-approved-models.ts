#!/usr/bin/env tsx
/**
 * Test All Approved Models
 *
 * Tests each approved model to ensure they are working correctly
 */

import { readFileSync } from 'node:fs';

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

interface ApprovedConfig {
  approved_models: {
    [key: string]: {
      provider: string;
      models: string[];
      note: string;
      use_case: string;
    };
  };
}

async function testModel(model: string): Promise<{ success: boolean; latency?: number; error?: string }> {
  const startTime = Date.now();

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
        max_tokens: 5
      })
    });

    const latency = Date.now() - startTime;

    if (response.ok) {
      return { success: true, latency };
    } else {
      const errorText = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorText.substring(0, 100)}` };
    }
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

async function main() {
  console.log('🧪 Testing All Approved Models\n');
  console.log('='.repeat(60));

  // Load approved models config
  const config: ApprovedConfig = JSON.parse(
    readFileSync('data/approved-models-config.json', 'utf-8')
  );

  const results: Array<{
    provider: string;
    model: string;
    success: boolean;
    latency?: number;
    error?: string;
  }> = [];

  let totalTests = 0;
  let passedTests = 0;

  for (const [providerName, providerConfig] of Object.entries(config.approved_models)) {
    console.log(`\n📦 ${providerName.toUpperCase()} (${providerConfig.provider})`);
    console.log(`   Use Case: ${providerConfig.use_case}`);
    console.log(`   Note: ${providerConfig.note}`);
    console.log(`   Models: ${providerConfig.models.length}`);

    for (const model of providerConfig.models) {
      totalTests++;
      process.stdout.write(`   Testing ${model}... `);

      const result = await testModel(model);

      if (result.success) {
        passedTests++;
        console.log(`✅ ${result.latency}ms`);
      } else {
        console.log(`❌ ${result.error}`);
      }

      results.push({
        provider: providerName,
        model,
        success: result.success,
        latency: result.latency,
        error: result.error
      });

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
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
    'data/approved-models-test-results.json',
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

  console.log('\n📄 Detailed results saved to data/approved-models-test-results.json');

  if (passedTests === totalTests) {
    console.log('\n✅ All approved models are working correctly!');
  } else {
    console.log(`\n⚠️ ${totalTests - passedTests} model(s) failed. Check the results file for details.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});