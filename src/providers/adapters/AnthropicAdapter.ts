import { BaseProviderAdapter } from './BaseAdapter.js';
import type { LLMRequest, LLMResponse } from '../types.js';

/**
 * Minimal shape of an Anthropic Messages API response
 */
interface AnthropicMessagesResponse {
  model: string;
  content?: Array<{ text: string }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// Anthropic pricing (as of 2024)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 0.015, output: 0.075 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5-20251001': { input: 0.00025, output: 0.00125 }
};

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

  /**
   * Build the fetch init shared by call() and stream()
   */
  private buildRequestInit(request: LLMRequest, stream: boolean) {
    const config = this.getModelConfig(request.model);

    // Anthropic uses a different message format (system separate)
    const systemMessage = request.messages.find(m => m.role === 'system');
    const messages = request.messages.filter(m => m.role !== 'system');

    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.max_tokens || config.max_tokens,
        system: systemMessage?.content,
        messages: messages.map(m => ({
          role: m.role,
          content: m.content
        })),
        temperature: request.temperature ?? config.temperature,
        tools: request.tools,
        ...(stream ? { stream: true } : {})
      })
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for Anthropic adapter: model ${request.model} not supported`);
    }

    try {
      const response = await fetch(`${this.endpoint}/v1/messages`, this.buildRequestInit(request, false));

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as AnthropicMessagesResponse;
      const block = data.content?.[0];
      if (!block || !data.usage) {
        throw new Error(`Anthropic API returned an unexpected response format for model ${request.model}`);
      }

      return {
        content: block.text,
        model: data.model,
        usage: {
          prompt_tokens: data.usage.input_tokens,
          completion_tokens: data.usage.output_tokens,
          total_tokens: data.usage.input_tokens + data.usage.output_tokens
        },
        cost_usd: this.computeCost(data.usage.input_tokens, data.usage.output_tokens, request.model, PRICING, 'claude-haiku-4-5-20251001')
      };
    } catch (error) {
      throw new Error(`Anthropic call failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async *stream(request: LLMRequest): AsyncGenerator<string> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for Anthropic adapter: model ${request.model} not supported`);
    }

    try {
      const response = await fetch(`${this.endpoint}/v1/messages`, this.buildRequestInit(request, true));

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
      }

      for await (const data of this.parseSSEPayloads(response)) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            const text = parsed.delta?.text;
            if (text) {
              yield text;
            }
          } else if (parsed.type === 'message_stop') {
            return;
          }
        } catch {
          // Ignore parse errors for keep-alive lines
        }
      }
    } catch (error) {
      throw new Error(`Anthropic stream failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async estimateCost(request: LLMRequest): Promise<number> {
    const inputTokens = this.countMessageTokens(request.messages);
    const outputTokens = request.max_tokens || 500;

    return this.computeCost(inputTokens, outputTokens, request.model, PRICING, 'claude-haiku-4-5-20251001');
  }
}
