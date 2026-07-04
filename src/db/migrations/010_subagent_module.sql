-- FASE 1B Bloco A.1 — Subagent module schema.
-- Spec: docs/09-H2-ROADMAP-DETAILED.md § FASE 1B Bloco A.1
-- Decision: D-H2.016 (Fase 1B firme).

-- Persistent run records for spawned subagents. Each row is the durable
-- mirror of one subagent's lifecycle. `task_id` ties the run back to the
-- workflow task that spawned it (or that is itself the subagent — see
-- Bloco A.2 executor integration).
CREATE TABLE IF NOT EXISTS subagent_runs (
  run_id            TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  workflow_id       TEXT NOT NULL REFERENCES workflows(id),
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

CREATE INDEX IF NOT EXISTS idx_subagent_runs_task
  ON subagent_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_workflow_status
  ON subagent_runs(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
  ON subagent_runs(parent_run_id);

-- A2A messaging queue. Each row is one message in flight or already
-- delivered. `to_task_id IS NULL` means broadcast to every other task in
-- the workflow; per-task delivery is tracked in subagent_message_deliveries
-- so a broadcast does not get consumed by the first reader.
CREATE TABLE IF NOT EXISTS subagent_messages (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id),
  from_task_id  TEXT NOT NULL REFERENCES tasks(id),
  to_task_id    TEXT REFERENCES tasks(id),
  message_type  TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  delivered_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subagent_messages_workflow_pending
  ON subagent_messages(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_subagent_messages_to_task
  ON subagent_messages(to_task_id, status);

-- Junction table — tracks which broadcast messages have been delivered to
-- which tasks. For directed messages (to_task_id NOT NULL), the row is
-- written when status flips pending→delivered on subagent_messages.
CREATE TABLE IF NOT EXISTS subagent_message_deliveries (
  message_id    TEXT NOT NULL REFERENCES subagent_messages(id),
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  delivered_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_subagent_message_deliveries_task
  ON subagent_message_deliveries(task_id);

-- Steering instruction column on tasks. Bloco A.2 executor reads this on
-- each retry attempt and prepends it to the next prompt as a
-- "STEER INSTRUCTION:" block; cleared (NULL) on task start so retries do
-- not re-inject stale instructions.
ALTER TABLE tasks ADD COLUMN steer_instruction TEXT;
