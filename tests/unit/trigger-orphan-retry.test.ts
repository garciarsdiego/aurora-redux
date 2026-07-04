// Aurora Tier 0 / Wave 4 / 0.4 (F-REL-2) — trigger_fires orphan retry sweep.
//
// Verifies the transactional-outbox recovery path:
//   * recordTriggerFire INSERTs a `trigger_fires` row with dispatched_at=NULL.
//   * runTriggerOrphanRetrySweep picks up rows past the grace window,
//     re-attempts dispatch via runDashboardTriggerTarget, and UPDATEs the
//     row to capture workflow_id + dispatched_at on success.
//   * Rows inside the grace window (< 5 min by default) are NOT touched.
//   * Daemon-state singleton `trigger_orphan_sweep` is written every call
//     (the F-REL-2 observability requirement).
//   * Dispatch failure leaves dispatched_at=NULL but records the error
//     (next daemon start retries).
//   * Parent trigger disabled-since-fire is recorded as a soft error.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { getDaemonState } from '../../src/db/persist.js';

const FIVE_MIN_MS = 5 * 60 * 1000;

// Mock the dispatch helper BEFORE importing the module under test. The
// sweep calls runDashboardTriggerTarget which would otherwise pull in the
// entire workflow execution stack.
const dispatchMock = vi.fn();
vi.mock('../../src/mcp/routes/_dashboard-dag-helpers.js', () => ({
  runDashboardTriggerTarget: (...args: unknown[]) => dispatchMock(...args),
}));

interface InsertScheduleOpts {
  id?: string;
  name?: string;
  workspace?: string;
  target_kind?: 'objective' | 'dag';
  target_ref?: string;
  input_payload_json?: string;
  cron_expression?: string;
  is_active?: 0 | 1;
}

function insertSchedule(db: Database.Database, opts: InsertScheduleOpts = {}): string {
  const id = opts.id ?? `sch_${Math.random().toString(16).slice(2, 12)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO dashboard_schedules
       (id, name, workspace, target_kind, target_ref, input_payload_json,
        cron_expression, timezone, next_run_at, is_active, notify_on_json,
        retry_max, retry_backoff_seconds, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'UTC', ?, ?, '[]', 3, 60, ?, ?)`,
  ).run(
    id,
    opts.name ?? 'test-schedule',
    opts.workspace ?? 'internal',
    opts.target_kind ?? 'objective',
    opts.target_ref ?? 'Test objective',
    opts.input_payload_json ?? '{}',
    opts.cron_expression ?? '0 9 * * *',
    now + 60_000,
    opts.is_active ?? 1,
    now,
    now,
  );
  return id;
}

function insertWebhook(db: Database.Database, opts: { id?: string; slug?: string; is_active?: 0 | 1 } = {}): string {
  const id = opts.id ?? `wh_${Math.random().toString(16).slice(2, 12)}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO dashboard_webhook_triggers
       (id, slug, name, workspace, target_kind, target_ref, input_payload_json,
        signing_secret_hash, signing_secret_ciphertext, is_active,
        notify_on_json, created_at, updated_at)
     VALUES (?, ?, 'webhook', 'internal', 'objective', 'ref', '{}',
             'hash', 'cipher', ?, '[]', ?, ?)`,
  ).run(id, opts.slug ?? `slug-${id}`, opts.is_active ?? 1, now, now);
  return id;
}

interface InsertFireOpts {
  schedule_id?: string;
  webhook_id?: string;
  trigger_source?: 'schedule' | 'webhook';
  ageMs?: number;
  workspace?: string;
  target_kind?: 'objective' | 'dag';
  target_ref?: string;
  input_payload_json?: string;
  live_payload?: string | null;
  dispatched_at?: number | null;
  workflow_id?: string | null;
}

