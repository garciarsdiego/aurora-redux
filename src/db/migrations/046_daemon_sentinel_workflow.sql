-- Migration 046 (M1 Wave 1, 2026-05-12):
-- Daemon sentinel workflow row so events with workflow_id='_daemon' satisfy
-- the events.workflow_id FK on insertEvent (migration 001).
--
-- The WAL checkpoint tick (`src/db/maintenance.ts`) and the new startup
-- recovery sweeps (task leases + subagent orphans + future daemon-level
-- maintenance) all emit `daemon_recovery_sweep_completed` / `wal_checkpoint`
-- events under this sentinel workflow_id so they show up on the dashboard
-- audit trail without inventing a per-workflow id for daemon-level work.
--
-- Without this row, `insertEvent(db, { workflow_id: '_daemon', ... })`
-- raises FOREIGN KEY constraint failed and the maintenance tick logs to
-- stderr instead of the events table (see maintenance.ts line 110-118
-- comment for the prior fallback).
--
-- INSERT OR IGNORE is idempotent so re-applying this migration on a DB
-- that already has the row (manual operator backfill, prior partial run)
-- is a no-op.
INSERT OR IGNORE INTO workflows (
  id, workspace, objective, status, started_at, created_at
)
VALUES (
  '_daemon',
  'internal',
  '[sentinel] daemon-level events',
  'completed',
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
);
