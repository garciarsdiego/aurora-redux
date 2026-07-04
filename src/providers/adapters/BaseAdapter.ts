import type { ProviderAdapter, LLMRequest, LLMResponse } from '../types.js';

/**
 * Base class for provider adapters
 */
export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract name: string;
  abstract supportedModels: string[];
  abstract features: string[];

  /**
   * Make a synchronous call to the provider
   */
  abstract call(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Stream a response from the provider
   */
  async *stream(request: LLMRequest): AsyncGenerator<string> {
    throw new Error('Stream not implemented');
  }

  /**
   * Estimate cost for a request
   */
  abstract estimateCost(request: LLMRequest): Promise<number>;

  /**
   * Validate if request is supported
   */
  validateRequest(request: LLMRequest): boolean {
    if (!this.supportedModels.includes(request.model)) {
      return false;
    }

    // Check for required features
    if (request.tools && !this.features.includes('tools')) {
      return false;
    }

    return true;
  }

  /**
   * Get model-specific configuration
   */
  protected getModelConfig(model: string) {
    const config: Record<string, any> = {
      max_tokens: 4096,
      temperature: 0.7
    };

    // Model-specific overrides
    if (model.includes('haiku') || model.includes('mini') || model.includes('flash')) {
      config.max_tokens = 8192;
      config.temperature = 0.5;
    } else if (model.includes('opus')) {
      config.max_tokens = 4096;
      config.temperature = 0.8;
    }

    return config;
  }

  /**
   * Count tokens (simplified heuristic)
   */
  protected countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Count tokens in messages
   */
  protected countMessageTokens(messages: LLMRequest['messages']): number {
    return messages.reduce((total: number, msg: { content: string }) => total + this.countTokens(msg.content), 0);
  }
}