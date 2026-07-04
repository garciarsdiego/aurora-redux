-- Migration 039: hot-path indexes for the scheduler tick.
--
-- Tier 0 / Wave 2 (DB-C). Audit identified that scheduler queries in
-- src/scheduler/tick.ts and src/db/task-leases.ts do per-row primary-key
-- lookups (Q1, Q2) or a full table scan (Q3) when looking for stale or
-- expired leases. This migration adds partial indexes on
-- workflow_task_leases so the scheduler scans only the running rows in
-- time order.
--
-- Brief reconciliation:
--   * The brief asked for indexes on `tasks(heartbeat_at)` and
--     `tasks(expires_at)`. Those columns DO NOT exist on `tasks` — they
--     live on `workflow_task_leases` (created in migration 016). The
--     scheduler queries are JOINs against `workflow_task_leases`, so the
--     correct fix is partial indexes on that table. EXPLAIN QUERY PLAN
--     baselines (see tests/unit/migration-039-indexes.test.ts) confirm
--     the new indexes are picked up.
--   * `model_calls(workflow_id, created_at)` was already created by
--     migration 014 as `idx_model_calls_workflow` (COVERING INDEX usage
--     verified). Skipping to avoid duplicate.
--   * `patterns(workspace, name)` is already covered by the
--     `UNIQUE(workspace, name)` constraint declared in migration 001
--     (auto-index `sqlite_autoindex_patterns_2`). Skipping to avoid
--     duplicate.
--
-- All statements are idempotent (`CREATE INDEX IF NOT EXISTS`). No
-- existing tables or indexes are modified.

-- Q1 hot path (emitTaskHungEvents): scheduler finds leases whose worker
-- has stopped heartbeating. Filtering predicate is
-- `WHERE status = 'running' AND heartbeat_at < ?`. A partial index keeps
-- the index small (only the running rows) and lets SQLite scan in
-- heartbeat_at order without touching the rest of the table.
CREATE INDEX IF NOT EXISTS idx_workflow_task_leases_running_heartbeat
  ON workflow_task_leases(heartbeat_at)
  WHERE status = 'running';

-- Q2/Q3 hot path (expireTimedOutRunningTasks, recoverExpiredTaskLeases):
-- scheduler finds leases past their deadline. Predicate is
-- `WHERE status = 'running' AND expires_at <= ?`. Partial index again
-- restricts to running rows.
CREATE INDEX IF NOT EXISTS idx_workflow_task_leases_running_expires
  ON workflow_task_leases(expires_at)
  WHERE status = 'running';
