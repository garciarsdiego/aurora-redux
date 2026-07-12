import { BaseProviderAdapter } from './BaseAdapter.js';
import type { LLMRequest, LLMResponse } from '../types.js';

/**
 * Minimal shape of an OpenAI chat completion response
 */
interface OpenAIChatResponse {
  model: string;
  choices?: Array<{ message?: { content: string } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// OpenAI pricing (as of 2024)
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 0.005, output: 0.015 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }
};

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

  /**
   * Build the fetch init shared by call() and stream()
   */
  private buildRequestInit(request: LLMRequest, stream: boolean) {
    const config = this.getModelConfig(request.model);

    return {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.max_tokens || config.max_tokens,
        temperature: request.temperature ?? config.temperature,
        tools: request.tools,
        ...(stream ? { stream: true } : {})
      })
    };
  }

  async call(request: LLMRequest): Promise<LLMResponse> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for OpenAI adapter: model ${request.model} not supported`);
    }

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, this.buildRequestInit(request, false));

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as OpenAIChatResponse;
      const message = data.choices?.[0]?.message;
      if (!message || !data.usage) {
        throw new Error(`OpenAI API returned an unexpected response format for model ${request.model}`);
      }

      return {
        content: message.content,
        model: data.model,
        usage: {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens
        },
        cost_usd: this.computeCost(data.usage.prompt_tokens, data.usage.completion_tokens, request.model, PRICING, 'gpt-3.5-turbo')
      };
    } catch (error) {
      throw new Error(`OpenAI call failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async *stream(request: LLMRequest): AsyncGenerator<string> {
    if (!this.validateRequest(request)) {
      throw new Error(`Invalid request for OpenAI adapter: model ${request.model} not supported`);
    }

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, this.buildRequestInit(request, true));

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      for await (const data of this.parseSSEPayloads(response)) {
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
    } catch (error) {
      throw new Error(`OpenAI stream failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async estimateCost(request: LLMRequest): Promise<number> {
    const inputTokens = this.countMessageTokens(request.messages);
    const outputTokens = request.max_tokens || 500;

    return this.computeCost(inputTokens, outputTokens, request.model, PRICING, 'gpt-3.5-turbo');
  }
}
