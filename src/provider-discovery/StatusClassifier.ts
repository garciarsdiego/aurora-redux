/**
 * Status Classifier
 * Classifies and categorizes provider health status
 */

import { ProviderHealthStatus } from './ProviderHealthChecker.js';

export interface AvailabilityReport {
  timestamp: number;
  total_providers: number;
  total_models: number;
  
  available: {
    providers: number;
    models: number;
    details: ProviderHealthStatus[];
    by_provider: Record<string, {
      models: string[];
      count: number;
    }>;
  };
  
  unavailable: {
    no_credits: {
      providers: number;
      models: number;
      details: ProviderHealthStatus[];
    };
    no_credentials: {
      providers: number;
      models: number;
      details: ProviderHealthStatus[];
    };
    error: {
      providers: number;
      models: number;
      details: ProviderHealthStatus[];
    };
    timeout: {
      providers: number;
      models: number;
      details: ProviderHealthStatus[];
    };
  };
  
  by_provider: Record<string, {
    total_models: number;
    available_models: number;
    availability_rate: number;
    status: 'fully_available' | 'partially_available' | 'unavailable';
    recommended_models: string[];
    avg_latency_ms: number;
  }>;
  
  summary: {
    overall_availability_rate: number;
    recommended_providers: string[];
    providers_to_avoid: string[];
  };
}

export class StatusClassifier {
  classifyResults(results: ProviderHealthStatus[]): AvailabilityReport {
    const byProvider = this.groupByProvider(results);
    
    return {
      timestamp: Date.now(),
      total_providers: Object.keys(byProvider).length,
      total_models: results.length,
      
      available: this.extractAvailable(results, byProvider),
      unavailable: this.extractUnavailable(results),
      by_provider: this.generateProviderStats(byProvider),
      summary: this.generateSummary(byProvider)
    };
  }
  
  private groupByProvider(results: ProviderHealthStatus[]): Record<string, ProviderHealthStatus[]> {
    const byProvider: Record<string, ProviderHealthStatus[]> = {};
    
    for (const result of results) {
      if (!byProvider[result.provider]) {
        byProvider[result.provider] = [];
      }
      byProvider[result.provider].push(result);
    }
    
    return byProvider;
  }
  
  private extractAvailable(results: ProviderHealthStatus[], byProvider: Record<string, ProviderHealthStatus[]>) {
    const available = results.filter(r => r.status === 'available');
    
    // Group by provider
    const byProviderData: Record<string, { models: string[]; count: number }> = {};
    for (const provider of Object.keys(byProvider)) {
      const providerAvailable = byProvider[provider].filter(r => r.status === 'available');
      if (providerAvailable.length > 0) {
        byProviderData[provider] = {
          models: providerAvailable.map(r => r.model),
          count: providerAvailable.length
        };
      }
    }
    
    return {
      providers: Object.keys(byProviderData).length,
      models: available.length,
      details: available,
      by_provider: byProviderData
    };
  }
  
  private extractUnavailable(results: ProviderHealthStatus[]) {
    const unavailable = results.filter(r => r.status !== 'available');
    
    return {
      no_credits: {
        providers: new Set(unavailable.filter(r => r.status === 'no_credits').map(r => r.provider)).size,
        models: unavailable.filter(r => r.status === 'no_credits').length,
        details: unavailable.filter(r => r.status === 'no_credits')
      },
      no_credentials: {
        providers: new Set(unavailable.filter(r => r.status === 'no_credentials').map(r => r.provider)).size,
        models: unavailable.filter(r => r.status === 'no_credentials').length,
        details: unavailable.filter(r => r.status === 'no_credentials')
      },
      error: {
        providers: new Set(unavailable.filter(r => r.status === 'error').map(r => r.provider)).size,
        models: unavailable.filter(r => r.status === 'error').length,
        details: unavailable.filter(r => r.status === 'error')
      },
      timeout: {
        providers: new Set(unavailable.filter(r => r.status === 'timeout').map(r => r.provider)).size,
        models: unavailable.filter(r => r.status === 'timeout').length,
        details: unavailable.filter(r => r.status === 'timeout')
      }
    };
  }
  
  private generateProviderStats(byProvider: Record<string, ProviderHealthStatus[]>) {
    const stats: Record<string, any> = {};
    
    for (const [provider, models] of Object.entries(byProvider)) {
      const available = models.filter(m => m.status === 'available');
      const availabilityRate = available.length / models.length;
      
      let status: 'fully_available' | 'partially_available' | 'unavailable';
      if (availabilityRate === 1) status = 'fully_available';
      else if (availabilityRate > 0) status = 'partially_available';
      else status = 'unavailable';
      
      // Calcular latência média dos disponíveis
      const latencies = available
        .map(m => m.latency_ms)
        .filter((l): l is number => l !== undefined);
      const avgLatency = latencies.length > 0 
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
        : 0;
      
      stats[provider] = {
        total_models: models.length,
        available_models: available.length,
        availabilityRate,
        status,
        avg_latency_ms: Math.round(avgLatency),
        recommended_models: available
          .filter(m => m.latency_ms !== undefined)
          .sort((a, b) => (a.latency_ms || Infinity) - (b.latency_ms || Infinity))
          .slice(0, 3)
          .map(m => m.model)
      };
    }
    
    return stats;
  }
  
  private generateSummary(byProvider: Record<string, ProviderHealthStatus[]>) {
    const totalModels = Object.values(byProvider).reduce((sum, models) => sum + models.length, 0);
    const totalAvailable = Object.values(byProvider).reduce(
      (sum, models) => sum + models.filter(m => m.status === 'available').length, 
      0
    );
    
    const overallAvailabilityRate = totalAvailable / totalModels;
    
    // Providers recomendados (100% disponibilidade + baixa latência)
    const recommendedProviders = Object.entries(byProvider)
      .filter(([_, models]) => {
        const available = models.filter(m => m.status === 'available');
        return available.length === models.length && available.length > 0;
      })
      .map(([provider, models]) => {
        const avgLatency = models
          .filter(m => m.status === 'available' && m.latency_ms !== undefined)
          .reduce((sum, m) => sum + (m.latency_ms || 0), 0) / 
          models.filter(m => m.status === 'available').length;
        return { provider, avgLatency };
      })
      .sort((a, b) => a.avgLatency - b.avgLatency)
      .slice(0, 5)
      .map(item => item.provider);
    
    // Providers para evitar (0% disponibilidade)
    const providersToAvoid = Object.entries(byProvider)
      .filter(([_, models]) => models.every(m => m.status !== 'available'))
      .map(([provider, _]) => provider);
    
    return {
      overall_availability_rate: overallAvailabilityRate,
      recommended_providers: recommendedProviders,
      providers_to_avoid: providersToAvoid
    };
  }
}