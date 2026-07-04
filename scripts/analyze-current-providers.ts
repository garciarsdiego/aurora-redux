#!/usr/bin/env tsx
/**
 * Analyze Current Providers in Omniroute
 *
 * Downloads the complete model list and analyzes which providers are currently active
 */

const OMNIROUTE_URL = 'http://localhost:20228';
const API_KEY = process.env.OMNIROUTE_API_KEY ?? '';

async function analyzeProviders() {
  console.log('🔍 Analyzing Current Providers in Omniroute...\n');

  try {
    const response = await fetch(`${OMNIROUTE_URL}/api/v1/models`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const models = data.data;

    console.log(`📊 Total Models: ${models.length}\n`);

    // Group by provider
    const providers = new Map<string, any[]>();

    models.forEach((model: any) => {
      const provider = model.owned_by;
      if (!providers.has(provider)) {
        providers.set(provider, []);
      }
      providers.get(provider)!.push(model);
    });

    console.log('🏢 Active Providers:');
    console.log('='.repeat(50));

    const sortedProviders = Array.from(providers.entries()).sort((a, b) => b[1].length - a[1].length);

    sortedProviders.forEach(([provider, models]) => {
      console.log(`\n📦 ${provider}`);
      console.log(`   Models: ${models.length}`);
      console.log(`   Sample models: ${models.slice(0, 3).map((m: any) => m.id).join(', ')}`);
    });

    // Save detailed analysis
    const fs = await import('node:fs');
    const analysis = {
      timestamp: new Date().toISOString(),
      totalModels: models.length,
      totalProviders: providers.size,
      providers: Object.fromEntries(
        sortedProviders.map(([provider, models]) => [
          provider,
          {
            count: models.length,
            models: models.map((m: any) => ({
              id: m.id,
              capabilities: m.capabilities,
              contextLength: m.context_length
            }))
          }
        ])
      )
    };

    fs.writeFileSync(
      'data/current-providers-analysis.json',
      JSON.stringify(analysis, null, 2)
    );

    console.log('\n' + '='.repeat(50));
    console.log(`✅ Analysis complete: ${providers.size} providers, ${models.length} models`);
    console.log('📄 Detailed analysis saved to data/current-providers-analysis.json');

  } catch (error) {
    console.error('❌ Error:', error);
  }
}

analyzeProviders().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});