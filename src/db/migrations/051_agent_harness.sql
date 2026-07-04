-- Migration 051: Agent Harness Test Cases Framework
-- Extends eval_cases for the new TestCase surface and adds supporting tables
-- for metrics, prompt variants, A/B testing, and judge cache

-- Add new columns to eval_cases to support TestCase schema
ALTER TABLE eval_cases ADD COLUMN suite TEXT;
ALTER TABLE eval_cases ADD COLUMN variant_id TEXT;
ALTER TABLE eval_cases ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE eval_cases ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';

-- Update the unique constraint to include suite (drop and recreate)
-- SQLite doesn't support ALTER CONSTRAINT directly, so we recreate the table
CREATE TABLE IF NOT EXISTS eval_cases_new (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  name          TEXT NOT NULL,
  input_json    TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  tags_json     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  suite         TEXT,
  variant_id    TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',
  context_json  TEXT NOT NULL DEFAULT '{}',
  UNIQUE(workspace, suite, name)
);

-- Migrate existing data
INSERT INTO eval_cases_new (id, workspace, name, input_json, expected_json, tags_json, created_at, suite, variant_id, source, context_json)
SELECT id, workspace, name, input_json, expected_json, tags_json, created_at, NULL, NULL, 'manual', '{}'
FROM eval_cases;

-- Drop old table and rename new one
DROP TABLE eval_cases;
ALTER TABLE eval_cases_new RENAME TO eval_cases;

-- Recreate indexes
CREATE INDEX IF NOT EXISTS idx_eval_cases_workspace
  ON eval_cases(workspace, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_cases_suite
  ON eval_cases(suite, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_cases_source
  ON eval_cases(source, created_at);

CREATE INDEX IF NOT EXISTS idx_eval_cases_variant
  ON eval_cases(variant_id);

-- Add columns to eval_runs for variant_id and ab_test_id support
ALTER TABLE eval_runs ADD COLUMN variant_id TEXT;
ALTER TABLE eval_runs ADD COLUMN ab_test_id TEXT;

-- Table: eval_metric_scores
-- Stores metric scores for each eval result (supports multi-metric evaluation)
CREATE TABLE IF NOT EXISTS eval_metric_scores (
  id            TEXT PRIMARY KEY,
  result_id     TEXT NOT NULL REFERENCES eval_results(id) ON DELETE CASCADE,
  metric_name   TEXT NOT NULL,
  score         REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  threshold     REAL NOT NULL CHECK (threshold >= 0 AND threshold <= 1),
  passed        INTEGER NOT NULL CHECK (passed IN (0, 1)),
  reason        TEXT,
  cost_usd      REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  latency_ms    INTEGER NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  meta_json     TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_metric_scores_result
  ON eval_metric_scores(result_id, metric_name);

CREATE INDEX IF NOT EXISTS idx_eval_metric_scores_metric
  ON eval_metric_scores(metric_name, created_at);

-- Table: eval_prompt_variants
-- Stores prompt variants for A/B testing and optimization
CREATE TABLE IF NOT EXISTS eval_prompt_variants (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  component     TEXT NOT NULL CHECK (component IN ('decomposer', 'planner', 'reviewer')),
  name          TEXT NOT NULL,
  prompt_text   TEXT NOT NULL,
  few_shots_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  parent_id     TEXT REFERENCES eval_prompt_variants(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(workspace, component, name)
);

CREATE INDEX IF NOT EXISTS eval_prompt_variants_workspace
  ON eval_prompt_variants(workspace, component, created_at);

CREATE INDEX IF NOT EXISTS eval_prompt_variants_parent
  ON eval_prompt_variants(parent_id);

-- Table: eval_ab_tests
-- Stores A/B test configurations and results
CREATE TABLE IF NOT EXISTS eval_ab_tests (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  variant_a_id  TEXT NOT NULL REFERENCES eval_prompt_variants(id),
  variant_b_id  TEXT NOT NULL REFERENCES eval_prompt_variants(id),
  run_a_id      TEXT NOT NULL REFERENCES eval_runs(id),
  run_b_id      TEXT NOT NULL REFERENCES eval_runs(id),
  winner        TEXT NOT NULL CHECK (winner IN ('a', 'b', 'tie')),
  confidence    REAL NOT NULL,
  delta_score   REAL NOT NULL,
  ci95_low      REAL NOT NULL,
  ci95_high     REAL NOT NULL,
  per_metric_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS eval_ab_tests_workspace
  ON eval_ab_tests(workspace, created_at);

CREATE INDEX IF NOT EXISTS eval_ab_tests_variants
  ON eval_ab_tests(variant_a_id, variant_b_id);

-- Table: eval_judge_cache
-- Caches LLM judge evaluations to avoid redundant API calls
CREATE TABLE IF NOT EXISTS eval_judge_cache (
  cache_key     TEXT PRIMARY KEY,
  model         TEXT NOT NULL,
  score         REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  reason        TEXT NOT NULL,
  raw_json      TEXT NOT NULL,
  cost_usd      REAL NOT NULL CHECK (cost_usd >= 0),
  created_at    INTEGER NOT NULL,
  hit_count     INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0)
);

CREATE INDEX IF NOT EXISTS eval_judge_cache_model
  ON eval_judge_cache(model, created_at);

CREATE INDEX IF NOT EXISTS eval_judge_cache_hits
  ON eval_judge_cache(hit_count DESC);