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

console.log('🤖 Omniroute Models Summary by Provider');
console.log('========================================\n');

let totalModels = 0;
for (const [provider, models] of sortedProviders) {
  // Count capabilities
  const withVision = models.filter(m => m.capabilities?.vision).length;
  const withTools = models.filter(m => m.capabilities?.tool_calling).length;
  const withReasoning = models.filter(m => m.capabilities?.reasoning).length;
  const withThinking = models.filter(m => m.capabilities?.thinking).length;

  console.log(`📦 ${provider}`);
  console.log(`   Models: ${models.length}`);
  console.log(`   👁️ Vision: ${withVision} | 🔧 Tools: ${withTools} | 🧠 Reasoning: ${withReasoning} | 💭 Thinking: ${withThinking}`);
  console.log('');
  totalModels += models.length;
}

console.log('========================================');
console.log(`📊 Total: ${totalModels} models across ${providers.size} providers\n`);

// Show top models by capabilities
console.log('🏆 Top Models by Capabilities');
console.log('========================================\n');

const allModels = modelsData.data;
const topVision = allModels.filter(m => m.capabilities?.vision).slice(0, 5);
const topTools = allModels.filter(m => m.capabilities?.tool_calling).slice(0, 5);
const topThinking = allModels.filter(m => m.capabilities?.thinking).slice(0, 5);

console.log('👁️ Top Vision Models:');
topVision.forEach(m => console.log(`   • ${m.id} (${m.owned_by})`));

console.log('\n🔧 Top Tool-Calling Models:');
topTools.forEach(m => console.log(`   • ${m.id} (${m.owned_by})`));

console.log('\n💭 Top Thinking Models:');
topThinking.forEach(m => console.log(`   • ${m.id} (${m.owned_by})`));

console.log('\n🔐 OAuth Providers (from dashboard):');
console.log('─'.repeat(50));
const oauthProviders = [
  { name: 'Claude Code', connections: 2 },
  { name: 'Antigravity', connections: 4 },
  { name: 'OpenAI Codex', connections: 3 },
  { name: 'Cursor IDE', connections: 1 },
  { name: 'Kimi Coding', connections: 1 },
  { name: 'Kilo Code', connections: 1 },
  { name: 'Cline', connections: 1 },
  { name: 'Qoder AI', connections: 1 },
  { name: 'Gemini CLI', connections: 4 }
];

for (const provider of oauthProviders) {
  console.log(`  ✅ ${provider.name} (${provider.connections} connected)`);
}

console.log('\n🔑 API Key Providers (from dashboard):');
console.log('─'.repeat(50));
const apiKeyProviders = [
  { name: 'GLM Coding', connections: 1 },
  { name: 'GLM Thinking', connections: 1 },
  { name: 'Z.AI Coding Plan', connections: 1 },
  { name: 'Kimi Coding API Key', connections: 1 },
  { name: 'Minimax Coding', connections: 1 },
  { name: 'Gemini Google AI Studio', connections: 1 },
  { name: 'DeepSeek', connections: 1 },
  { name: 'Groq', connections: 1 },
  { name: 'Cerebras', connections: 1 },
  { name: 'NVIDIA NIM', connections: 1 },
  { name: 'Ollama Cloud', connections: 1 },
  { name: 'HuggingFace', connections: 1 },
  { name: 'OpenCode Go', connections: 1 },
  { name: 'Pollinations AI', connections: 1 },
  { name: 'Xiaomi MiMo', connections: 1 }
];

for (const provider of apiKeyProviders) {
  console.log(`  ✅ ${provider.name} (${provider.connections} connected)`);
}

console.log('\n🌐 Aggregators Gateways:');
console.log('─'.repeat(50));
console.log('  ❌ OpenRouter (No connections)');
console.log('  ❌ Kilo Gateway (No connections)');

console.log('\n🔍 Web Cookie Providers:');
console.log('─'.repeat(50));
console.log('  ✅ Grok Web (Subscription) (1 connected)');
console.log('  ✅ Perplexity Web (Pro/Max) (1 connected)');
console.log('  ✅ Muse Spark Web (Meta AI) (1 connected)');

console.log('\n🔎 Search Providers:');
console.log('─'.repeat(50));
console.log('  ✅ Exa Search (1 connected)');