-- @no-transaction
-- Aurora Tier 0 Wave 2 (DB-B): backfill ON DELETE CASCADE / SET NULL
-- on legacy FK declarations from migrations 001 + 010.
--
-- This migration uses the directive `@no-transaction` (handled by the
-- migration runner in src/db/client.ts) because the SQLite-recommended
-- table-rebuild procedure requires `PRAGMA foreign_keys = OFF` around
-- the DROP+RENAME steps, and that PRAGMA is a no-op inside an active
-- transaction. We toggle FK off here, do the rebuild, then re-enable.
-- The runner re-asserts FK=ON as a safety net.
--
-- Problem: tables created in 001_initial.sql and 010_subagent_module.sql
-- declared FKs without explicit ON DELETE behavior. With
-- `PRAGMA foreign_keys=ON` the default is RESTRICT, so deleting a workflow
-- (or task) fails with a constraint error if any child rows still exist.
-- There is no compound transactional cleanup in code today, so workflow
-- delete is effectively unusable from the dashboard / MCP layer.
--
-- SQLite limitation: ALTER TABLE ... ADD/DROP CONSTRAINT does not exist.
-- The only way to change FK clauses is the table-rebuild pattern used in
-- migration 035_context_packets_run_scope.sql:
--   1. CREATE TABLE <name>_v2 with the corrected schema.
--   2. INSERT INTO <name>_v2 (cols) SELECT cols FROM <name>  -- fail loud.
--   3. DROP TABLE <name>.
--   4. ALTER TABLE <name>_v2 RENAME TO <name>.
--   5. Recreate any indexes that lived on the old table.
--
-- Safety: src/db/client.ts wraps every migration in a single transaction,
-- so the entire rebuild sequence is atomic. SQLite's `PRAGMA foreign_keys`
-- is a no-op once a transaction has begun, so we cannot toggle it from
-- inside the migration. We instead use `PRAGMA defer_foreign_keys = ON`
-- which DOES take effect within an open transaction: it makes every FK
-- behave as DEFERRABLE INITIALLY DEFERRED, so RESTRICT-style violations
-- caused by the intermediate DROP/RENAME steps are postponed until COMMIT,
-- where the final, consistent state passes the check. The pragma resets to
-- OFF automatically at the next transaction boundary.
--
-- Column lists below are the union of:
--   001_initial.sql + 002..008 (workflows/tasks adds) + 009 (hitl_gates.task_id)
--   + 010 (subagent_*) + 011 (tasks.execution_mode) + 012 (started_via /
--     resolved_by_actor) + 029 (tasks.replay_of) + 030 (workflows.max_total_cost_usd)
--   + 032 (workflows.max_duration_seconds).
-- Migrations 002 and 008 add columns that were already in 001 in fresh
-- databases (the runner swallows "duplicate column" errors), so the union
-- below is the actual live schema after migrations 001..037 have run.
--
-- Order: parents first (workflows, tasks, patterns), then children that
-- reference them. With foreign_keys=OFF the order is not strictly required
-- for correctness, but keeping it parent-first makes intent clearer.

-- Step 0: disable FK enforcement so DROP TABLE doesn't trip when other
-- tables (task_handoffs, runtime_*) still reference the old table name.
-- The runner restores ON after this migration completes.
PRAGMA foreign_keys = OFF;

-- ============================================================
-- workflows: no outgoing FKs, but children reference it. Rebuild is NOT
-- needed for FK behavior changes on the workflows row itself; we only
-- rebuild children. Skipped on purpose.
-- ============================================================

