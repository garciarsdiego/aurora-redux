-- Local dashboard workspaces explicitly created from the cockpit UI.

CREATE TABLE IF NOT EXISTS dashboard_workspaces (
  name          TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_dashboard_workspaces_created
  ON dashboard_workspaces(created_at DESC);

