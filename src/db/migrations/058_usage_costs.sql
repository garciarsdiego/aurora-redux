-- Migration 058: Usage Costs Table for Historical Cost Tracking
-- Stores actual usage costs for workflows and tasks
-- Enables cost analytics and optimization

CREATE TABLE IF NOT EXISTS usage_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  workflow_id TEXT,
  task_id TEXT,
  task_type TEXT DEFAULT 'general',
  timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_costs_workflow ON usage_costs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_usage_costs_task ON usage_costs(task_id);
CREATE INDEX IF NOT EXISTS idx_usage_costs_model ON usage_costs(model);
CREATE INDEX IF NOT EXISTS idx_usage_costs_timestamp ON usage_costs(timestamp);