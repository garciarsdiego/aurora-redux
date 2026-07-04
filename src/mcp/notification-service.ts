// Sprint 1 (Notification System): Notification service module
//
// Provides a centralized service for creating and managing notifications.
// Checks user preferences before delivering notifications via SSE.
//
// Usage:
//   import { createNotification } from './notification-service.js';
//   await createNotification({
//     type: 'workflow_completed',
//     title: 'Workflow completed',
//     body: 'Your workflow has finished successfully',
//     priority: 'info',
//     workflow_id: 'wf-123',
//   });

import { randomBytes } from 'node:crypto';
import { initDb } from '../db/client.js';
import { getDbPath } from '../utils/config.js';
import { eventBroker, type NotificationEvent } from './event-broker.js';

export type NotificationType =
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'task_completed'
  | 'task_failed'
  | 'gate_pending'
  | 'gate_resolved'
  | 'cost_warning'
  | 'system_alert'
  | 'custom';

export type NotificationPriority = 'low' | 'info' | 'warning' | 'critical';

export interface CreateNotificationOptions {
  type: NotificationType;
  title: string;
  body: string;
  priority?: NotificationPriority;
  user_id?: string;
  workflow_id?: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationPreference {
  id: string;
  user_id: string;
  notification_type: string;
  enabled: boolean;
  channels: string[];
  created_at: number;
  updated_at: number;
}

// ── Notification creation ─────────────────────────────────────────────────────

/**
 * Creates a new notification and delivers it via SSE if the user has enabled
 * the notification type.
 */
export async function createNotification(
  options: CreateNotificationOptions,
): Promise<string> {
  const {
    type,
    title,
    body,
    priority = 'info',
    user_id = 'default',
    workflow_id = null,
    task_id = null,
    metadata = {},
  } = options;

  // Check if user has enabled this notification type
  const preference = await getNotificationPreference(user_id, type);
  if (preference && !preference.enabled) {
    // Notification type is disabled for this user
    return '';
  }

  const id = `notif-${randomBytes(16).toString('hex')}`;
  const now = Date.now();

  const db = initDb(getDbPath());
  try {
    db.prepare(
      `INSERT INTO notifications
       (id, user_id, type, title, body, priority, status, metadata_json,
        workflow_id, task_id, created_at, read_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      id,
      user_id,
      type,
      title,
      body,
      priority,
      JSON.stringify(metadata),
      workflow_id,
      task_id,
      now,
    );

    // Publish to event broker for SSE delivery
    const notificationEvent: NotificationEvent = {
      id,
      user_id,
      type,
      title,
      body,
      priority,
      metadata,
      workflow_id,
      task_id,
      created_at: now,
    };
    eventBroker.publishNotification(notificationEvent);

    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[notification-service] create error: ${msg}\n`);
    throw err;
  } finally {
    db.close();
  }
}

// ── Notification preferences ─────────────────────────────────────────────────

/**
 * Gets the notification preference for a specific user and notification type.
 */
export async function getNotificationPreference(
  userId: string,
  notificationType: string,
): Promise<NotificationPreference | null> {
  const db = initDb(getDbPath());
  try {
    const row = db.prepare(
      `SELECT id, user_id, notification_type, enabled, channels_json, created_at, updated_at
       FROM notification_preferences
       WHERE user_id = ? AND notification_type = ?`,
    ).get(userId, notificationType) as {
      id: string;
      user_id: string;
      notification_type: string;
      enabled: number;
      channels_json: string;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      user_id: row.user_id,
      notification_type: row.notification_type,
      enabled: row.enabled === 1,
      channels: JSON.parse(row.channels_json) as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[notification-service] get preference error: ${msg}\n`);
    return null;
  } finally {
    db.close();
  }
}

/**
 * Gets all notification preferences for a user.
 */
export async function getAllNotificationPreferences(
  userId: string,
): Promise<NotificationPreference[]> {
  const db = initDb(getDbPath());
  try {
    const rows = db.prepare(
      `SELECT id, user_id, notification_type, enabled, channels_json, created_at, updated_at
       FROM notification_preferences
       WHERE user_id = ?
       ORDER BY notification_type`,
    ).all(userId) as Array<{
      id: string;
      user_id: string;
      notification_type: string;
      enabled: number;
      channels_json: string;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      notification_type: row.notification_type,
      enabled: row.enabled === 1,
      channels: JSON.parse(row.channels_json) as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[notification-service] get all preferences error: ${msg}\n`);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Updates a notification preference for a user.
 */
export async function updateNotificationPreference(
  userId: string,
  notificationType: string,
  enabled: boolean,
  channels?: string[],
): Promise<void> {
  const db = initDb(getDbPath());
  try {
    const now = Date.now();
    const channelsJson = channels ? JSON.stringify(channels) : '["dashboard"]';

    db.prepare(
      `INSERT INTO notification_preferences (id, user_id, notification_type, enabled, channels_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, notification_type)
       DO UPDATE SET enabled = excluded.enabled, channels_json = excluded.channels_json, updated_at = excluded.updated_at`,
    ).run(
      `pref-${userId}-${notificationType}`,
      userId,
      notificationType,
      enabled ? 1 : 0,
      channelsJson,
      now,
      now,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[notification-service] update preference error: ${msg}\n`);
    throw err;
  } finally {
    db.close();
  }
}

// ── Convenience functions ─────────────────────────────────────────────────────

/**
 * Creates a workflow started notification.
 */
export async function notifyWorkflowStarted(
  workflowId: string,
  objective: string,
  userId: string = 'default',
): Promise<string> {
  return createNotification({
    type: 'workflow_started',
    title: 'Workflow started',
    body: `Started: ${objective}`,
    priority: 'info',
    user_id: userId,
    workflow_id: workflowId,
    metadata: { objective },
  });
}

/**
 * Creates a workflow completed notification.
 */
export async function notifyWorkflowCompleted(
  workflowId: string,
  objective: string,
  userId: string = 'default',
): Promise<string> {
  return createNotification({
    type: 'workflow_completed',
    title: 'Workflow completed',
    body: `Completed: ${objective}`,
    priority: 'info',
    user_id: userId,
    workflow_id: workflowId,
    metadata: { objective },
  });
}

/**
 * Creates a workflow failed notification.
 */
export async function notifyWorkflowFailed(
  workflowId: string,
  objective: string,
  error: string,
  userId: string = 'default',
): Promise<string> {
  return createNotification({
    type: 'workflow_failed',
    title: 'Workflow failed',
    body: `Failed: ${objective}\nError: ${error}`,
    priority: 'critical',
    user_id: userId,
    workflow_id: workflowId,
    metadata: { objective, error },
  });
}

/**
 * Creates a gate pending notification.
 */
export async function notifyGatePending(
  gateId: string,
  workflowId: string,
  prompt: string,
  userId: string = 'default',
): Promise<string> {
  return createNotification({
    type: 'gate_pending',
    title: 'Approval required',
    body: `Your workflow requires approval: ${prompt.substring(0, 100)}...`,
    priority: 'warning',
    user_id: userId,
    workflow_id: workflowId,
    metadata: { gate_id: gateId, prompt },
  });
}