-- Wave 2.A: persona-tool permission decision audit log.
--
-- Persists every `permission_ask` emitted by enforcePersonaToolPermissions
-- and the operator's resolution (if any). Today the daemon is
-- emit-and-continue — tools proceed immediately without waiting for an
-- operator decision. This table captures the audit trail so the dashboard
-- can show "X approved tool Y at T" history; future work flips the gate
-- to await-and-resolve.
--
-- ask_id encoding (assembled in src/v2/agents/permissions.ts):
--   ${workflow_id}:${task_id}:${agent_id}:${tool}:${nonce6}
-- Stable enough that the dashboard can de-duplicate redelivered
-- permission_ask SSE events without relying on local Date.now() coincidence.

CREATE TABLE permission_decisions (
  ask_id TEXT PRIMARY KEY,
  workflow_id TEXT,
  task_id TEXT,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  decision TEXT,                  -- 'approve' | 'deny' | NULL (= still pending)
  decided_by TEXT,                -- operator identifier ('dashboard' default)
  asked_at INTEGER NOT NULL,
  decided_at INTEGER,
  CHECK (decision IS NULL OR decision IN ('approve', 'deny'))
);

CREATE INDEX idx_permission_decisions_workflow ON permission_decisions(workflow_id)
  WHERE workflow_id IS NOT NULL;

CREATE INDEX idx_permission_decisions_pending ON permission_decisions(asked_at)
  WHERE decision IS NULL;
