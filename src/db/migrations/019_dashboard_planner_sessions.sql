-- Persist planner conversations/DAG drafts so the dashboard can resume
-- planning sessions across refreshes and daemon restarts.

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
