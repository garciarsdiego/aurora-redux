// M1 / Wave 1-E (A8 follow-up): boundary test for the 5-minute webhook replay
// window. The existing dashboard-triggers unit test verifies a generic "way
// outside" timestamp (~20 minutes off). This boundary test pins the contract
// at the 300_000 ms edge:
//
//   t - 299_000 ms (just inside)  -> ACCEPTED
//   t - 300_000 ms (on the line)  -> ACCEPTED (Math.abs(...) > WINDOW is strict-greater)
//   t - 301_000 ms (just outside) -> REJECTED
//
// Documenting the equal-to-window case here so future refactors don't
// accidentally flip the comparator from `>` to `>=` without thinking.
//
// We exercise the contract via verifyDashboardWebhookRequest directly (the
// authoritative gate). End-to-end HTTP coverage already exists in the
// existing dashboard-triggers tests.

import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  createDashboardWebhook,
  hmacSignature,
  loadDashboardWebhookBySlug,
  verifyDashboardWebhookRequest,
} from '../../src/mcp/dashboard-triggers.js';

const REPLAY_WINDOW_MS = 5 * 60 * 1000; // mirrors src/mcp/dashboard-triggers.ts:150

describe('webhook replay window boundary (5-minute cap)', () => {
  const keyMaterial = 'daemon-token-for-boundary-tests';

  function setup() {
    const db = initDb(':memory:');
    const created = createDashboardWebhook(db, {
      name: 'boundary',
      slug: 'boundary',
      workspace: 'internal',
      target_ref: 'Process boundary payload',
    }, keyMaterial);
    const webhook = loadDashboardWebhookBySlug(db, 'boundary');
    if (!webhook) throw new Error('test setup failed: webhook not found');
    return { db, webhook, signingSecret: created.signing_secret };
  }

  it('accepts a timestamp 299s in the past (inside the window)', () => {
    const { db, webhook, signingSecret } = setup();
    try {
      const now = Date.UTC(2026, 4, 12, 12, 0, 0);
      const ts = String(now - (REPLAY_WINDOW_MS - 1_000)); // -299s
      const body = '{"event":"boundary"}';
      const signature = hmacSignature(signingSecret, ts, body);
      const result = verifyDashboardWebhookRequest({
        webhook, keyMaterial, timestamp: ts, signature, rawBody: body, now,
      });
      expect(result).toEqual({ ok: true });
    } finally {
      db.close();
    }
  });

  it('accepts a timestamp exactly 300s in the past (boundary — equal to window)', () => {
    // The current implementation uses strict `>` comparison
    // (Math.abs(now - ts) > WINDOW). Equal-to-window is therefore inside.
    // This test pins that behavior so a future refactor cannot silently
    // flip to `>=` (which would reject exact 300s).
    const { db, webhook, signingSecret } = setup();
    try {
      const now = Date.UTC(2026, 4, 12, 12, 0, 0);
      const ts = String(now - REPLAY_WINDOW_MS); // exactly -300s
      const body = '{"event":"boundary"}';
      const signature = hmacSignature(signingSecret, ts, body);
      const result = verifyDashboardWebhookRequest({
        webhook, keyMaterial, timestamp: ts, signature, rawBody: body, now,
      });
      expect(result).toEqual({ ok: true });
    } finally {
      db.close();
    }
  });

  it('rejects a timestamp 301s in the past (just outside the window)', () => {
    const { db, webhook, signingSecret } = setup();
    try {
      const now = Date.UTC(2026, 4, 12, 12, 0, 0);
      const ts = String(now - (REPLAY_WINDOW_MS + 1_000)); // -301s
      const body = '{"event":"boundary"}';
      const signature = hmacSignature(signingSecret, ts, body);
      const result = verifyDashboardWebhookRequest({
        webhook, keyMaterial, timestamp: ts, signature, rawBody: body, now,
      });
      expect(result).toEqual({ ok: false, reason: 'timestamp outside replay window' });
    } finally {
      db.close();
    }
  });

  it('rejects a timestamp 301s in the future (clock-skew attack)', () => {
    // The window is two-sided: replay AND look-ahead. A request claiming a
    // future timestamp beyond the window must also be rejected. This is the
    // mirror of the "old timestamp" case and is the second half of the
    // boundary contract.
    const { db, webhook, signingSecret } = setup();
    try {
      const now = Date.UTC(2026, 4, 12, 12, 0, 0);
      const ts = String(now + (REPLAY_WINDOW_MS + 1_000)); // +301s
      const body = '{"event":"boundary"}';
      const signature = hmacSignature(signingSecret, ts, body);
      const result = verifyDashboardWebhookRequest({
        webhook, keyMaterial, timestamp: ts, signature, rawBody: body, now,
      });
      expect(result).toEqual({ ok: false, reason: 'timestamp outside replay window' });
    } finally {
      db.close();
    }
  });
});
