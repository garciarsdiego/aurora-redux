#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';

const modelsData = JSON.parse(readFileSync('data/all-models.json', 'utf-8'));

// Group models by provider
const providers = new Map<string, any[]>();

for (const model of modelsData.data) {
  const provider = model.owned_by;
  if (!providers.has(provider)) {
    providers.set(provider, []);
  }
  providers.get(provider)!.push(model);
}

// Sort providers by number of models
const sortedProviders = Array.from(providers.entries())
  .sort((a, b) => b[1].length - a[1].length);

console.log('🤖 Omniroute Models by Provider');
console.log('================================\n');

let totalModels = 0;
for (const [provider, models] of sortedProviders) {
  console.log(`📦 ${provider} (${models.length} models)`);
  console.log('─'.repeat(50));

  for (const model of models) {
    const capabilities = model.capabilities || {};
    const caps = [];
    if (capabilities.vision) caps.push('👁️ vision');
    if (capabilities.tool_calling) caps.push('🔧 tools');
    if (capabilities.reasoning) caps.push('🧠 reasoning');
    if (capabilities.thinking) caps.push('💭 thinking');

    const context = model.context_length ? `${(model.context_length / 1000).toFixed(0)}K` : 'N/A';
    const maxOut = model.max_output_tokens ? `${(model.max_output_tokens / 1000).toFixed(0)}K` : 'N/A';

    console.log(`  • ${model.id}`);
    console.log(`    ${caps.join(' ')} | context: ${context} | max_out: ${maxOut}`);
  }

  console.log('');
  totalModels += models.length;
}

console.log('================================');
console.log(`📊 Total: ${totalModels} models across ${providers.size} providers\n`);

// Show OAuth providers specifically
console.log('🔐 OAuth Providers (from dashboard):');
console.log('─'.repeat(50));
const oauthProviders = [
  'Claude Code (2 connected)',
  'Antigravity (4 connected)', 
  'OpenAI Codex (3 connected)',
  'Cursor IDE (1 connected)',
  'Kimi Coding (1 connected)',
  'Kilo Code (1 connected)',
  'Cline (1 connected)',
  'Qoder AI (1 connected)',
  'Gemini CLI (4 connected)'
];

for (const provider of oauthProviders) {
  console.log(`  ✅ ${provider}`);
}

console.log('\n🔑 API Key Providers (from dashboard):');
console.log('─'.repeat(50));
const apiKeyProviders = [
  'GLM Coding (1 connected)',
  'GLM Thinking (1 connected)',
  'Z.AI Coding Plan (1 connected)',
  'Kimi Coding API Key (1 connected)',
  'Minimax Coding (1 connected)',
  'Gemini Google AI Studio (1 connected)',
  'DeepSeek (1 connected)',
  'Groq (1 connected)',
  'Cerebras (1 connected)',
  'NVIDIA NIM (1 connected)',
  'Ollama Cloud (1 connected)',
  'HuggingFace (1 connected)',
  'OpenCode Go (1 connected)',
  'Pollinations AI (1 connected)',
  'Xiaomi MiMo (1 connected)'
];

for (const provider of apiKeyProviders) {
  console.log(`  ✅ ${provider}`);
}