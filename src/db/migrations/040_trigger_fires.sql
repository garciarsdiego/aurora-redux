-- Migration 040: trigger_fires — outbox pattern for daemon-crash orphan recovery.
--
-- Aurora Tier 0 / Wave 4 / item 0.4 (F-REL-2 follow-up). When the scheduler
-- tick (`src/mcp/routes/_schedule-tick.ts`) or a webhook receiver dispatches
-- a workflow, the dispatch itself was previously fire-and-forget: a crash
-- between "schedule is due" and "workflow row inserted" silently dropped
-- the fire — no retry, no record, no observability.
--
-- The transactional-outbox pattern fixes this without changing the existing
-- tick / receiver logic. Every trigger fire INSERTs a row here BEFORE
-- attempting dispatch (`dispatched_at = NULL`). After the workflow has been
-- created the row is UPDATEd with the workflow_id + dispatched_at. On
-- daemon startup, any row that is older than the grace window and still has
-- `dispatched_at IS NULL` is retried by `runTriggerOrphanRetrySweep()` —
-- see `src/mcp/routes/_trigger-orphan-retry.ts`.
--
-- Polymorphic parent: SQLite cannot express "either schedule OR webhook"
-- in a single FK column, so we keep two nullable FKs side by side. Exactly
-- one is non-null per row (enforced by a CHECK constraint). Both columns
-- declare ON DELETE CASCADE so deleting a parent automatically prunes its
-- fire history.
--
-- workflow_id is intentionally NOT a FK to workflows(id). The row lifecycle
-- starts BEFORE the workflow exists; making it a FK would force a deferred
-- check or a two-phase insert. Soft reference is sufficient — the column is
-- nullable until dispatch, and orphaned references after workflow deletion
-- are harmless (the row only serves observability after dispatch).
--
-- Indexes:
--   * idx_trigger_fires_undispatched — the recovery sweep query
--     (`WHERE dispatched_at IS NULL AND fired_at < ?`). Partial index keeps
--     it tiny on healthy daemons (zero rows match in steady state).
--   * idx_trigger_fires_source — operator lookups by parent
--     ("show me the last 10 fires of schedule X").
--   * idx_trigger_fires_fired_at — recent-fires UI on the dashboard.

CREATE TABLE IF NOT EXISTS trigger_fires (
  id TEXT PRIMARY KEY,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('schedule', 'webhook')),
  schedule_id TEXT REFERENCES dashboard_schedules(id) ON DELETE CASCADE,
  webhook_id TEXT REFERENCES dashboard_webhook_triggers(id) ON DELETE CASCADE,
  invocation_id TEXT,
  workspace TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('objective', 'dag')),
  target_ref TEXT NOT NULL,
  input_payload_json TEXT NOT NULL DEFAULT '{}',
  live_payload TEXT,
  fired_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  workflow_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (trigger_source = 'schedule' AND schedule_id IS NOT NULL AND webhook_id IS NULL)
    OR
    (trigger_source = 'webhook' AND webhook_id IS NOT NULL AND schedule_id IS NULL)
  )
);

-- Partial index for the sweep query (rows still awaiting dispatch).
CREATE INDEX IF NOT EXISTS idx_trigger_fires_undispatched
  ON trigger_fires(fired_at)
  WHERE dispatched_at IS NULL;

-- Lookup by parent (operator + dashboard).
CREATE INDEX IF NOT EXISTS idx_trigger_fires_schedule
  ON trigger_fires(schedule_id, fired_at DESC)
  WHERE schedule_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trigger_fires_webhook
  ON trigger_fires(webhook_id, fired_at DESC)
  WHERE webhook_id IS NOT NULL;

-- Recent-fires UI on the dashboard.
CREATE INDEX IF NOT EXISTS idx_trigger_fires_fired_at
  ON trigger_fires(fired_at DESC);
