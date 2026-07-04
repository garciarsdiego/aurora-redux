#!/usr/bin/env tsx
import { readFileSync } from 'node:fs';

const modelsData = JSON.parse(readFileSync('data/all-models.json', 'utf-8'));

// Get unique providers
const providers = new Set<string>();
for (const model of modelsData.data) {
  providers.add(model.owned_by);
}

// Sort alphabetically
const sortedProviders = Array.from(providers).sort();

console.log('🔌 Omniroute Providers Available');
console.log('================================\n');

console.log('Please tell me which providers I can use from this list:\n');

for (const provider of sortedProviders) {
  console.log(`  • ${provider}`);
}

console.log(`\n📊 Total: ${sortedProviders.length} providers`);