-- Migration 049: Notifications table (Sprint 1 - Notification System)
-- Stores user notifications with support for different types, priorities, and delivery status
-- Integrates with SSE for real-time delivery to dashboard

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL CHECK (type IN (
    'workflow_started',
    'workflow_completed',
    'workflow_failed',
    'task_completed',
    'task_failed',
    'gate_pending',
    'gate_resolved',
    'cost_warning',
    'system_alert',
    'custom'
  )),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'info' CHECK (priority IN ('low', 'info', 'warning', 'critical')),
  status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'dismissed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  dismissed_at INTEGER
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_status
  ON notifications(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_workflow
  ON notifications(workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_task
  ON notifications(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_type_priority
  ON notifications(type, priority, created_at DESC);