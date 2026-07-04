CREATE TABLE secrets (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_encrypted BLOB NOT NULL,
  iv BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace, key)
);

CREATE INDEX idx_secrets_workspace ON secrets(workspace);
