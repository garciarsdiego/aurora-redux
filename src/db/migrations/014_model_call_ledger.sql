-- Local LLM/model call ledger.
-- Records per-call usage emitted by Omniroute/OpenAI-compatible responses so
-- cost, token usage and model selection can be audited after a workflow runs.

CREATE TABLE IF NOT EXISTS model_calls (
  id             TEXT PRIMARY KEY,
  workflow_id    TEXT NOT NULL REFERENCES workflows(id),
  task_id        TEXT REFERENCES tasks(id),
  model          TEXT NOT NULL,
  provider       TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  cost_usd       REAL,
  latency_ms     INTEGER,
  source         TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_calls_workflow
  ON model_calls(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_task
  ON model_calls(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_model
  ON model_calls(model, created_at);
