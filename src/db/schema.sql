-- Omniforge core schema
-- Source of truth: OMNIFORGE-PLAN.md (Database Schema section)

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  objective TEXT NOT NULL,
  pattern_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  estimated_cost_usd REAL,
  actual_cost_usd REAL,
  max_total_cost_usd REAL,
  max_duration_seconds INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows(workspace, status);
CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_workspaces (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_dashboard_workspaces_created
  ON dashboard_workspaces(created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_planner_sessions (
  id            TEXT PRIMARY KEY,
  workspace     TEXT NOT NULL,
  title         TEXT NOT NULL,
  objective     TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  dag_json      TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_dashboard_planner_sessions_workspace_updated
  ON dashboard_planner_sessions(workspace, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dashboard_planner_sessions_updated
  ON dashboard_planner_sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_workflow_overrides (
  workflow_id   TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  display_name  TEXT,
  archived_at   INTEGER,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_workflow_overrides_archived
  ON dashboard_workflow_overrides(archived_at, deleted_at);

CREATE TABLE IF NOT EXISTS dashboard_alert_dismissals (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  alert_key   TEXT NOT NULL,
  event_id    INTEGER REFERENCES events(id) ON DELETE CASCADE,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_alert_dismissals_workflow
  ON dashboard_alert_dismissals(workflow_id, alert_key, created_at DESC);

CREATE TABLE IF NOT EXISTS workflow_control_state (
  workflow_id   TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  state         TEXT NOT NULL CHECK (state IN (
    'running',
    'pause_requested',
    'paused',
    'resume_requested',
    'cancel_requested',
    'canceled'
  )),
  requested_by  TEXT,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_control_state_state
  ON workflow_control_state(state, updated_at);

CREATE TABLE IF NOT EXISTS dag_drafts (
  id                    TEXT PRIMARY KEY,
  workspace             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  objective             TEXT NOT NULL,
  dag_json              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'archived', 'started')),
  source                TEXT NOT NULL DEFAULT 'planner',
  started_workflow_id   TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dag_drafts_workspace_status
  ON dag_drafts(workspace, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS context_channels (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','run','debug','approvals','artifacts','agents','custom')),
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace, name)
);

CREATE TABLE IF NOT EXISTS context_threads (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES context_channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('run','task','artifact','approval','error','decision','advisor','custom')),
  title TEXT NOT NULL,
  project_id TEXT,
  work_item_id TEXT,
  run_id TEXT,
  task_id TEXT,
  artifact_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','archived')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES context_threads(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('human','agent','advisor','reviewer','system','tool')),
  sender_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('note','event','log','handoff','context_packet','decision','error','advisor_review')),
  body TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(thread_id, seq)
);

CREATE TABLE IF NOT EXISTS context_packets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  thread_id TEXT REFERENCES context_threads(id) ON DELETE SET NULL,
  packet_json TEXT NOT NULL,
  rendered_prompt TEXT NOT NULL,
  included_handoffs_json TEXT NOT NULL DEFAULT '[]',
  excluded_items_json TEXT NOT NULL DEFAULT '[]',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, task_id, attempt)
);

CREATE TABLE IF NOT EXISTS task_handoffs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  thread_id TEXT REFERENCES context_threads(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'summary' CHECK (kind IN ('summary','artifact','diff','decision','error','instruction','mixed')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  artifacts_json TEXT NOT NULL DEFAULT '[]',
  files_touched_json TEXT NOT NULL DEFAULT '[]',
  decisions_json TEXT NOT NULL DEFAULT '[]',
  safe_context_json TEXT NOT NULL DEFAULT '{}',
  token_estimate INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES work_items(id) ON DELETE CASCADE,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','epic','milestone','batch','task','subtask','atomic_task')),
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ready','running','blocked','review','done','failed','canceled')),
  run_id TEXT,
  task_id TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS context_decisions (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES context_threads(id) ON DELETE SET NULL,
  run_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('approve','reject','retry','cancel','pause','resume','audit','note')),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('proposed','recorded','applied','superseded')),
  rationale TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_threads_run
  ON context_threads(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_threads_task
  ON context_threads(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_context_messages_thread
  ON context_messages(thread_id, seq);
CREATE INDEX IF NOT EXISTS idx_context_packets_task_attempt
  ON context_packets(run_id, task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_task_handoffs_run_task
  ON task_handoffs(run_id, task_id, attempt);
CREATE INDEX IF NOT EXISTS idx_work_items_parent
  ON work_items(parent_id, order_index);
CREATE INDEX IF NOT EXISTS idx_context_decisions_run_task
  ON context_decisions(run_id, task_id, created_at);

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

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
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
  model TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_workflow ON tasks(workflow_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  task_id TEXT REFERENCES tasks(id),
  type TEXT NOT NULL,
  payload_json TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_workflow ON events(workflow_id, timestamp);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  task_id TEXT REFERENCES tasks(id),
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_path TEXT,
  content_inline TEXT,
  size_bytes INTEGER,
  hash_sha256 TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  objective_sample TEXT NOT NULL,
  dag_json TEXT NOT NULL,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  avg_duration_ms INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace, name)
);

CREATE INDEX IF NOT EXISTS idx_patterns_workspace ON patterns(workspace);

CREATE TABLE IF NOT EXISTS pattern_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  pattern_id TEXT NOT NULL REFERENCES patterns(id),
  similarity_decision TEXT,
  used_as_is INTEGER DEFAULT 1,
  succeeded INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hitl_gates (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  gate_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  context_json TEXT,
  status TEXT NOT NULL,
  decision TEXT,
  decision_reason TEXT,
  channel TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  reviewer_model TEXT NOT NULL,
  criteria TEXT,
  score REAL NOT NULL,
  feedback TEXT,
  passed INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_reviews (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK (scope IN ('task','workflow_final')),
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('heuristic','light_ai','robust_ai','browser_harness')),
  reviewer_model TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','needs_fixes','blocked','skipped')),
  score REAL,
  issues_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  fix_tasks_json TEXT NOT NULL DEFAULT '[]',
  approval_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  audit_status TEXT NOT NULL DEFAULT 'recorded'
    CHECK (audit_status IN ('not_required','pending','recorded','failed')),
  run_mode TEXT NOT NULL DEFAULT 'dry-run'
    CHECK (run_mode IN ('dry-run','approved-run')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quality_reviews_workflow
  ON quality_reviews(workflow_id, scope, created_at);

CREATE INDEX IF NOT EXISTS idx_quality_reviews_task
  ON quality_reviews(task_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  response_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS versioned_definitions (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'tool', 'policy')),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'deprecated', 'archived')),
  spec_json TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  supersedes_id TEXT REFERENCES versioned_definitions(id),
  notes TEXT,
  UNIQUE(workspace, kind, name, version)
);

CREATE INDEX IF NOT EXISTS idx_versioned_definitions_lookup
  ON versioned_definitions(workspace, kind, name, version);
CREATE INDEX IF NOT EXISTS idx_versioned_definitions_kind_status
  ON versioned_definitions(kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS active_version_pins (
  workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('agent', 'tool', 'policy')),
  name TEXT NOT NULL,
  version_id TEXT NOT NULL REFERENCES versioned_definitions(id),
  pinned_at INTEGER NOT NULL,
  pinned_by TEXT,
  PRIMARY KEY (workspace, kind, name)
);

CREATE INDEX IF NOT EXISTS idx_active_version_pins_version
  ON active_version_pins(version_id);

CREATE TABLE IF NOT EXISTS versioned_definition_usages (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  task_id TEXT REFERENCES tasks(id),
  definition_id TEXT NOT NULL REFERENCES versioned_definitions(id),
  role TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versioned_definition_usages_workflow
  ON versioned_definition_usages(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_versioned_definition_usages_definition
  ON versioned_definition_usages(definition_id);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  task_id TEXT REFERENCES tasks(id),
  model TEXT NOT NULL,
  provider TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_model_calls_workflow
  ON model_calls(workflow_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_task
  ON model_calls(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_model_calls_model
  ON model_calls(model, created_at);

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  input_json TEXT NOT NULL,
  expected_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(workspace, name)
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_workspace
  ON eval_cases(workspace, created_at);

CREATE TABLE IF NOT EXISTS eval_runs (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  suite_name TEXT NOT NULL,
  status TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  case_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_workspace
  ON eval_runs(workspace, created_at DESC);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES eval_runs(id),
  case_id TEXT NOT NULL REFERENCES eval_cases(id),
  status TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  output_json TEXT,
  feedback TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run
  ON eval_results(run_id, created_at);

CREATE TABLE IF NOT EXISTS workflow_task_leases (
  task_id         TEXT PRIMARY KEY REFERENCES tasks(id),
  workflow_id     TEXT NOT NULL REFERENCES workflows(id),
  lease_owner     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'expired')),
  attempt         INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL,
  heartbeat_at    INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  released_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_workflow_task_leases_workflow
  ON workflow_task_leases(workflow_id, status, heartbeat_at);

CREATE TABLE IF NOT EXISTS trace_spans (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id),
  task_id         TEXT REFERENCES tasks(id),
  parent_span_id  TEXT REFERENCES trace_spans(id),
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'running',
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  attributes_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_trace_spans_workflow
  ON trace_spans(workflow_id, started_at);
