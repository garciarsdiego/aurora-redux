-- D-H2.030 — REPL provenance + race condition multi-actor.
-- See docs/plans/REPL-LEVEL-D.md § 3.5 and docs/decisions.md D-H2.030.
--
-- Adds:
--   workflows.started_via       — origin channel ('cli' | 'mcp' | 'repl' | 'hermes' | 'api')
--   hitl_gates.resolved_by_actor — which channel resolved a gate
--                                  ('repl-<id>' | 'telegram' | 'slack' | 'cli' | 'auto-timeout')
--
-- Both columns are NULL for rows written before this migration. New code MUST
-- populate started_via on insert and resolved_by_actor in resolveHitlGate.
--
-- Idempotent: ALTER TABLE ADD COLUMN with no NOT NULL is safe to apply twice
-- (better-sqlite3 will silently no-op the second add IF the column exists; the
-- migration runner skips already-applied migrations via schema_migrations table).

ALTER TABLE workflows ADD COLUMN started_via TEXT;
ALTER TABLE hitl_gates ADD COLUMN resolved_by_actor TEXT;
