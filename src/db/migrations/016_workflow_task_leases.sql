-- Durable task execution leases/checkpoints.

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