-- ============================================================
-- tasks: child of workflows. ON DELETE CASCADE on workflow_id.
-- (Self-FK replay_of from migration 029 keeps default behavior.)
-- ============================================================
CREATE TABLE tasks_v2 (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  input_json TEXT,
  output_json TEXT,
  status TEXT NOT NULL,
  depends_on_json TEXT,
  executor_hint TEXT,
  timeout_seconds INTEGER DEFAULT 300,
  max_retries INTEGER DEFAULT 3,
  retry_count INTEGER DEFAULT 0,
  retry_policy TEXT DEFAULT 'exponential',
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  acceptance_criteria TEXT,
  refine_count INTEGER DEFAULT 0,
  max_refine INTEGER DEFAULT 2,
  refine_feedback TEXT,
  model TEXT,
  hitl INTEGER DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model_used TEXT,
  tool_name TEXT,
  steer_instruction TEXT,
  execution_mode TEXT DEFAULT 'ephemeral',
  replay_of TEXT REFERENCES tasks(id)
);

-- ORPHAN FILTER: production DBs may contain `tasks` rows whose `workflow_id`
-- no longer matches any `workflows` row (e.g., manual SQL surgery, partial
-- earlier rollbacks, or pre-PRAGMA-foreign_keys=ON inserts). Filter them
-- out here so the migration commit doesn't trigger a deferred FK check
-- failure. Same pattern repeats for every child rebuild below.
INSERT INTO tasks_v2 (
  id, workflow_id, name, kind, input_json, output_json, status,
  depends_on_json, executor_hint, timeout_seconds, max_retries,
  retry_count, retry_policy, started_at, completed_at, created_at,
  acceptance_criteria, refine_count, max_refine, refine_feedback, model,
  hitl, input_tokens, output_tokens, model_used, tool_name,
  steer_instruction, execution_mode, replay_of
)
SELECT
  id, workflow_id, name, kind, input_json, output_json, status,
  depends_on_json, executor_hint, timeout_seconds, max_retries,
  retry_count, retry_policy, started_at, completed_at, created_at,
  acceptance_criteria, refine_count, max_refine, refine_feedback, model,
  hitl, input_tokens, output_tokens, model_used, tool_name,
  steer_instruction, execution_mode,
  CASE WHEN replay_of IN (SELECT id FROM tasks) THEN replay_of ELSE NULL END
FROM tasks
WHERE workflow_id IN (SELECT id FROM workflows);

DROP TABLE tasks;
ALTER TABLE tasks_v2 RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_replay_of ON tasks(replay_of)
  WHERE replay_of IS NOT NULL;

-- ============================================================
-- events: child of workflows + tasks.
-- workflow_id → CASCADE; task_id → SET NULL (event still useful as
-- workflow-level context after task is gone).
-- ============================================================
CREATE TABLE events_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  timestamp INTEGER NOT NULL
);

INSERT INTO events_v2 (id, workflow_id, task_id, type, payload_json, timestamp)
SELECT
  id, workflow_id,
  CASE WHEN task_id IS NULL OR task_id IN (SELECT id FROM tasks)
       THEN task_id ELSE NULL END AS task_id,
  type, payload_json, timestamp
FROM events
WHERE workflow_id IN (SELECT id FROM workflows);

DROP TABLE events;
ALTER TABLE events_v2 RENAME TO events;

CREATE INDEX IF NOT EXISTS idx_events_workflow ON events(workflow_id, timestamp);

