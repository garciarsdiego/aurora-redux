-- Migration 057: Benchmark Store for Provider Benchmarking
-- Stores benchmark data for provider performance analysis
-- Enables data-driven provider selection and quality prediction

CREATE TABLE IF NOT EXISTS provider_benchmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  use_case TEXT NOT NULL,
  avg_quality REAL NOT NULL,
  avg_cost_usd REAL NOT NULL,
  avg_latency_ms INTEGER NOT NULL,
  success_rate REAL NOT NULL,
  total_runs INTEGER DEFAULT 0,
  last_updated INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(provider, model, use_case)
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  use_case TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  quality_score REAL NOT NULL,
  cost_usd REAL NOT NULL,
  latency_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_benchmarks_use_case ON provider_benchmarks(use_case);
CREATE INDEX IF NOT EXISTS idx_benchmarks_provider ON provider_benchmarks(provider);
CREATE INDEX IF NOT EXISTS idx_benchmarks_model ON provider_benchmarks(model);
CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON benchmark_runs(timestamp);
CREATE INDEX IF NOT EXISTS idx_runs_provider ON benchmark_runs(provider);
CREATE INDEX IF NOT EXISTS idx_runs_model ON benchmark_runs(model);