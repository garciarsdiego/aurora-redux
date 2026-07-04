-- Migration 055: reflection store (PHASE-3 Task 3.1).
--
-- Captures a distilled record of every completed workflow so the decomposer
-- can recall lessons from prior similar objectives at plan time. Mirrors the
-- pattern auto-capture design (migration 054 / shape.ts) but emits a richer
-- per-workflow record vs. a static DAG template.
--
-- FTS5 virtual table provides fuzzy keyword search over objective +
-- plan_summary + lessons_learned. Triggers keep it in sync with the base
-- table. The shape stays plain text; embedding-backed semantic recall is
-- deferred (OQ-4 — phase 4).

CREATE TABLE IF NOT EXISTS reflection_store (
  id              TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  objective       TEXT NOT NULL,
  objective_shape TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','failure','partial')),
  plan_summary    TEXT NOT NULL,
  lessons_learned TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  total_cost_usd  REAL,
  model_used      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS reflection_workspace_shape_idx
  ON reflection_store (workspace, objective_shape);

CREATE INDEX IF NOT EXISTS reflection_workspace_created_idx
  ON reflection_store (workspace, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS reflection_fts USING fts5(
  objective,
  plan_summary,
  lessons_learned,
  content=reflection_store,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS reflection_fts_insert
  AFTER INSERT ON reflection_store BEGIN
  INSERT INTO reflection_fts(rowid, objective, plan_summary, lessons_learned)
  VALUES (new.rowid, new.objective, new.plan_summary, new.lessons_learned);
END;

CREATE TRIGGER IF NOT EXISTS reflection_fts_delete
  AFTER DELETE ON reflection_store BEGIN
  DELETE FROM reflection_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS reflection_fts_update
  AFTER UPDATE ON reflection_store BEGIN
  DELETE FROM reflection_fts WHERE rowid = old.rowid;
  INSERT INTO reflection_fts(rowid, objective, plan_summary, lessons_learned)
  VALUES (new.rowid, new.objective, new.plan_summary, new.lessons_learned);
END;
