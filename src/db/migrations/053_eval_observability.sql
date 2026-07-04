-- Migration 053: Eval Observability
-- Adds timeline tracking for eval runs and optimization runs to support dashboard observability

-- Table: eval_run_events
-- Stores timeline events for eval runs (started, completed, failed, etc.)
CREATE TABLE IF NOT EXISTS eval_run_events (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL CHECK (event_type IN ('started', 'completed', 'failed', 'metric_scored', 'case_completed', 'case_failed', 'optimization_iteration', 'optimization_completed')),
  message       TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_run_events_run
  ON eval_run_events(run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_run_events_type
  ON eval_run_events(event_type, created_at);

-- Table: eval_optimization_runs
-- Stores optimization run metadata (separate from eval_runs for better organization)
CREATE TABLE IF NOT EXISTS eval_optimization_runs (
  id                TEXT PRIMARY KEY,
  workspace         TEXT NOT NULL,
  base_variant_id   TEXT NOT NULL REFERENCES eval_prompt_variants(id),
  strategy          TEXT NOT NULL CHECK (strategy IN ('bootstrap-fewshot', 'miprov2', 'gepa', 'random', 'grid', 'bandit-ucb1')),
  target_metric     TEXT NOT NULL,
  max_iterations    INTEGER NOT NULL,
  max_cost_usd      REAL NOT NULL,
  max_clock_ms      INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  current_iteration INTEGER NOT NULL DEFAULT 0,
  best_score        REAL,
  best_variant_id   TEXT REFERENCES eval_prompt_variants(id),
  total_cost_usd    REAL NOT NULL DEFAULT 0,
  total_clock_ms    INTEGER NOT NULL DEFAULT 0,
  stopped_reason    TEXT,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_eval_optimization_runs_workspace
  ON eval_optimization_runs(workspace, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_optimization_runs_status
  ON eval_optimization_runs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_optimization_runs_base_variant
  ON eval_optimization_runs(base_variant_id);

-- Table: eval_optimization_trials
-- Stores individual trials within an optimization run
CREATE TABLE IF NOT EXISTS eval_optimization_trials (
  id                TEXT PRIMARY KEY,
  optimization_id   TEXT NOT NULL REFERENCES eval_optimization_runs(id) ON DELETE CASCADE,
  iteration         INTEGER NOT NULL,
  variant_id        TEXT NOT NULL REFERENCES eval_prompt_variants(id),
  axis_values_json  TEXT NOT NULL DEFAULT '{}',
  objective_score   REAL NOT NULL,
  metric_scores_json TEXT NOT NULL DEFAULT '{}',
  cost_usd          REAL NOT NULL,
  clock_ms          INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_optimization_trials_optimization
  ON eval_optimization_trials(optimization_id, iteration);

CREATE INDEX IF NOT EXISTS idx_eval_optimization_trials_variant
  ON eval_optimization_trials(variant_id);

-- Add columns to eval_runs for better observability
ALTER TABLE eval_runs ADD COLUMN total_cost_usd REAL DEFAULT 0;
ALTER TABLE eval_runs ADD COLUMN total_clock_ms INTEGER DEFAULT 0;
ALTER TABLE eval_runs ADD COLUMN agent_type TEXT CHECK (agent_type IN ('decomposer', 'planner', 'reviewer'));
ALTER TABLE eval_runs ADD COLUMN metadata_json TEXT DEFAULT '{}';

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_eval_runs_workspace_created
  ON eval_runs(workspace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_runs_status
  ON eval_runs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_runs_variant
  ON eval_runs(variant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_eval_runs_ab_test
  ON eval_runs(ab_test_id);