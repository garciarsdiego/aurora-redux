/**
 * Discovery Orchestrator
 * Coordinates the multi-phase provider discovery process
 */

import { ProviderHealthChecker, ProviderHealthStatus } from './ProviderHealthChecker.js';
import * as fs from 'fs';
import * as path from 'path';

export interface DiscoveryReport {
  timestamp: number;
  total_models_tested: number;
  total_providers_tested: number;
  phase1_summary: {
    total_providers: number;
    available_providers: number;
    unavailable_providers: number;
  };
  phase2_summary: {
    total_models_tested: number;
    available_models: number;
    unavailable_models: number;
  };
  all_results: ProviderHealthStatus[];
}

export class DiscoveryOrchestrator {
  private healthChecker: ProviderHealthChecker;
  private maxConcurrent: number = 3; // Limitar para não sobrecarregar
  private omnirouteUrl: string;
  
  constructor() {
    this.healthChecker = new ProviderHealthChecker();
    this.omnirouteUrl = process.env.OMNIROUTE_URL || 'http://localhost:20128/v1';
  }
  
  async discoverAllProviders(): Promise<DiscoveryReport> {
    console.log('🔍 Starting provider discovery...');
    console.log(`📡 Omniroute URL: ${this.omnirouteUrl}`);
    
    // Buscar todos os modelos do catálogo
    const allModels = await this.fetchAllModels();
    console.log(`📊 Found ${allModels.length} total models`);
    
    if (allModels.length === 0) {
      throw new Error('No models found in catalog');
    }
    
    // Agrupar por provider para testes inteligentes
    const byProvider = this.groupByProvider(allModels);
    console.log(`🗂️  Grouped into ${Object.keys(byProvider).length} providers`);
    
    // Fase 1: Testar 1 modelo por provider (descoberta rápida)
    console.log('\n🚀 Phase 1: Testing 1 model per provider...');
    const phase1Results = await this.testProviderRepresentatives(byProvider);
    
    const availableProviders = phase1Results.filter(r => r.status === 'available');
    const unavailableProviders = phase1Results.filter(r => r.status !== 'available');
    
    console.log(`✅ Phase 1 Complete: ${availableProviders.length}/${phase1Results.length} providers available`);
    console.log(`❌ Unavailable: ${unavailableProviders.length} providers`);
    
    // Mostrar detalhes dos indisponíveis
    this.printUnavailableDetails(unavailableProviders);
    
    // Fase 2: Para providers disponíveis, testar mais modelos
    console.log('\n✅ Phase 2: Deep-dive available providers...');
    const phase2Results = await this.testAvailableProviders(phase1Results, byProvider);
    
    const allResults = [...phase1Results, ...phase2Results];
    
    // Gerar relatório consolidado
    const report = this.generateDiscoveryReport(phase1Results, phase2Results, allResults);
    
    return report;
  }
  
  async fetchAllModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.omnirouteUrl}/models`);
      if (!response.ok) {
        throw new Error(`Failed to fetch models: ${response.status}`);
      }
      
      const data = await response.json();
      return data.data.map((m: any) => m.id);
    } catch (error) {
      console.error('Error fetching models:', error);
      throw error;
    }
  }
  
  groupByProvider(models: string[]): Record<string, string[]> {
    const byProvider: Record<string, string[]> = {};
    
    for (const model of models) {
      const provider = model.split('/')[0];
      if (!byProvider[provider]) {
        byProvider[provider] = [];
      }
      byProvider[provider].push(model);
    }
    
    return byProvider;
  }
  
  async testProviderRepresentatives(byProvider: Record<string, string[]>) {
    const results: ProviderHealthStatus[] = [];
    const providers = Object.keys(byProvider);
    
    console.log(`Testing ${providers.length} providers (batches of ${this.maxConcurrent})...`);
    
    // Testar em batches concorrentes
    for (let i = 0; i < providers.length; i += this.maxConcurrent) {
      const batch = providers.slice(i, i + this.maxConcurrent);
      console.log(`  Batch ${Math.floor(i / this.maxConcurrent) + 1}: ${batch.join(', ')}`);
      
      const batchResults = await Promise.all(
        batch.map(provider => 
          this.healthChecker.checkSingleModel(byProvider[provider][0])
        )
      );
      results.push(...batchResults);
      
      // Delay entre batches para rate limiting
      if (i + this.maxConcurrent < providers.length) {
        await this.sleep(500);
      }
    }
    
    return results;
  }
  
  private async testAvailableProviders(
    phase1Results: ProviderHealthStatus[],
    byProvider: Record<string, string[]>
  ) {
    const availableProviders = phase1Results
      .filter(r => r.status === 'available')
      .map(r => r.provider);
    
    if (availableProviders.length === 0) {
      console.log('⚠️  No available providers found for deep-dive');
      return [];
    }
    
    console.log(`🔍 Deep-dive ${availableProviders.length} available providers...`);
    
    const detailedResults: ProviderHealthStatus[] = [];
    
    for (const provider of availableProviders) {
      const models = byProvider[provider];
      console.log(`  Testing ${provider}: ${models.length} models...`);
      
      // Testar todos os modelos do provider disponível
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        const result = await this.healthChecker.checkSingleModel(model);
        detailedResults.push(result);
        
        // Progress indicator
        if ((i + 1) % 10 === 0) {
          console.log(`    Progress: ${i + 1}/${models.length}`);
        }
        
        // Pequeno delay entre requests para não sobrecarregar
        await this.sleep(100);
      }
      
      console.log(`  ✅ ${provider}: ${detailedResults.filter(r => r.provider === provider && r.status === 'available').length}/${models.length} available`);
    }
    
    return detailedResults;
  }
  
  private printUnavailableDetails(unavailable: ProviderHealthStatus[]) {
    if (unavailable.length === 0) return;
    
    console.log('\n❌ Unavailable Providers Details:');
    const byStatus: Record<string, ProviderHealthStatus[]> = {
      'no_credits': [],
      'no_credentials': [],
      'error': [],
      'timeout': []
    };
    
    for (const result of unavailable) {
      byStatus[result.status].push(result);
    }
    
    for (const [status, items] of Object.entries(byStatus)) {
      if (items.length > 0) {
        console.log(`  ${status}: ${items.length} providers`);
        for (const item of items) {
          console.log(`    - ${item.provider}: ${item.error_message || item.error_code}`);
        }
      }
    }
  }
  
  private generateDiscoveryReport(
    phase1Results: ProviderHealthStatus[],
    phase2Results: ProviderHealthStatus[],
    allResults: ProviderHealthStatus[]
  ): DiscoveryReport {
    const availableProviders = phase1Results.filter(r => r.status === 'available');
    const unavailableProviders = phase1Results.filter(r => r.status !== 'available');
    
    const availableModels = allResults.filter(r => r.status === 'available');
    const unavailableModels = allResults.filter(r => r.status !== 'available');
    
    return {
      timestamp: Date.now(),
      total_models_tested: allResults.length,
      total_providers_tested: phase1Results.length,
      phase1_summary: {
        total_providers: phase1Results.length,
        available_providers: availableProviders.length,
        unavailable_providers: unavailableProviders.length
      },
      phase2_summary: {
        total_models_tested: phase2Results.length,
        available_models: availableModels.length,
        unavailable_models: unavailableModels.length
      },
      all_results: allResults
    };
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}