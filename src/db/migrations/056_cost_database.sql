-- Migration 056: Cost Database for Cost-Aware Routing
-- Stores pricing information for models from different providers
-- Enables cost estimation and budget-aware routing

CREATE TABLE IF NOT EXISTS model_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_cost_per_1k REAL NOT NULL,
  output_cost_per_1k REAL NOT NULL,
  avg_tokens_per_request INTEGER DEFAULT 0,
  max_tokens INTEGER DEFAULT 4096,
  last_updated INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(model, provider)
);

CREATE INDEX IF NOT EXISTS idx_model_costs_model ON model_costs(model);
CREATE INDEX IF NOT EXISTS idx_model_costs_provider ON model_costs(provider);

-- Insert default cost data for common models
INSERT OR IGNORE INTO model_costs (model, provider, input_cost_per_1k, output_cost_per_1k, avg_tokens_per_request, max_tokens) VALUES
-- OpenAI
('gpt-4o', 'openai', 0.005, 0.015, 1000, 128000),
('gpt-4o-mini', 'openai', 0.00015, 0.0006, 500, 128000),
('gpt-4-turbo', 'openai', 0.01, 0.03, 800, 4096),

-- Anthropic
('claude-sonnet-4-6', 'anthropic', 0.003, 0.015, 1200, 200000),
('claude-opus-4-6', 'anthropic', 0.015, 0.075, 1500, 200000),
('claude-haiku-4-5-20251001', 'anthropic', 0.00025, 0.00125, 400, 200000),

-- Google
('gemini-1.5-pro', 'google', 0.00125, 0.005, 1000, 2000000),
('gemini-1.5-flash', 'google', 0.000075, 0.0003, 500, 1000000),

-- Omniroute (generic)
('cc/claude-sonnet-4-6', 'omniroute', 0.003, 0.015, 1200, 200000),
('cc/claude-opus-4-6', 'omniroute', 0.015, 0.075, 1500, 200000),
('cc/claude-haiku-4-5-20251001', 'omniroute', 0.00025, 0.00125, 400, 200000),
('gh/gpt-4o', 'omniroute', 0.005, 0.015, 1000, 128000),
('gh/gpt-4o-mini', 'omniroute', 0.00015, 0.0006, 500, 128000);