-- Migration 054: pattern auto-capture support (Week 3 / Task 2.3).
--
-- Adds the `objective_shape` column to `patterns` plus a lookup index so the
-- orchestrate.ts post-completion hook can find prior patterns that match
-- the current objective's normalized shape (verbs + nouns, stripped of
-- dates and named entities). Auto-capture writes a new pattern when the
-- same shape has shipped successfully 3+ times.
--
-- Parametric slot columns (`template_objective`, `slots_json`) are added
-- here too so Task 2.4 can populate them without another migration.

ALTER TABLE patterns ADD COLUMN objective_shape TEXT;
ALTER TABLE patterns ADD COLUMN template_objective TEXT;
ALTER TABLE patterns ADD COLUMN slots_json TEXT;

CREATE INDEX IF NOT EXISTS idx_patterns_workspace_shape
  ON patterns(workspace, objective_shape);
