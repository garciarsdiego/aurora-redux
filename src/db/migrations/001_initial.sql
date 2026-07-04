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
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows(workspace, status);
CREATE INDEX IF NOT EXISTS idx_workflows_created ON workflows(created_at DESC);

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

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  response_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
