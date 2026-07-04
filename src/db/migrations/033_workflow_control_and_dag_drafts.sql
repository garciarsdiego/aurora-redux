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
