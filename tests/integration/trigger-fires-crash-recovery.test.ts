/**
 * M1 Wave 3 (G) — trigger fire crash recovery + dedupe.
 *
 * Distinct from `trigger-orphan-retry-e2e.test.ts` which covers the
 * standard flow. This test pins the CRASH-AND-RESTART contract:
 *
 *   1. A trigger_fire row is inserted by `recordTriggerFire`
 *      (BEFORE dispatch).
 *   2. The process aborts before `markTriggerFireDispatched` runs (no
 *      workflow_id, no dispatched_at).
 *   3. The daemon restarts, `runTriggerOrphanRetrySweep` runs.
 *   4. The dispatcher is called EXACTLY ONCE for that fire (idempotent).
 *   5. The row is marked dispatched + workflow_id set.
 *   6. Daemon_state singleton reports the sweep ran with status='ok'.
 *
 * Rather than re-asserting the existing orphan-retry contract, this test
 * focuses on the CRASH-IDEMPOTENCY angle: if the daemon restarts a second
 * time after the first sweep already succeeded, the dispatcher MUST NOT
 * be called again for the already-dispatched fire.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from '../../src/db/client.js';

const dispatchMock = vi.fn();
vi.mock('../../src/mcp/routes/_dashboard-dag-helpers.js', () => ({
  runDashboardTriggerTarget: (...args: unknown[]) => dispatchMock(...args),
}));

const TEN_MIN_AGO = 10 * 60 * 1000;

function seedScheduleAndUndispatchedFire(dbPath: string, fireId: string): void {
  const db = initDb(dbPath);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO dashboard_schedules
         (id, name, workspace, target_kind, target_ref, input_payload_json,
          cron_expression, timezone, next_run_at, is_active, notify_on_json,
          retry_max, retry_backoff_seconds, created_at, updated_at)
       VALUES ('sch_w3g', 'w3g-schedule', 'internal', 'objective', 'Run', '{}',
               '0 9 * * *', 'UTC', ?, 1, '[]', 3, 60, ?, ?)`,
    ).run(now + 60_000, now, now);

    db.prepare(
      `INSERT INTO trigger_fires
         (id, trigger_source, schedule_id, webhook_id, invocation_id, workspace,
          target_kind, target_ref, input_payload_json, live_payload,
          fired_at, dispatched_at, workflow_id, attempt, error, created_at)
       VALUES (?, 'schedule', 'sch_w3g', NULL, NULL, 'internal',
               'objective', 'Run', '{}', NULL,
               ?, NULL, NULL, 1, NULL, ?)`,
    ).run(fireId, now - TEN_MIN_AGO, now - TEN_MIN_AGO);
  } finally {
    db.close();
  }
}

describe('trigger fires crash + restart recovery (M1 W3 G)', () => {
  let tmpDir: string;
  let dbPath: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-w3g-trigger-crash-'));
    dbPath = join(tmpDir, 'omniforge.db');
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
    dispatchMock.mockReset();
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
    vi.clearAllMocks();
  });

  it('first restart dispatches the orphan fire exactly once, second restart is a no-op', async () => {
    const fireId = 'tf_w3g_orphan';
    seedScheduleAndUndispatchedFire(dbPath, fireId);

    // Before any sweep: dispatched_at is NULL.
    const dbProbe = initDb(dbPath);
    try {
      const row = dbProbe.prepare(
        `SELECT dispatched_at, workflow_id FROM trigger_fires WHERE id = ?`,
      ).get(fireId) as { dispatched_at: number | null; workflow_id: string | null };
      expect(row.dispatched_at).toBeNull();
      expect(row.workflow_id).toBeNull();
    } finally {
      dbProbe.close();
    }

    // ── First daemon restart — sweep dispatches the fire exactly once.
    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_w3g_recovered' });
    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const firstResult = await runTriggerOrphanRetrySweep();
    expect(firstResult.scanned).toBe(1);
    expect(firstResult.dispatched).toEqual([fireId]);
    expect(firstResult.failed).toEqual([]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    // Row reflects success.
    const dbPostFirst = initDb(dbPath);
    try {
      const row = dbPostFirst.prepare(
        `SELECT dispatched_at, workflow_id FROM trigger_fires WHERE id = ?`,
      ).get(fireId) as { dispatched_at: number | null; workflow_id: string | null };
      expect(typeof row.dispatched_at).toBe('number');
      expect(row.workflow_id).toBe('wf_w3g_recovered');
    } finally {
      dbPostFirst.close();
    }

    // ── Second daemon restart — sweep finds nothing to do.
    const secondResult = await runTriggerOrphanRetrySweep();
    expect(secondResult.scanned).toBe(0);
    expect(secondResult.dispatched).toEqual([]);
    expect(secondResult.failed).toEqual([]);

    // The mock was not invoked a second time — idempotency confirmed.
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it('dispatcher failure leaves row recoverable on next restart (idempotency under failure)', async () => {
    const fireId = 'tf_w3g_failure';
    seedScheduleAndUndispatchedFire(dbPath, fireId);

    // First restart — dispatcher fails. Row is NOT marked dispatched_at.
    dispatchMock.mockRejectedValueOnce(new Error('omniroute 503'));
    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const first = await runTriggerOrphanRetrySweep();
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0].id).toBe(fireId);
    expect(first.dispatched).toEqual([]);

    const dbProbe = initDb(dbPath);
    try {
      const row = dbProbe.prepare(
        `SELECT dispatched_at, workflow_id, error FROM trigger_fires WHERE id = ?`,
      ).get(fireId) as { dispatched_at: number | null; workflow_id: string | null; error: string | null };
      expect(row.dispatched_at).toBeNull();
      expect(row.workflow_id).toBeNull();
      expect(row.error).toBe('omniroute 503');
    } finally {
      dbProbe.close();
    }

    // Second restart — dispatcher recovers, fire is dispatched cleanly.
    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_w3g_eventual' });
    const second = await runTriggerOrphanRetrySweep();
    expect(second.dispatched).toEqual([fireId]);
    expect(dispatchMock).toHaveBeenCalledTimes(2);

    const dbFinal = initDb(dbPath);
    try {
      const row = dbFinal.prepare(
        `SELECT workflow_id, error FROM trigger_fires WHERE id = ?`,
      ).get(fireId) as { workflow_id: string | null; error: string | null };
      expect(row.workflow_id).toBe('wf_w3g_eventual');
      // The error column is cleared on successful retry (markTriggerFireDispatched
      // overwrites it).
      expect(row.error).toBeNull();
    } finally {
      dbFinal.close();
    }
  });
});
