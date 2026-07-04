// Sprint 5.3 (D-H2.066, F-AUDIT gap): webhook secret rotation invalidation.
//
// The audit flagged that no test proved the OLD secret stops working
// after rotateDashboardWebhookSecret. This test exercises the full
// path: create webhook → grab secret → rotate → assert old signature
// is rejected, new signature is accepted.

import { describe, it, expect, beforeEach } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  createDashboardWebhook,
  hmacSignature,
  loadDashboardWebhookBySlug,
  rotateDashboardWebhookSecret,
  verifyDashboardWebhookRequest,
} from '../../src/mcp/dashboard-triggers.js';
import type Database from 'better-sqlite3';

const KEY_MATERIAL = 'test-daemon-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function makeDb(): Database.Database {
  return initDb(':memory:');
}

function nowIsoTs(): string {
  return String(Date.now());
}

describe('webhook secret rotation invalidation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('old secret signature is rejected after rotation; new secret signature is accepted', () => {
    // 1. Create webhook
    const created = createDashboardWebhook(db, {
      name: 'Test webhook',
      workspace: 'internal',
      target_kind: 'objective',
      target_ref: 'do something',
    }, KEY_MATERIAL);

    const oldSecret = created.signing_secret;
    expect(oldSecret).toMatch(/^whsec_[a-f0-9]+$/);

    // 2. Sign a request with the OLD secret
    const ts = nowIsoTs();
    const body = '{"hello":"world"}';
    const oldSignature = hmacSignature(oldSecret, ts, body);

    // 3. Verify works BEFORE rotation
    const webhookBefore = loadDashboardWebhookBySlug(db, created.webhook.slug);
    expect(webhookBefore).not.toBeNull();
    const verifyBefore = verifyDashboardWebhookRequest({
      webhook: webhookBefore!,
      keyMaterial: KEY_MATERIAL,
      timestamp: ts,
      signature: oldSignature,
      rawBody: body,
    });
    expect(verifyBefore.ok).toBe(true);

    // 4. Rotate
    const rotated = rotateDashboardWebhookSecret(db, created.webhook.id, KEY_MATERIAL);
    const newSecret = rotated.signing_secret;
    expect(newSecret).not.toBe(oldSecret);
    expect(rotated.webhook.secret_fingerprint).not.toBe(created.webhook.secret_fingerprint);

    // 5. The OLD signature must now be REJECTED
    const webhookAfter = loadDashboardWebhookBySlug(db, created.webhook.slug);
    expect(webhookAfter).not.toBeNull();
    const verifyOldAfter = verifyDashboardWebhookRequest({
      webhook: webhookAfter!,
      keyMaterial: KEY_MATERIAL,
      timestamp: ts,
      signature: oldSignature,
      rawBody: body,
    });
    expect(verifyOldAfter.ok).toBe(false);
    if (!verifyOldAfter.ok) {
      expect(verifyOldAfter.reason).toBe('signature mismatch');
    }

    // 6. A signature with the NEW secret must be accepted
    const newSignature = hmacSignature(newSecret, ts, body);
    const verifyNew = verifyDashboardWebhookRequest({
      webhook: webhookAfter!,
      keyMaterial: KEY_MATERIAL,
      timestamp: ts,
      signature: newSignature,
      rawBody: body,
    });
    expect(verifyNew.ok).toBe(true);

    db.close();
  });

  it('multiple rotations preserve invalidation chain (every prior secret is rejected)', () => {
    const created = createDashboardWebhook(db, {
      name: 'Multi rotate',
      workspace: 'internal',
      target_kind: 'objective',
      target_ref: 'thing',
    }, KEY_MATERIAL);
    const secrets = [created.signing_secret];

    // Rotate 3 more times, accumulating secrets
    for (let i = 0; i < 3; i++) {
      const r = rotateDashboardWebhookSecret(db, created.webhook.id, KEY_MATERIAL);
      secrets.push(r.signing_secret);
    }

    // After 4 secrets total, only the last one should verify.
    const webhook = loadDashboardWebhookBySlug(db, created.webhook.slug);
    expect(webhook).not.toBeNull();
    const ts = nowIsoTs();
    const body = '{}';

    secrets.slice(0, -1).forEach((staleSecret, idx) => {
      const sig = hmacSignature(staleSecret, ts, body);
      const result = verifyDashboardWebhookRequest({
        webhook: webhook!,
        keyMaterial: KEY_MATERIAL,
        timestamp: ts,
        signature: sig,
        rawBody: body,
      });
      expect(result.ok, `stale secret #${idx} should be rejected`).toBe(false);
    });

    const currentSig = hmacSignature(secrets[secrets.length - 1]!, ts, body);
    const currentResult = verifyDashboardWebhookRequest({
      webhook: webhook!,
      keyMaterial: KEY_MATERIAL,
      timestamp: ts,
      signature: currentSig,
      rawBody: body,
    });
    expect(currentResult.ok).toBe(true);

    db.close();
  });

  it('rotation throws when webhook id does not exist', () => {
    expect(() => rotateDashboardWebhookSecret(db, 'wh_does_not_exist', KEY_MATERIAL))
      .toThrow('webhook not found');
    db.close();
  });
});
