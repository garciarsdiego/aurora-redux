// Sprint 1 (Notification System): Handler for notification management endpoints.
//
// Provides CRUD operations for notifications with real database persistence.
// Integrates with SSE for real-time delivery to dashboard.
//
// All routes are Bearer-auth gated by http-server.ts upstream.
//
// Routes:
//   GET    /api/dashboard/notifications                        — list notifications (with filters)
//   POST   /api/dashboard/notifications/:id/dismiss            — mark dismissed
//   POST   /api/dashboard/notifications/:id/read               — mark as read
//   GET    /api/dashboard/notifications/unread-count           — get unread count
//   POST   /api/dashboard/notifications/dismiss-all            — dismiss all notifications
//   GET    /api/dashboard/notifications/preferences           — get notification preferences
//   PATCH  /api/dashboard/notifications/preferences/:type      — update notification preference

import type { IncomingMessage, ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readJsonBody, safeJsonParse } from './_shared.js';

// ── Path patterns ─────────────────────────────────────────────────────────────

const DISMISS_RE = /^\/api\/dashboard\/notifications\/([^/]+)\/dismiss$/;
const READ_RE = /^\/api\/dashboard\/notifications\/([^/]+)\/read$/;
const PREFERENCE_RE = /^\/api\/dashboard\/notifications\/preferences\/([^/]+)$/;

// ── Types ────────────────────────────────────────────────────────────────────

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  status: string;
  metadata_json: string;
  workflow_id: string | null;
  task_id: string | null;
  created_at: number;
  read_at: number | null;
  dismissed_at: number | null;
}

interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  priority: string;
  status: string;
  metadata: Record<string, unknown>;
  workflow_id: string | null;
  task_id: string | null;
  created_at: number;
  read_at: number | null;
  dismissed_at: number | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function rowToNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    priority: row.priority,
    status: row.status,
    metadata: safeJsonParse(row.metadata_json),
    workflow_id: row.workflow_id,
    task_id: row.task_id,
    created_at: row.created_at,
    read_at: row.read_at,
    dismissed_at: row.dismissed_at,
  };
}

function getUserId(req: IncomingMessage): string {
  // For now, default to 'default' user. In future, extract from auth token
  return 'default';
}

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleList(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const userId = getUserId(req);
  const status = url.searchParams.get('status') ?? 'all';
  const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
  const type = url.searchParams.get('type');

  const db = initDb(getDbPath());
  try {
    let query = `
      SELECT id, user_id, type, title, body, priority, status, metadata_json,
             workflow_id, task_id, created_at, read_at, dismissed_at
      FROM notifications
      WHERE user_id = ?
    `;
    const params: unknown[] = [userId];

    if (status !== 'all') {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (type) {
      query += ` AND type = ?`;
      params.push(type);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params) as NotificationRow[];
    const notifications = rows.map(rowToNotification);

    // Get total count
    let countQuery = `SELECT COUNT(*) as total FROM notifications WHERE user_id = ?`;
    const countParams: unknown[] = [userId];
    if (status !== 'all') {
      countQuery += ` AND status = ?`;
      countParams.push(status);
    }
    if (type) {
      countQuery += ` AND type = ?`;
      countParams.push(type);
    }

    const countResult = db.prepare(countQuery).get(...countParams) as { total: number };
    const total = countResult.total;

    jsonOk(res, { notifications, total, limit, offset });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dashboard-notifications] list error: ${msg}\n`);
    badRequest(res, 'Failed to list notifications');
  } finally {
    db.close();
  }
}

function handleDismiss(
  notificationId: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const userId = getUserId(req);
  const db = initDb(getDbPath());
  try {
    const result = db.prepare(
      `UPDATE notifications
       SET dismissed_at = ?, status = 'dismissed'
       WHERE id = ? AND user_id = ?`
    ).run(Date.now(), notificationId, userId);

    if (result.changes === 0) {
      badRequest(res, 'Notification not found');
      return;
    }

    jsonOk(res, { ok: true, dismissed_id: notificationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dashboard-notifications] dismiss error: ${msg}\n`);
    badRequest(res, 'Failed to dismiss notification');
  } finally {
    db.close();
  }
}

function handleRead(
  notificationId: string,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const userId = getUserId(req);
  const db = initDb(getDbPath());
  try {
    const result = db.prepare(
      `UPDATE notifications
       SET read_at = ?, status = 'read'
       WHERE id = ? AND user_id = ?`
    ).run(Date.now(), notificationId, userId);

    if (result.changes === 0) {
      badRequest(res, 'Notification not found');
      return;
    }

    jsonOk(res, { ok: true, read_id: notificationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dashboard-notifications] read error: ${msg}\n`);
    badRequest(res, 'Failed to mark notification as read');
  } finally {
    db.close();
  }
}

function handleUnreadCount(req: IncomingMessage, res: ServerResponse): void {
  const userId = getUserId(req);
  const db = initDb(getDbPath());
  try {
    const result = db.prepare(
      `SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND status = 'unread'`
    ).get(userId) as { count: number };

    jsonOk(res, { count: result.count });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dashboard-notifications] unread count error: ${msg}\n`);
    badRequest(res, 'Failed to get unread count');
  } finally {
    db.close();
  }
}

