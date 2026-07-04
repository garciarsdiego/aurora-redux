// Benchmark-related types for provider benchmarking

export interface ProviderBenchmark {
  provider: string;
  model: string;
  use_case: string;
  avg_quality: number; // 0-1
  avg_cost_usd: number;
  avg_latency_ms: number;
  success_rate: number; // 0-1
  total_runs: number;
  last_updated: number;
}

export interface BenchmarkRun {
  id: string;
  provider: string;
  model: string;
  use_case: string;
  input: string;
  output: string;
  quality_score: number;
  cost_usd: number;
  latency_ms: number;
  success: boolean;
  timestamp: number;
}

export interface BenchmarkSuite {
  name: string;
  use_cases: string[];
  test_cases: Array<{
    id: string;
    input: string;
    expected_quality: number;
    max_cost_usd?: number;
    max_latency_ms?: number;
  }>;
}

export interface QualityEvaluation {
  score: number; // 0-1
  metrics: {
    correctness?: number;
    completeness?: number;
    efficiency?: number;
    style?: number;
  };
  reasoning: string;
}

export interface BenchmarkReport {
  generated_at: number;
  total_runs: number;
  overall_success_rate: number;
  by_provider: Record<string, {
    avg_quality: number;
    avg_cost: number;
    avg_latency: number;
    success_rate: number;
  }>;
  by_use_case: Record<string, {
    best_provider: string;
    best_model: string;
    avg_quality: number;
  }>;
  recommendations: string[];
}