-- Migration 050: Notification preferences table (Sprint 1 - Notification System)
-- Stores user preferences for which notification types they want to receive
-- Supports per-type enable/disable and channel preferences (dashboard, email, etc.)

CREATE TABLE IF NOT EXISTS notification_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  notification_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  channels_json TEXT NOT NULL DEFAULT '["dashboard"]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, notification_type)
);

-- Index for efficient preference lookups
CREATE INDEX IF NOT EXISTS idx_notification_preferences_user
  ON notification_preferences(user_id, notification_type);

-- Insert default preferences for all notification types for the default user
-- Using a fixed timestamp (2026-05-18) for migration reproducibility
INSERT OR IGNORE INTO notification_preferences (id, user_id, notification_type, enabled, channels_json, created_at, updated_at)
VALUES
  ('pref-default-workflow-started', 'default', 'workflow_started', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-workflow-completed', 'default', 'workflow_completed', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-workflow-failed', 'default', 'workflow_failed', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-task-completed', 'default', 'task_completed', 0, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-task-failed', 'default', 'task_failed', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-gate-pending', 'default', 'gate_pending', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-gate-resolved', 'default', 'gate_resolved', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-cost-warning', 'default', 'cost_warning', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-system-alert', 'default', 'system_alert', 1, '["dashboard"]', 1747641600000, 1747641600000),
  ('pref-default-custom', 'default', 'custom', 1, '["dashboard"]', 1747641600000, 1747641600000);