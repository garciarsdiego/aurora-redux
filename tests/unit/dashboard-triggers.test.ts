import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  assertFiveFieldCron,
  computeNextRunAt,
  createDashboardSchedule,
  createDashboardWebhook,
  hmacSignature,
  listDashboardTriggers,
  loadDashboardWebhookBySlug,
  rotateDashboardWebhookSecret,
  verifyDashboardWebhookRequest,
} from '../../src/mcp/dashboard-triggers.js';

describe('dashboard triggers', () => {
  it('accepts only 5-field cron expressions and computes the next UTC tick', () => {
    expect(assertFiveFieldCron('0 9 * * *')).toBe('0 9 * * *');
    expect(() => assertFiveFieldCron('@daily')).toThrow(/aliases/);
    expect(() => assertFiveFieldCron('0 9 * *')).toThrow(/5 fields/);

    const next = computeNextRunAt('0 9 * * *', Date.UTC(2026, 3, 28, 8, 55));
    expect(new Date(next).toISOString()).toBe('2026-04-28T09:00:00.000Z');
  });

  it('stores schedule definitions without needing Supabase cron tables', () => {
    const db = initDb(':memory:');
    try {
      const schedule = createDashboardSchedule(db, {
        name: 'Daily summary',
        workspace: 'internal',
        target_ref: 'Summarize yesterday',
        cron_expression: '0 9 * * *',
        timezone: 'UTC',
      }, Date.UTC(2026, 3, 28, 8, 55));

      expect(schedule.next_run_at).toBe(Date.UTC(2026, 3, 28, 9, 0));
      expect(schedule.target_kind).toBe('objective');
      expect(listDashboardTriggers(db).schedules).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('returns webhook signing secrets once and verifies HMAC with replay protection', () => {
    const db = initDb(':memory:');
    const keyMaterial = 'daemon-token-for-tests';
    try {
      const created = createDashboardWebhook(db, {
        name: 'Client intake',
        slug: 'client-intake',
        workspace: 'internal',
        target_ref: 'Process the payload',
      }, keyMaterial, Date.UTC(2026, 3, 28, 9, 0));

      expect(created.signing_secret).toMatch(/^whsec_/);
      expect(JSON.stringify(listDashboardTriggers(db))).not.toContain(created.signing_secret);

      const webhook = loadDashboardWebhookBySlug(db, 'client-intake');
      expect(webhook).not.toBeNull();
      const timestamp = String(Date.UTC(2026, 3, 28, 9, 1));
      const body = '{"event":"demo"}';
      const signature = hmacSignature(created.signing_secret, timestamp, body);

      expect(verifyDashboardWebhookRequest({
        webhook: webhook!,
        keyMaterial,
        timestamp,
        signature,
        rawBody: body,
        now: Date.UTC(2026, 3, 28, 9, 2),
      })).toEqual({ ok: true });

      expect(verifyDashboardWebhookRequest({
        webhook: webhook!,
        keyMaterial,
        timestamp: String(Date.UTC(2026, 3, 28, 8, 40)),
        signature,
        rawBody: body,
        now: Date.UTC(2026, 3, 28, 9, 2),
      })).toEqual({ ok: false, reason: 'timestamp outside replay window' });

      expect(verifyDashboardWebhookRequest({
        webhook: webhook!,
        keyMaterial,
        timestamp,
        signature: 'sha256=bad',
        rawBody: body,
        now: Date.UTC(2026, 3, 28, 9, 2),
      })).toEqual({ ok: false, reason: 'signature mismatch' });
    } finally {
      db.close();
    }
  });

  it('rotates webhook secrets and invalidates the previous signature immediately', () => {
    const db = initDb(':memory:');
    const keyMaterial = 'daemon-token-for-tests';
    try {
      const created = createDashboardWebhook(db, {
        name: 'Rotation',
        slug: 'rotation',
        workspace: 'internal',
        target_ref: 'Process the payload',
      }, keyMaterial);
      const before = loadDashboardWebhookBySlug(db, 'rotation');
      const timestamp = String(Date.UTC(2026, 3, 28, 9, 1));
      const body = '{"event":"demo"}';
      const oldSignature = hmacSignature(created.signing_secret, timestamp, body);

      expect(verifyDashboardWebhookRequest({
        webhook: before!,
        keyMaterial,
        timestamp,
        signature: oldSignature,
        rawBody: body,
        now: Date.UTC(2026, 3, 28, 9, 1),
      })).toEqual({ ok: true });

      const rotated = rotateDashboardWebhookSecret(db, created.webhook.id, keyMaterial);
      const after = loadDashboardWebhookBySlug(db, 'rotation');

      expect(verifyDashboardWebhookRequest({
        webhook: after!,
        keyMaterial,
        timestamp,
        signature: oldSignature,
        rawBody: body,
        now: Date.UTC(2026, 3, 28, 9, 1),
      })).toEqual({ ok: false, reason: 'signature mismatch' });

      expect(verifyDashboardWebhookRequest({
        webhook: after!,
        keyMaterial,
        timestamp,
        signature: hmacSignature(rotated.signing_secret, timestamp, body),
        rawBody: body,
        now: Date.UTC(2026, 3, 28, 9, 1),
      })).toEqual({ ok: true });
    } finally {
      db.close();
    }
  });
});
