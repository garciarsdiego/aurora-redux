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
  async *stream(_request: LLMRequest): AsyncGenerator<string> {
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
    if (!this.supportedModels.includes(this.stripModelPrefix(request.model))) {
      return false;
    }

    // Check for required features
    if (request.tools && !this.features.includes('tools')) {
      return false;
    }

    return true;
  }

  /**
   * Strip registry prefixes (e.g. 'cc/', 'gh/') to get the base model name
   */
  protected stripModelPrefix(model: string): string {
    return model.split('/').pop() || model;
  }

  /**
   * Get model-specific configuration
   */
  protected getModelConfig(model: string): { max_tokens: number; temperature: number } {
    const config = {
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
   * Parse an SSE response body, yielding each 'data:' payload as a string
   */
  protected async *parseSSEPayloads(response: Response): AsyncGenerator<string> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          yield line.slice(6);
        }
      }
    }
  }

  /**
   * Compute cost from a per-1K-token pricing table (prices per 1000 tokens)
   */
  protected computeCost(
    inputTokens: number,
    outputTokens: number,
    model: string,
    pricing: Record<string, { input: number; output: number }>,
    fallbackModel: string
  ): number {
    const baseModel = this.stripModelPrefix(model);
    const prices = pricing[baseModel] || pricing[fallbackModel];

    const inputCost = (inputTokens / 1000) * prices.input;
    const outputCost = (outputTokens / 1000) * prices.output;

    return inputCost + outputCost;
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
