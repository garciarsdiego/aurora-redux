// Cost-related types for cost-aware routing

export interface CostRecord {
  model: string;
  provider: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
  avg_tokens_per_request: number;
  max_tokens: number;
  last_updated: number;
}

export interface CostEstimate {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  confidence: number; // 0-1
}

export interface CostAwareRouteRequest {
  objective: string;
  use_case: 'code' | 'debug' | 'planning' | 'review' | 'chat';
  workspace: string;
  budget_usd?: number;
  quality_threshold?: number; // 0-1, default 0.8
  strategy: 'quality' | 'cost' | 'balanced';
  provider_preference?: 'omniroute' | 'direct';
  exclude_models?: string[];
}

export interface ModelCandidate {
  model: string;
  provider: string;
  estimated_cost_usd: number;
  estimated_quality: number;
  avg_latency_ms: number;
  features: string[];
}

export interface CostAwareRouteResponse {
  selected_model: string;
  selected_provider: string;
  estimated_cost_usd: number;
  estimated_quality: number;
  reasoning: string;
  alternatives: ModelCandidate[];
  budget_warning?: {
    current_cost: number;
    budget: number;
    percentage: number;
  };
}

export interface BudgetAlert {
  workflow_id: string;
  task_id?: string;
  current_cost: number;
  budget: number;
  percentage: number;
  severity: 'warning' | 'critical';
  recommended_action?: 'continue' | 'downgrade_model' | 'early_terminate';
}

export interface CostStreamEvent {
  workflow_id: string;
  task_id: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  timestamp: number;
}