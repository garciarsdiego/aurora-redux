CREATE TABLE IF NOT EXISTS dashboard_schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT 'internal',
  target_kind TEXT NOT NULL CHECK (target_kind IN ('objective', 'dag')),
  target_ref TEXT NOT NULL,
  input_payload_json TEXT NOT NULL DEFAULT '{}',
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_status TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notify_on_json TEXT NOT NULL DEFAULT '[]',
  notify_email TEXT,
  retry_max INTEGER NOT NULL DEFAULT 3,
  retry_backoff_seconds INTEGER NOT NULL DEFAULT 60,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_schedules_due
  ON dashboard_schedules (is_active, next_run_at);

CREATE TABLE IF NOT EXISTS dashboard_schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES dashboard_schedules(id) ON DELETE CASCADE,
  workflow_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'error', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 1,
  scheduled_for INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_schedule_runs_schedule
  ON dashboard_schedule_runs (schedule_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dashboard_webhook_triggers (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  workspace TEXT NOT NULL DEFAULT 'internal',
  target_kind TEXT NOT NULL CHECK (target_kind IN ('objective', 'dag')),
  target_ref TEXT NOT NULL,
  input_payload_json TEXT NOT NULL DEFAULT '{}',
  signing_secret_hash TEXT NOT NULL,
  signing_secret_ciphertext TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_invoked_at INTEGER,
  last_status TEXT,
  notify_on_json TEXT NOT NULL DEFAULT '[]',
  notify_email TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_webhook_triggers_slug
  ON dashboard_webhook_triggers (slug);

CREATE TABLE IF NOT EXISTS dashboard_webhook_invocations (
  id TEXT PRIMARY KEY,
  webhook_id TEXT REFERENCES dashboard_webhook_triggers(id) ON DELETE SET NULL,
  slug TEXT NOT NULL,
  workflow_id TEXT,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'error')),
  source_ip TEXT,
  error_message TEXT,
  request_body_preview TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_webhook_invocations_webhook
  ON dashboard_webhook_invocations (webhook_id, created_at DESC);
