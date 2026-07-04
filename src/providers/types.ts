// Provider-related types for direct provider integration

export interface ProviderConfig {
  name: string;
  type: 'omniroute' | 'openai' | 'anthropic' | 'google' | 'custom';
  endpoint?: string;
  api_key?: string;
  models: string[];
  features: string[];
  priority: number;
  enabled: boolean;
}

export interface ProviderAdapter {
  name: string;
  supportedModels: string[];
  features: string[];
  
  call(request: LLMRequest): Promise<LLMResponse>;
  stream(request: LLMRequest): AsyncGenerator<string>;
  estimateCost(request: LLMRequest): Promise<number>;
}

export interface LLMRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  max_tokens?: number;
  temperature?: number;
  tools?: any[];
  [key: string]: any;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  cost_usd?: number;
}

export interface ProviderCallOptions {
  provider?: string;
  fallbackToOmniroute?: boolean;
  maxRetries?: number;
  timeout?: number;
}