function insertFire(db: Database.Database, opts: InsertFireOpts = {}): string {
  const id = `tf_test_${Math.random().toString(16).slice(2, 12)}`;
  const now = Date.now();
  const firedAt = now - (opts.ageMs ?? FIVE_MIN_MS + 60_000);
  const triggerSource = opts.trigger_source
    ?? (opts.webhook_id ? 'webhook' : 'schedule');
  db.prepare(
    `INSERT INTO trigger_fires
       (id, trigger_source, schedule_id, webhook_id, invocation_id, workspace,
        target_kind, target_ref, input_payload_json, live_payload,
        fired_at, dispatched_at, workflow_id, attempt, error, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
  ).run(
    id,
    triggerSource,
    triggerSource === 'schedule' ? (opts.schedule_id ?? null) : null,
    triggerSource === 'webhook' ? (opts.webhook_id ?? null) : null,
    opts.workspace ?? 'internal',
    opts.target_kind ?? 'objective',
    opts.target_ref ?? 'Recover me',
    opts.input_payload_json ?? '{}',
    opts.live_payload ?? null,
    firedAt,
    opts.dispatched_at ?? null,
    opts.workflow_id ?? null,
    firedAt,
  );
  return id;
}

function getFireRow(db: Database.Database, id: string): {
  id: string;
  dispatched_at: number | null;
  workflow_id: string | null;
  error: string | null;
} {
  return db.prepare(
    `SELECT id, dispatched_at, workflow_id, error FROM trigger_fires WHERE id = ?`,
  ).get(id) as { id: string; dispatched_at: number | null; workflow_id: string | null; error: string | null };
}

describe('runTriggerOrphanRetrySweep (Tier 0 Wave 4 0.4 / F-REL-2)', () => {
  let dbPath: string;
  let tmpDir: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-trigger-orphan-'));
    dbPath = join(tmpDir, 'omniforge.db');
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
    dispatchMock.mockReset();
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.clearAllMocks();
  });

  it('picks up a row whose fired_at is older than the 5-minute grace window', async () => {
    const db = initDb(dbPath);
    const scheduleId = insertSchedule(db);
    const fireId = insertFire(db, { schedule_id: scheduleId, ageMs: 10 * 60 * 1000 });
    db.close();

    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_recovered_123' });

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toEqual([fireId]);
    expect(result.failed).toEqual([]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const after = initDb(dbPath);
    try {
      const row = getFireRow(after, fireId);
      expect(row.dispatched_at).not.toBeNull();
      expect(row.workflow_id).toBe('wf_recovered_123');
      expect(row.error).toBeNull();
    } finally {
      after.close();
    }
  });

  it('does NOT pick up a row inside the 5-minute grace window', async () => {
    const db = initDb(dbPath);
    const scheduleId = insertSchedule(db);
    const fireId = insertFire(db, { schedule_id: scheduleId, ageMs: 2 * 60 * 1000 });
    db.close();

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(0);
    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();

    const after = initDb(dbPath);
    try {
      const row = getFireRow(after, fireId);
      expect(row.dispatched_at).toBeNull();
      expect(row.workflow_id).toBeNull();
      expect(row.error).toBeNull();
    } finally {
      after.close();
    }
  });

  it('writes daemon_state.trigger_orphan_sweep on every run (F-REL-2 observability)', async () => {
    const db = initDb(dbPath);
    db.close();

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();
    expect(result.scanned).toBe(0);

    const after = initDb(dbPath);
    try {
      const entry = getDaemonState(after, 'trigger_orphan_sweep');
      expect(entry).not.toBeNull();
      expect(entry!.value['status']).toBe('ok');
      expect(entry!.value['scanned']).toBe(0);
      expect(typeof entry!.value['duration_ms']).toBe('number');
    } finally {
      after.close();
    }
  });

  it('records dispatch failure as `error` without flipping dispatched_at', async () => {
    const db = initDb(dbPath);
    const scheduleId = insertSchedule(db);
    const fireId = insertFire(db, { schedule_id: scheduleId, ageMs: 10 * 60 * 1000 });
    db.close();

    dispatchMock.mockRejectedValueOnce(new Error('omniroute unreachable'));

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ id: fireId, error: 'omniroute unreachable' });

    const after = initDb(dbPath);
    try {
      const row = getFireRow(after, fireId);
      expect(row.dispatched_at).toBeNull();
      expect(row.workflow_id).toBeNull();
      expect(row.error).toBe('omniroute unreachable');

      // daemon_state reflects the partial recovery.
      const entry = getDaemonState(after, 'trigger_orphan_sweep');
      expect(entry).not.toBeNull();
      expect(entry!.value['status']).toBe('partial');
      expect(entry!.value['failed']).toBe(1);
    } finally {
      after.close();
    }
  });

  it('skips fires whose parent schedule was disabled before recovery', async () => {
    const db = initDb(dbPath);
    const scheduleId = insertSchedule(db, { is_active: 0 });
    const fireId = insertFire(db, { schedule_id: scheduleId, ageMs: 10 * 60 * 1000 });
    db.close();

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toEqual([]);
    expect(result.failed[0]?.error).toBe('parent trigger disabled before recovery');
    expect(dispatchMock).not.toHaveBeenCalled();

    const after = initDb(dbPath);
    try {
      const row = getFireRow(after, fireId);
      expect(row.dispatched_at).toBeNull();
      expect(row.error).toBe('parent trigger disabled before recovery');
    } finally {
      after.close();
    }
  });

  it('processes webhook fires with the same recovery path', async () => {
    const db = initDb(dbPath);
    const webhookId = insertWebhook(db);
    const fireId = insertFire(db, {
      trigger_source: 'webhook',
      webhook_id: webhookId,
      ageMs: 10 * 60 * 1000,
      live_payload: '{"event":"push"}',
    });
    db.close();

    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_webhook_recovered' });

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toEqual([fireId]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    const call = dispatchMock.mock.calls[0]?.[0] as { live_payload?: string };
    expect(call?.live_payload).toBe('{"event":"push"}');

    const after = initDb(dbPath);
    try {
      const row = getFireRow(after, fireId);
      expect(row.workflow_id).toBe('wf_webhook_recovered');
    } finally {
      after.close();
    }
  });

  it('flags rows where dispatch returns no workflow_id', async () => {
    const db = initDb(dbPath);
    const scheduleId = insertSchedule(db);
    const fireId = insertFire(db, { schedule_id: scheduleId, ageMs: 10 * 60 * 1000 });
    db.close();

    dispatchMock.mockResolvedValueOnce({ /* missing workflow_id */ });

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.failed).toEqual([{ id: fireId, error: 'dispatch returned no workflow_id' }]);

    const after = initDb(dbPath);
    try {
      const row = getFireRow(after, fireId);
      expect(row.dispatched_at).toBeNull();
      expect(row.error).toBe('dispatch returned no workflow_id');
    } finally {
      after.close();
    }
  });

  it('respects the custom grace window option', async () => {
    const db = initDb(dbPath);
    const scheduleId = insertSchedule(db);
    const fireId = insertFire(db, { schedule_id: scheduleId, ageMs: 30_000 });
    db.close();

    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_custom_grace' });

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    // With a 10-second grace window the 30s-old row IS now an orphan.
    const result = await runTriggerOrphanRetrySweep({ graceMs: 10_000 });

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toEqual([fireId]);

    const after = initDb(dbPath);
    try {
      const row = getFireRow(after, fireId);
      expect(row.workflow_id).toBe('wf_custom_grace');
    } finally {
      after.close();
    }
  });
});

describe('recordTriggerFire / markTriggerFireDispatched (unit)', () => {
  let dbPath: string;
  let tmpDir: string;
  let originalDbPath: string | undefined;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-trigger-rec-'));
    dbPath = join(tmpDir, 'omniforge.db');
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
    db = initDb(dbPath);
  });

  afterEach(() => {
    db.close();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('refuses to record a schedule fire without schedule_id', async () => {
    const { recordTriggerFire } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    expect(() => recordTriggerFire(db, {
      trigger_source: 'schedule',
      workspace: 'internal',
      target_kind: 'objective',
      target_ref: 'x',
      input_payload_json: '{}',
    })).toThrow(/schedule_id/);
  });

  it('refuses to record a webhook fire without webhook_id', async () => {
    const { recordTriggerFire } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    expect(() => recordTriggerFire(db, {
      trigger_source: 'webhook',
      workspace: 'internal',
      target_kind: 'objective',
      target_ref: 'x',
      input_payload_json: '{}',
    })).toThrow(/webhook_id/);
  });
});
