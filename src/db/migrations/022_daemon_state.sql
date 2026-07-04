-- Sprint 2.5 (D-H2.066, F-REL-2): observability for daemon background work.
--
-- Singleton key/value table for daemon state that needs to survive restarts
-- but does NOT belong in workflow/task/event tables (which are per-run).
--
-- First consumer: schedule tick (Sprint 2.6) persists last_schedule_tick_at,
-- last_schedule_tick_status and last_schedule_tick_error so /health can
-- expose tick health and the Studio can show "Last tick ✓ 14:32" / "✗ ...".
--
-- Future consumers: daemon start time, last shutdown reason, total runs
-- processed, etc. Schema is intentionally generic (key text + value JSON).

CREATE TABLE IF NOT EXISTS daemon_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Seed the schedule tick row so /health can return a stable shape from boot
-- (even before the first tick fires).
INSERT OR IGNORE INTO daemon_state (key, value_json, updated_at)
VALUES ('schedule_tick', '{"status":"never_run"}', 0);
