-- @no-transaction
-- W2 (Aurora dogfood-readiness, 2026-05-11):
-- "Auto-remediation child workflow" link columns.
--
-- Before this migration, `enforceLightTaskQualityReview` failures created
-- `tasks` rows via `createQualityFixTasks` but NOTHING scheduled them — the
-- rows sat orphaned in DB while the parent workflow failed. Operator had to
-- spin a new workflow consuming those task ids by hand.
--
-- W2 closes the loop: a child workflow is spawned with the fix-tasks as its
-- DAG (gated by HITL at t0). The columns added below capture the parent ↔
-- child relationship so:
--   1. `workflows.parent_workflow_id` lets us walk from a remediation child
--      back to its originating workflow (and lets the dashboard render a
--      "child of <wfId>" link).
--   2. `tasks.remediation_workflow_id` lets us walk from an originally-failed
--      parent task to the child workflow that holds its fix-tasks.
--
-- @no-transaction is required because we re-enable FK enforcement at the
-- bottom; SQLite ignores `PRAGMA foreign_keys` issued inside an open
-- transaction, and migration 038 left foreign_keys = ON. We toggle OFF
-- around the ALTER TABLE so the new FK columns can be added without
-- requiring a full table rebuild, then assert ON before returning. The
-- runner re-asserts FK=ON as a safety net.
PRAGMA foreign_keys = OFF;

ALTER TABLE tasks
  ADD COLUMN remediation_workflow_id TEXT NULL REFERENCES workflows(id) ON DELETE SET NULL;

ALTER TABLE workflows
  ADD COLUMN parent_workflow_id TEXT NULL REFERENCES workflows(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_workflows_parent ON workflows(parent_workflow_id)
  WHERE parent_workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_remediation_workflow ON tasks(remediation_workflow_id)
  WHERE remediation_workflow_id IS NOT NULL;

PRAGMA foreign_keys = ON;
