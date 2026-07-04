#!/usr/bin/env tsx
/**
 * Get Account Names from Omniroute using configured credentials
 */

import { callOmnirouteWithUsage } from '../src/utils/omniroute-call.js';

async function getAccountNames() {
  console.log('🔍 Getting Account Names from Omniroute...\n');

  try {
    const result = await callOmnirouteWithUsage({
      systemPrompt: 'You are a helpful AI assistant with access to account information.',
      userPrompt: `Please list all connected accounts in the Omniroute system, organized by provider. For each provider, show:
1. Provider name
2. Number of connected accounts
3. Account names/identifiers if visible

Focus especially on:
- OpenAI Codex accounts
- Claude accounts  
- Cursor IDE accounts
- Any other coding-focused providers

Format as a clear, structured list.`,
      model: 'cc/claude-sonnet-4-6',
      temperature: 0.3
    });

    console.log('📊 Account Information:');
    console.log(result.content);
    console.log('\n📈 Usage:');
    if (result.usage) {
      console.log(`- Tokens: ${result.usage.totalTokens || 'N/A'}`);
      console.log(`- Cost: $${result.usage.costUsd?.toFixed(6) || 'N/A'}`);
    }

  } catch (error) {
    console.error('❌ Error getting account names:', error);
  }
}

getAccountNames().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});