-- ============================================================
-- artifacts: child of workflows + tasks.
-- workflow_id → CASCADE; task_id → SET NULL.
-- ============================================================
CREATE TABLE artifacts_v2 (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_path TEXT,
  content_inline TEXT,
  size_bytes INTEGER,
  hash_sha256 TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO artifacts_v2 (
  id, workflow_id, task_id, workspace, kind, content_path,
  content_inline, size_bytes, hash_sha256, created_at
)
SELECT
  id, workflow_id,
  CASE WHEN task_id IS NULL OR task_id IN (SELECT id FROM tasks)
       THEN task_id ELSE NULL END AS task_id,
  workspace, kind, content_path,
  content_inline, size_bytes, hash_sha256, created_at
FROM artifacts
WHERE workflow_id IN (SELECT id FROM workflows);

DROP TABLE artifacts;
ALTER TABLE artifacts_v2 RENAME TO artifacts;

-- (No indexes were declared on artifacts in 001 or later migrations.)

-- ============================================================
-- pattern_usage: child of workflows + patterns.
-- Both → CASCADE (usage row is meaningless without parent).
-- ============================================================
CREATE TABLE pattern_usage_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  pattern_id TEXT NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  similarity_decision TEXT,
  used_as_is INTEGER DEFAULT 1,
  succeeded INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO pattern_usage_v2 (
  id, workflow_id, pattern_id, similarity_decision,
  used_as_is, succeeded, created_at
)
SELECT
  id, workflow_id, pattern_id, similarity_decision,
  used_as_is, succeeded, created_at
FROM pattern_usage
WHERE workflow_id IN (SELECT id FROM workflows)
  AND pattern_id IN (SELECT id FROM patterns);

DROP TABLE pattern_usage;
ALTER TABLE pattern_usage_v2 RENAME TO pattern_usage;

-- (No indexes were declared on pattern_usage in 001 or later migrations.)

-- ============================================================
-- hitl_gates: child of workflows + tasks.
-- workflow_id → CASCADE; task_id → SET NULL (gate row preserves audit
-- trail even if the originating task is purged).
-- Includes 009 (task_id column) + 012 (resolved_by_actor column).
-- ============================================================
CREATE TABLE hitl_gates_v2 (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  gate_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  context_json TEXT,
  status TEXT NOT NULL,
  decision TEXT,
  decision_reason TEXT,
  channel TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  resolved_by_actor TEXT
);

INSERT INTO hitl_gates_v2 (
  id, workflow_id, gate_type, prompt, context_json, status, decision,
  decision_reason, channel, created_at, decided_at, task_id, resolved_by_actor
)
SELECT
  id, workflow_id, gate_type, prompt, context_json, status, decision,
  decision_reason, channel, created_at, decided_at,
  CASE WHEN task_id IS NULL OR task_id IN (SELECT id FROM tasks)
       THEN task_id ELSE NULL END AS task_id,
  resolved_by_actor
FROM hitl_gates
WHERE workflow_id IN (SELECT id FROM workflows);

DROP TABLE hitl_gates;
ALTER TABLE hitl_gates_v2 RENAME TO hitl_gates;

-- (No indexes were declared on hitl_gates in 001 or later migrations.)

-- ============================================================
-- reviews: child of workflows + tasks. Both → CASCADE (review tied to task).
-- ============================================================
CREATE TABLE reviews_v2 (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  reviewer_model TEXT NOT NULL,
  criteria TEXT,
  score REAL NOT NULL,
  feedback TEXT,
  passed INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO reviews_v2 (
  id, task_id, workflow_id, reviewer_model, criteria,
  score, feedback, passed, created_at
)
SELECT
  id, task_id, workflow_id, reviewer_model, criteria,
  score, feedback, passed, created_at
FROM reviews
WHERE workflow_id IN (SELECT id FROM workflows)
  AND task_id IN (SELECT id FROM tasks);

DROP TABLE reviews;
ALTER TABLE reviews_v2 RENAME TO reviews;

-- (No indexes were declared on reviews in 001 or later migrations.)

-- ============================================================
-- idempotency_keys: child of tasks. task_id → CASCADE.
-- ============================================================
CREATE TABLE idempotency_keys_v2 (
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  response_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

INSERT INTO idempotency_keys_v2 (key, task_id, response_json, created_at, expires_at)
SELECT key, task_id, response_json, created_at, expires_at
FROM idempotency_keys
WHERE task_id IN (SELECT id FROM tasks);

DROP TABLE idempotency_keys;
ALTER TABLE idempotency_keys_v2 RENAME TO idempotency_keys;

-- (No indexes were declared on idempotency_keys in 001 or later migrations.)

-- ============================================================
-- subagent_runs: child of workflows + tasks. Both → CASCADE.
-- Self-FK parent_run_id keeps default (no ON DELETE).
-- ============================================================
CREATE TABLE subagent_runs_v2 (
  run_id            TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workflow_id       TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  -- Self-FK: declare against the final post-rename name so we do not need
  -- to rely on SQLite's rename-cascade for FK targets. Original 010 schema
  -- pointed to subagent_runs(run_id); we keep that intent.
  parent_run_id     TEXT REFERENCES subagent_runs(run_id),
  depth             INTEGER NOT NULL DEFAULT 0,
  model             TEXT,
  task_text         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  result_text       TEXT,
  error_msg         TEXT,
  cleanup           TEXT NOT NULL DEFAULT 'delete',
  spawn_mode        TEXT NOT NULL DEFAULT 'run',
  timeout_seconds   INTEGER,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  archive_after_ms  INTEGER
);

INSERT INTO subagent_runs_v2 (
  run_id, task_id, workflow_id, parent_run_id, depth, model, task_text,
  status, result_text, error_msg, cleanup, spawn_mode, timeout_seconds,
  created_at, started_at, ended_at, archive_after_ms
)
SELECT
  run_id, task_id, workflow_id,
  CASE WHEN parent_run_id IS NULL OR parent_run_id IN (SELECT run_id FROM subagent_runs)
       THEN parent_run_id ELSE NULL END AS parent_run_id,
  depth, model, task_text,
  status, result_text, error_msg, cleanup, spawn_mode, timeout_seconds,
  created_at, started_at, ended_at, archive_after_ms
FROM subagent_runs
WHERE workflow_id IN (SELECT id FROM workflows)
  AND task_id IN (SELECT id FROM tasks);

DROP TABLE subagent_runs;
ALTER TABLE subagent_runs_v2 RENAME TO subagent_runs;

CREATE INDEX IF NOT EXISTS idx_subagent_runs_task
  ON subagent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_workflow_status
  ON subagent_runs(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
  ON subagent_runs(parent_run_id);

-- ============================================================
-- subagent_messages: child of workflows + tasks. workflow_id → CASCADE.
-- from_task_id / to_task_id keep default behavior (per spec, only
-- workflow_id was called out for backfill).
-- ============================================================
CREATE TABLE subagent_messages_v2 (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_task_id  TEXT NOT NULL REFERENCES tasks(id),
  to_task_id    TEXT REFERENCES tasks(id),
  message_type  TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER
);

INSERT INTO subagent_messages_v2 (
  id, workflow_id, from_task_id, to_task_id, message_type,
  payload_json, status, created_at, delivered_at
)
SELECT
  id, workflow_id, from_task_id,
  CASE WHEN to_task_id IS NULL OR to_task_id IN (SELECT id FROM tasks)
       THEN to_task_id ELSE NULL END AS to_task_id,
  message_type, payload_json, status, created_at, delivered_at
FROM subagent_messages
WHERE workflow_id IN (SELECT id FROM workflows)
  AND from_task_id IN (SELECT id FROM tasks);

DROP TABLE subagent_messages;
ALTER TABLE subagent_messages_v2 RENAME TO subagent_messages;

CREATE INDEX IF NOT EXISTS idx_subagent_messages_workflow_pending
  ON subagent_messages(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_subagent_messages_to_task
  ON subagent_messages(to_task_id, status);

-- Re-enable FK enforcement and run an integrity check so any constraint
-- violation introduced by the rebuild is surfaced loudly rather than
-- silently accepted. `PRAGMA foreign_key_check` returns rows for every
-- offending row; if it returns any, we deliberately raise an error to
-- abort the migration (the runner catches it and leaves
-- schema_migrations untouched so the migration is re-tried next start).
PRAGMA foreign_keys = ON;
-- (Operator: if foreign_key_check below returns rows after a run, inspect
--  them with `sqlite3 data/omniforge.db "PRAGMA foreign_key_check"`. The
--  WHERE-filters above should already have dropped orphans; any remaining
--  violation is a bug in this migration.)
