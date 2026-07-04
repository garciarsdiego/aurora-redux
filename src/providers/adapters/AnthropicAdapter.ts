import { BaseProviderAdapter } from './BaseAdapter.js';
import type { LLMRequest, LLMResponse } from '../types.js';

/**
 * Anthropic Provider Adapter
 */
export class AnthropicAdapter extends BaseProviderAdapter {
  name = 'anthropic';
  supportedModels = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'];
  features = ['tools', 'computer-use', 'artifact-rendering'];

  private apiKey: string;
  private endpoint: string;

  constructor(apiKey: string, endpoint: string = 'https://api.anthropic.com') {
    super();
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for Anthropic adapter: model ${request.model} not supported`);
    }

    const config = this.getModelConfig(request.model);
    const maxTokens = request.max_tokens || config.max_tokens;

    try {
      // Anthropic uses a different message format (system separate)
      const systemMessage = request.messages.find(m => m.role === 'system');
      const messages = request.messages.filter(m => m.role !== 'system');

      const response = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: maxTokens,
          system: systemMessage?.content,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content
          })),
          temperature: request.temperature ?? config.temperature,
          tools: request.tools
        })
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      return {
        content: data.content[0].text,
        model: data.model,
        usage: {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens
        },
        cost_usd: this.calculateCost(data.usage.input_tokens, data.usage.output_tokens, request.model)
      };
    } catch (error) {
      throw new Error(`Anthropic call failed: ${error}`);
    }
  }

  async *stream(request: LLMRequest): AsyncGenerator<string> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for Anthropic adapter: model ${request.model} not supported`);
    }

    const config = this.getModelConfig(request.model);
    const maxTokens = request.max_tokens || config.max_tokens;

    try {
      const systemMessage = request.messages.find(m => m.role === 'system');
      const messages = request.messages.filter(m => m.role !== 'system');

      const response = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: maxTokens,
          system: systemMessage?.content,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content
          })),
          temperature: request.temperature ?? config.temperature,
          tools: request.tools,
          stream: true
        })
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
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
              if (parsed.type === 'content_block_delta') {
                const text = parsed.delta?.text;
                if (text) {
                  yield text;
                }
              } else if (parsed.type === 'content_block_stop') {
                return;
              }
            } catch {
              // Ignore parse errors for keep-alive lines
            }
          }
        }
      }
    } catch (error) {
      throw new Error(`Anthropic stream failed: ${error}`);
    }
  }

  async estimateCost(request: LLMRequest): Promise<number> {
    const inputTokens = this.countMessageTokens(request.messages);
    const outputTokens = request.maxTokens || 500;

    return this.calculateCost(inputTokens, outputTokens, request.model);
  }

  private calculateCost(inputTokens: number, outputTokens: number, model: string): number {
    // Anthropic pricing (as of 2024)
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-opus-4-6': { input: 0.015, output: 0.075 },
      'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
      'claude-haiku-4-5-20251001': { input: 0.00025, output: 0.00125 }
    };

    const baseModel = model.split('/').pop() || model;
    const prices = pricing[baseModel] || pricing['claude-haiku-4-5-20251001'];

    const inputCost = (inputTokens / 1000) * prices.input;
    const outputCost = (outputTokens / 1000) * prices.output;

    return inputCost + outputCost;
  }
}