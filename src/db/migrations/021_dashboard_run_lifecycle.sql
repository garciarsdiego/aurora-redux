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
  id       TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  alert_key   TEXT NOT NULL,
  event_id    INTEGER REFERENCES events(id) ON DELETE CASCADE,
  reason      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dashboard_alert_dismissals_workflow
  ON dashboard_alert_dismissals(workflow_id, alert_key, created_at DESC);
