import { BaseProviderAdapter } from './BaseAdapter.js';
import type { LLMRequest, LLMResponse } from '../types.js';

/**
 * OpenAI Provider Adapter
 */
export class OpenAIAdapter extends BaseProviderAdapter {
  name = 'openai';
  supportedModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'];
  features = ['tools', 'function-calling', 'structured-outputs', 'vision'];

  private apiKey: string;
  private endpoint: string;

  constructor(apiKey: string, endpoint: string = 'https://api.openai.com/v1') {
    super();
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for OpenAI adapter: model ${request.model} not supported`);
    }

    const config = this.getModelConfig(request.model);
    const maxTokens = request.max_tokens || config.max_tokens;

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: maxTokens,
          temperature: request.temperature ?? config.temperature,
          tools: request.tools
        })
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      return {
        content: data.choices[0].message.content,
        model: data.model,
        usage: {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens
        },
        cost_usd: this.calculateCost(data.usage.prompt_tokens, data.usage.completion_tokens, request.model)
      };
    } catch (error) {
      throw new Error(`OpenAI call failed: ${error}`);
    }
  }

  async *stream(request: LLMRequest): AsyncGenerator<string> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for OpenAI adapter: model ${request.model} not supported`);
    }

    const config = this.getModelConfig(request.model);
    const maxTokens = request.max_tokens || config.max_tokens;

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: maxTokens,
          temperature: request.temperature ?? config.temperature,
          tools: request.tools,
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

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
            const data = line.slice(6);
            if (data === '[DONE]') {
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content;
              if (content) {
                yield content;
              }
            } catch {
              // Ignore parse errors for keep-alive lines
            }
          }
        }
      }
    } catch (error) {
      throw new Error(`OpenAI stream failed: ${error}`);
    }
  }

  async estimateCost(request: LLMRequest): Promise<number> {
    const inputTokens = this.countMessageTokens(request.messages);
    const outputTokens = request.maxTokens || 500;

    return this.calculateCost(inputTokens, outputTokens, request.model);
  }

  private calculateCost(inputTokens: number, outputTokens: number, model: string): number {
    // OpenAI pricing (as of 2024)
    const pricing: Record<string, { input: number; output: number }> = {
      'gpt-4o': { input: 0.005, output: 0.015 },
      'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
      'gpt-4-turbo': { input: 0.01, output: 0.03 },
      'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }
    };

    const baseModel = model.split('/').pop() || model;
    const prices = pricing[baseModel] || pricing['gpt-3.5-turbo'];

    const inputCost = (inputTokens / 1000) * prices.input;
    const outputCost = (outputTokens / 1000) * prices.output;

    return inputCost + outputCost;
  }
}