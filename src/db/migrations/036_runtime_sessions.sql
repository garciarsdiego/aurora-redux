CREATE TABLE IF NOT EXISTS runtime_capabilities (
  executor_id TEXT PRIMARY KEY,
  capability_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'known',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  executor_id TEXT NOT NULL,
  protocol_tier TEXT NOT NULL,
  stream_format TEXT NOT NULL,
  native_session_id TEXT,
  runtime_mode TEXT NOT NULL DEFAULT 'oneshot',
  status TEXT NOT NULL,
  workspace_path TEXT,
  fallback_reason TEXT,
  approval_status TEXT NOT NULL DEFAULT 'not_required',
  audit_status TEXT NOT NULL DEFAULT 'not_required',
  run_mode TEXT NOT NULL DEFAULT 'dry-run',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_sessions_workflow
  ON runtime_sessions(workflow_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task
  ON runtime_sessions(task_id, updated_at);

CREATE TABLE IF NOT EXISTS runtime_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  prompt_summary TEXT,
  result_summary TEXT,
  error_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_runtime_turns_workflow
  ON runtime_turns(workflow_id, started_at);

CREATE INDEX IF NOT EXISTS idx_runtime_turns_session
  ON runtime_turns(session_id, started_at);

CREATE TABLE IF NOT EXISTS runtime_stream_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES runtime_turns(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(turn_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_runtime_stream_events_turn
  ON runtime_stream_events(turn_id, seq);

CREATE INDEX IF NOT EXISTS idx_runtime_stream_events_workflow
  ON runtime_stream_events(workflow_id, created_at);
