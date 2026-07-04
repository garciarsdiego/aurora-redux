import { getProviderRegistry } from './ProviderRegistry.js';
import { OpenAIAdapter } from './adapters/OpenAIAdapter.js';
import { AnthropicAdapter } from './adapters/AnthropicAdapter.js';
import { callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import type { ProviderAdapter, LLMRequest, LLMResponse, ProviderCallOptions } from './types.js';

export class ProviderManager {
  private registry = getProviderRegistry();
  private adapters: Map<string, ProviderAdapter> = new Map();

  constructor() {
    this.initializeAdapters();
  }

  /**
   * Initialize provider adapters
   */
  private initializeAdapters(): void {
    // In production, these would be loaded from configuration
    // For now, we'll create placeholder adapters that can be configured
    
    // OpenAI adapter (would need API key from config)
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.adapters.set('openai', new OpenAIAdapter(openaiKey));
    }

    // Anthropic adapter (would need API key from config)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      this.adapters.set('anthropic', new AnthropicAdapter(anthropicKey));
    }
  }

  /**
   * Make a call using the best available provider
   */
  async call(
    model: string,
    request: LLMRequest,
    options?: ProviderCallOptions
  ): Promise<LLMResponse> {
    const provider = options?.provider 
      ? this.registry.get(options.provider)
      : this.registry.getBestForModel(model);

    if (!provider) {
      // Fall back to Omniroute
      return this.callOmniroute(model, request);
    }

    // Check if we have an adapter for this provider
    const adapter = this.adapters.get(provider.type);
    if (!adapter) {
      if (options?.fallbackToOmniroute !== false) {
        return this.callOmniroute(model, request);
      }
      throw new Error(`No adapter available for provider: ${provider.name}`);
    }

    try {
      return await adapter.call(request);
    } catch (error) {
      // Fallback to Omniroute on error
      if (options?.fallbackToOmniroute !== false) {
        console.error(`Provider ${provider.name} failed, falling back to Omniroute:`, error);
        return this.callOmniroute(model, request);
      }
      throw error;
    }
  }

  /**
   * Stream a response using the best available provider
   */
  async *stream(
    model: string,
    request: LLMRequest,
    options?: ProviderCallOptions
  ): AsyncGenerator<string> {
    const provider = options?.provider 
      ? this.registry.get(options.provider)
      : this.registry.getBestForModel(model);

    if (!provider) {
      // Fall back to Omniroute
      yield* this.streamOmniroute(model, request);
      return;
    }

    const adapter = this.adapters.get(provider.type);
    if (!adapter) {
      if (options?.fallbackToOmniroute !== false) {
        yield* this.streamOmniroute(model, request);
        return;
      }
      throw new Error(`No adapter available for provider: ${provider.name}`);
    }

    try {
      yield* await adapter.stream(request);
    } catch (error) {
      if (options?.fallbackToOmniroute !== false) {
        console.error(`Provider ${provider.name} failed, falling back to Omniroute:`, error);
        yield* this.streamOmniroute(model, request);
        return;
      }
      throw error;
    }
  }

  /**
   * Get the best provider for a specific model and requirements
   */
  async getBestProvider(
    model: string,
    requirements: string[] = []
  ): Promise<string> {
    // First, try to find a direct provider that supports the model
    const directProvider = this.registry.getBestForModel(model);
    
    if (directProvider) {
      // Check if provider supports all required features
      const hasAllFeatures = requirements.every(f => directProvider.features.includes(f));
      if (hasAllFeatures) {
        return directProvider.name;
      }
    }

    // Fall back to Omniroute for complex requirements
    return 'omniroute';
  }

  /**
   * Perform failover from one provider to another
   */
  async failover(from: string, to: string, model: string, request: LLMRequest): Promise<LLMResponse> {
    const toProvider = this.registry.get(to);
    if (!toProvider) {
      throw new Error(`Target provider ${to} not found in registry`);
    }

    const adapter = this.adapters.get(toProvider.type);
    if (!adapter) {
      throw new Error(`No adapter available for provider: ${to}`);
    }

    console.log(`Failing over from ${from} to ${to} for model ${model}`);
    return await adapter.call(request);
  }

  /**
   * Call Omniroute (fallback)
   */
  private async callOmniroute(model: string, request: LLMRequest): Promise<LLMResponse> {
    try {
      // Find system message if present
      const systemMessage = request.messages.find(m => m.role === 'system');
      const userMessages = request.messages.filter(m => m.role !== 'system');
      
      // Convert to Omniroute format
      const systemPrompt = systemMessage?.content || '';
      const userPrompt = userMessages.map(m => m.content).join('\n');
      
      const response = await callOmnirouteWithUsage({
        systemPrompt,
        userPrompt,
        model,
        temperature: 0.2
      });

      return {
        content: response.content,
        model: response.model_used,
        usage: {
          prompt_tokens: response.usage?.input_tokens || this.estimateTokens(request.messages),
          completion_tokens: response.usage?.output_tokens || this.estimateTokens([{ role: 'assistant', content: response.content }]),
          total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
        },
        cost_usd: response.usage?.total_cost_usd
      };
    } catch (error) {
      throw new Error(`Omniroute call failed: ${error}`);
    }
  }

  /**
   * Stream from Omniroute (fallback)
   */
  private async *streamOmniroute(model: string, request: LLMRequest): AsyncGenerator<string> {
    try {
      // Find system message if present
      const systemMessage = request.messages.find(m => m.role === 'system');
      const userMessages = request.messages.filter(m => m.role !== 'system');
      
      // Convert to Omniroute format
      const systemPrompt = systemMessage?.content || '';
      const userPrompt = userMessages.map(m => m.content).join('\n');
      
      const response = await callOmnirouteWithUsage({
        systemPrompt,
        userPrompt,
        model,
        temperature: 0.2
      });

      // Yield the full response at once (non-streaming fallback)
      yield response.content;
    } catch (error) {
      throw new Error(`Omniroute stream failed: ${error}`);
    }
  }

  /**
   * Estimate cost for a request across providers
   */
  async estimateCost(model: string, request: LLMRequest, provider?: string): Promise<number> {
    if (provider) {
      const adapter = this.adapters.get(provider);
      if (adapter) {
        return await adapter.estimateCost(request);
      }
    }

    // Fall back to cost database
    const { getCostDatabase } = await import('../cost/index.js');
    const costDb = getCostDatabase();
    const cost = costDb.getCost(model, provider || 'omniroute');
    
    if (cost) {
      const inputTokens = this.estimateTokens(request.messages);
      const outputTokens = request.max_tokens || cost.avg_tokens_per_request;
      return costDb.calculateCost(model, inputTokens, outputTokens, cost.provider);
    }

    // Default estimation
    return this.estimateTokens(request.messages) * 0.00001;
  }

  /**
   * Simple token estimation
   */
  private estimateTokens(messages: LLMRequest['messages']): number {
    return messages.reduce((total, msg) => total + Math.ceil(msg.content.length / 4), 0);
  }

  /**
   * Register a custom adapter
   */
  registerAdapter(name: string, adapter: ProviderAdapter): void {
    this.adapters.set(name, adapter);
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Check if a provider is available
   */
  isProviderAvailable(name: string): boolean {
    return this.adapters.has(name) && this.registry.isEnabled(name);
  }
}

// Singleton instance
let providerManagerInstance: ProviderManager | null = null;

export function getProviderManager(): ProviderManager {
  if (!providerManagerInstance) {
    providerManagerInstance = new ProviderManager();
  }
  return providerManagerInstance;
}