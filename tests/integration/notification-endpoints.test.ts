// Sprint 1 (Notification System): Integration tests for notification endpoints
//
// Tests the HTTP endpoints for notification management including:
// - List notifications
// - Get unread count
// - Dismiss notifications
// - Mark as read
// - Notification preferences

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startHttpMcpServer } from '../../src/mcp/http-server.js';
import { dashboardNotificationsRouter } from '../../src/mcp/routes/dashboard-notifications.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URL } from 'node:url';

const TEST_DB_PATH = join(process.cwd(), 'data', 'test-integration-notifications.db');
const TEST_PORT = 20130;

describe('Notification Endpoints Integration', () => {
  let shutdown: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    // Set test database path + pin the daemon token so the test's Bearer matches.
    process.env.DB_PATH = TEST_DB_PATH;
    process.env.OMNIFORGE_DAEMON_PORT = String(TEST_PORT);
    process.env.OMNIFORGE_DAEMON_TOKEN = 'test-token';

    // Start HTTP server
    shutdown = await startHttpMcpServer(join(process.cwd(), 'data'), TEST_PORT);
  });

  afterEach(async () => {
    // Stop HTTP server
    if (shutdown) {
      await shutdown();
    }

    // Clean up test database
    if (existsSync(TEST_DB_PATH)) {
      try {
        unlinkSync(TEST_DB_PATH);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('GET /api/dashboard/notifications', () => {
    it('should return empty list initially', async () => {
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/dashboard/notifications`, {
        headers: {
          Authorization: `Bearer test-token`,
        },
      });

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.notifications).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('should support status filter', async () => {
      const response = await fetch(
        `http://127.0.0.1:${TEST_PORT}/api/dashboard/notifications?status=unread`,
        {
          headers: {
            Authorization: `Bearer test-token`,
          },
        },
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.notifications).toEqual([]);
    });
  });

  describe('GET /api/dashboard/notifications/unread-count', () => {
    it('should return zero count initially', async () => {
      const response = await fetch(
        `http://127.0.0.1:${TEST_PORT}/api/dashboard/notifications/unread-count`,
        {
          headers: {
            Authorization: `Bearer test-token`,
          },
        },
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.count).toBe(0);
    });
  });

  describe('POST /api/dashboard/notifications/dismiss-all', () => {
    it('should dismiss all notifications successfully', async () => {
      const response = await fetch(
        `http://127.0.0.1:${TEST_PORT}/api/dashboard/notifications/dismiss-all`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer test-token`,
          },
        },
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.dismissed_count).toBe(0);
    });
  });

  describe('GET /api/dashboard/notifications/preferences', () => {
    it('should return default preferences', async () => {
      const response = await fetch(
        `http://127.0.0.1:${TEST_PORT}/api/dashboard/notifications/preferences`,
        {
          headers: {
            Authorization: `Bearer test-token`,
          },
        },
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.preferences).toBeInstanceOf(Array);
      expect(data.preferences.length).toBeGreaterThan(0);
    });
  });

  describe('PATCH /api/dashboard/notifications/preferences/:type', () => {
    it('should update notification preference', async () => {
      const response = await fetch(
        `http://127.0.0.1:${TEST_PORT}/api/dashboard/notifications/preferences/workflow_started`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer test-token`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ enabled: false }),
        },
      );

      expect(response.ok).toBe(true);
      const data = await response.json();
      expect(data.ok).toBe(true);
    });
  });
});