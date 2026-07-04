#!/usr/bin/env tsx
/**
 * Check Omniroute Providers Connection Status
 *
 * Attempts to retrieve information about connected providers and their accounts
 * using the configured Omniroute credentials.
 */

import { callOmnirouteWithUsage } from '../src/utils/omniroute-call.js';

async function checkProviders() {
  console.log('🔍 Checking Omniroute Providers Connection Status...\n');

  try {
    // Try to get models information (this might give us provider details)
    const result = await callOmnirouteWithUsage({
      systemPrompt: 'You are a helpful AI assistant.',
      userPrompt: 'List all available AI model providers and their connection status. For each provider, indicate if they are connected via OAuth or API key, and list the account names if visible.',
      model: 'cc/claude-sonnet-4-6',
      temperature: 0.3
    });

    console.log('📊 Response from Omniroute:');
    console.log(result.content);
    console.log('\n📈 Usage:');
    console.log(`- Tokens: ${result.usage.totalTokens}`);
    console.log(`- Cost: $${result.usage.costUsd.toFixed(6)}`);

  } catch (error) {
    console.error('❌ Error checking providers:', error);
  }
}

checkProviders().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});