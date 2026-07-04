-- Migration 052: Active Prompt Variants Tracking
-- Adds support for tracking which prompt variant is active per workspace/component
-- This enables runtime prompt variant switching without code changes

-- Table: eval_active_variants
-- Tracks the currently active variant for each component in a workspace
CREATE TABLE IF NOT EXISTS eval_active_variants (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  component     TEXT NOT NULL CHECK (component IN ('decomposer', 'planner', 'reviewer')),
  variant_id    TEXT NOT NULL REFERENCES eval_prompt_variants(id) ON DELETE CASCADE,
  activated_at  INTEGER NOT NULL,
  activated_by  TEXT,
  UNIQUE(workspace, component)
);

CREATE INDEX IF NOT EXISTS idx_eval_active_variants_workspace
  ON eval_active_variants(workspace, component);

CREATE INDEX IF NOT EXISTS idx_eval_active_variants_variant
  ON eval_active_variants(variant_id);