function handleDismissAll(req: IncomingMessage, res: ServerResponse): void {
  const userId = getUserId(req);
  const db = initDb(getDbPath());
  try {
    const result = db.prepare(
      `UPDATE notifications
       SET dismissed_at = ?, status = 'dismissed'
       WHERE user_id = ? AND status != 'dismissed'`
    ).run(Date.now(), userId);

    jsonOk(res, { ok: true, dismissed_count: result.changes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dashboard-notifications] dismiss all error: ${msg}\n`);
    badRequest(res, 'Failed to dismiss all notifications');
  } finally {
    db.close();
  }
}

function handleGetPreferences(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1`);
  const userId = url.searchParams.get('user_id') ?? getUserId(req);
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

    const preferences = rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      notification_type: row.notification_type,
      enabled: row.enabled === 1,
      channels: JSON.parse(row.channels_json) as string[],
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    jsonOk(res, { preferences });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dashboard-notifications] get preferences error: ${msg}\n`);
    badRequest(res, 'Failed to get notification preferences');
  } finally {
    db.close();
  }
}

async function handleUpdatePreference(
  notificationType: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const userId = getUserId(req);
  let body: { enabled?: boolean; channels?: string[]; user_id?: string };
  try {
    body = (await readJsonBody(req)) as { enabled?: boolean; channels?: string[]; user_id?: string };
  } catch (err) {
    badRequest(res, 'Invalid JSON body');
    return;
  }

  const enabled = body.enabled !== undefined ? body.enabled : true;
  const channels = body.channels ?? ['dashboard'];
  const effectiveUserId = body.user_id ?? userId;

  const db = initDb(getDbPath());
  try {
    const now = Date.now();
    const channelsJson = JSON.stringify(channels);

    db.prepare(
      `INSERT INTO notification_preferences (id, user_id, notification_type, enabled, channels_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, notification_type)
       DO UPDATE SET enabled = excluded.enabled, channels_json = excluded.channels_json, updated_at = excluded.updated_at`,
    ).run(
      `pref-${effectiveUserId}-${notificationType}`,
      effectiveUserId,
      notificationType,
      enabled ? 1 : 0,
      channelsJson,
      now,
      now,
    );

    jsonOk(res, { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dashboard-notifications] update preference error: ${msg}\n`);
    badRequest(res, 'Failed to update notification preference');
  } finally {
    db.close();
  }
}

// ── Router export ─────────────────────────────────────────────────────────────

export const dashboardNotificationsRouter: Router = async (req, url, res) => {
  // GET /api/dashboard/notifications
  if (req.method === 'GET' && url.pathname === '/api/dashboard/notifications') {
    handleList(req, res);
    return true;
  }

  // GET /api/dashboard/notifications/unread-count
  if (req.method === 'GET' && url.pathname === '/api/dashboard/notifications/unread-count') {
    handleUnreadCount(req, res);
    return true;
  }

  // GET /api/dashboard/notifications/preferences
  if (req.method === 'GET' && url.pathname === '/api/dashboard/notifications/preferences') {
    handleGetPreferences(req, res);
    return true;
  }

  // POST /api/dashboard/notifications/:id/dismiss
  const dismissMatch = url.pathname.match(DISMISS_RE);
  if (req.method === 'POST' && dismissMatch) {
    handleDismiss(decodeURIComponent(dismissMatch[1] ?? ''), req, res);
    return true;
  }

  // POST /api/dashboard/notifications/:id/read
  const readMatch = url.pathname.match(READ_RE);
  if (req.method === 'POST' && readMatch) {
    handleRead(decodeURIComponent(readMatch[1] ?? ''), req, res);
    return true;
  }

  // POST /api/dashboard/notifications/dismiss-all
  if (req.method === 'POST' && url.pathname === '/api/dashboard/notifications/dismiss-all') {
    handleDismissAll(req, res);
    return true;
  }

  // PATCH /api/dashboard/notifications/preferences/:type
  const preferenceMatch = url.pathname.match(PREFERENCE_RE);
  if (req.method === 'PATCH' && preferenceMatch) {
    await handleUpdatePreference(decodeURIComponent(preferenceMatch[1] ?? ''), req, res);
    return true;
  }

  return false;
};
