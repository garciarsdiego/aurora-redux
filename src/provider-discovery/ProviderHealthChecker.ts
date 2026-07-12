/**
 * Provider Health Checker
 * Tests individual models for availability by making minimal requests
 */

import { providerOf } from './internal.js';

export interface ProviderHealthStatus {
  provider: string;
  model: string;
  status: 'available' | 'no_credits' | 'no_credentials' | 'error' | 'timeout';
  latency_ms?: number;
  error_message?: string;
  error_code?: string;
  last_checked: number;
  test_cost_usd?: number;
}

export class ProviderHealthChecker {
  private omnirouteUrl: string;
  private apiKey: string;
  
  constructor() {
    this.omnirouteUrl = process.env.OMNIROUTE_URL || 'http://localhost:20128/v1';
    this.apiKey = process.env.OMNIROUTE_API_KEY || '';
  }
  
  async checkSingleModel(model: string): Promise<ProviderHealthStatus> {
    const startTime = Date.now();
    const provider = providerOf(model);

    const makeStatus = (
      status: ProviderHealthStatus['status'],
      extra: Partial<ProviderHealthStatus> = {}
    ): ProviderHealthStatus => ({
      provider,
      model,
      status,
      last_checked: Date.now(),
      ...extra
    });

    try {
      // Test request simples e barata
      const response = await this.makeMinimalRequest(model);
      const latency = Date.now() - startTime;

      // Analisar resposta
      if (response.status === 401) {
        return makeStatus('no_credentials', {
          error_message: 'Authentication failed',
          error_code: '401'
        });
      }

      if (response.status === 429) {
        return makeStatus('no_credits', {
          latency_ms: latency,
          error_message: 'Rate limit or no credits',
          error_code: '429'
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        return makeStatus('error', {
          latency_ms: latency,
          error_message: errorText.substring(0, 200),
          error_code: response.status.toString()
        });
      }

      // Se chegou aqui, está disponível
      const data = await response.json();
      const cost = this.estimateCost(data);

      return makeStatus('available', {
        latency_ms: latency,
        test_cost_usd: cost
      });

    } catch (error: unknown) {
      const latency = Date.now() - startTime;
      const code = (error as { code?: unknown } | null)?.code;
      const errorCode = typeof code === 'string' ? code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      return makeStatus(errorCode === 'ETIMEDOUT' || errorCode === 'ECONNREFUSED' ? 'timeout' : 'error', {
        latency_ms: latency,
        error_message: message.substring(0, 200),
        error_code: errorCode
      });
    }
  }
  
  private async makeMinimalRequest(model: string): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    // Request mínima possível para teste
    return await fetch(`${this.omnirouteUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: 'Hi' }], // Mínimo possível
        max_tokens: 1, // 1 token apenas para teste
        stream: false
      })
    });
  }
  
  private estimateCost(responseData: any): number {
    // Estimar custo baseado em usage se disponível
    if (responseData.usage) {
      const inputTokens = responseData.usage.prompt_tokens || 0;
      const outputTokens = responseData.usage.completion_tokens || 0;
      // Estimativa conservadora de $0.001 por 1K tokens
      return ((inputTokens + outputTokens) / 1000) * 0.001;
    }
    // Estimativa padrão para request mínimo
    return 0.00001; // $0.00001 por teste
  }
}