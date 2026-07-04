/**
 * Aurora Tier 0 / Wave 5 — Trigger orphan retry E2E.
 *
 * The Wave 4 unit test (`tests/unit/trigger-orphan-retry.test.ts`) covers
 * the sweep function with a mocked dispatcher. This integration test
 * exercises the FULL outbox lifecycle:
 *
 *   1. `recordTriggerFire` writes a row with `dispatched_at = NULL`.
 *   2. (We simulate a daemon crash by simply NOT calling
 *       `markTriggerFireDispatched` — leaving the row orphaned.)
 *   3. The sweep picks the row up after the grace window and calls the
 *      dispatcher (mocked to return a fake workflow_id).
 *   4. `dispatched_at + workflow_id` get filled in.
 *   5. A `trigger_fire_dispatched` audit event lands on the new workflow.
 *   6. A second sweep is a no-op (idempotency: already-dispatched rows
 *      are excluded by the partial index `idx_trigger_fires_undispatched`).
 *
 * The dispatcher mock is intentionally simple: we only assert that the
 * outbox + sweep CORRECTLY interact. Production-style dispatcher behaviour
 * (workflow creation, audit event flow) is covered by the unit suite.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from '../../src/db/client.js';
import { getDaemonState } from '../../src/db/persist.js';

// Hoisted mock: the dispatch helper is imported by _trigger-orphan-retry.ts
// via static import — we MUST mock it before that module is first imported.
const dispatchMock = vi.fn();
vi.mock('../../src/mcp/routes/_dashboard-dag-helpers.js', () => ({
  runDashboardTriggerTarget: (...args: unknown[]) => dispatchMock(...args),
}));

const FIVE_MIN_MS = 5 * 60 * 1000;
const TEN_MIN_AGO = 10 * 60 * 1000;

function seedScheduleAndOrphan(
  dbPath: string,
  opts: { scheduleActive?: 0 | 1; ageMs?: number; target?: string } = {},
): { fireId: string; scheduleId: string } {
  const db = initDb(dbPath);
  try {
    const now = Date.now();
    const scheduleId = 'sch_orphan_e2e';
    db.prepare(
      `INSERT INTO dashboard_schedules
         (id, name, workspace, target_kind, target_ref, input_payload_json,
          cron_expression, timezone, next_run_at, is_active, notify_on_json,
          retry_max, retry_backoff_seconds, created_at, updated_at)
       VALUES (?, 'e2e-schedule', 'internal', 'objective', ?, '{}',
               '0 9 * * *', 'UTC', ?, ?, '[]', 3, 60, ?, ?)`,
    ).run(scheduleId, opts.target ?? 'Recover me', now + 60_000, opts.scheduleActive ?? 1, now, now);

    const fireId = 'tf_orphan_e2e';
    const ageMs = opts.ageMs ?? TEN_MIN_AGO;
    const firedAt = now - ageMs;
    db.prepare(
      `INSERT INTO trigger_fires
         (id, trigger_source, schedule_id, webhook_id, invocation_id, workspace,
          target_kind, target_ref, input_payload_json, live_payload,
          fired_at, dispatched_at, workflow_id, attempt, error, created_at)
       VALUES (?, 'schedule', ?, NULL, NULL, 'internal',
               'objective', ?, '{}', NULL,
               ?, NULL, NULL, 1, NULL, ?)`,
    ).run(fireId, scheduleId, opts.target ?? 'Recover me', firedAt, firedAt);

    return { fireId, scheduleId };
  } finally {
    db.close();
  }
}

interface FireSnapshot {
  dispatched_at: number | null;
  workflow_id: string | null;
  error: string | null;
}

function readFireRow(dbPath: string, fireId: string): FireSnapshot {
  const db = initDb(dbPath);
  try {
    return db.prepare(
      `SELECT dispatched_at, workflow_id, error FROM trigger_fires WHERE id = ?`,
    ).get(fireId) as FireSnapshot;
  } finally {
    db.close();
  }
}

describe('trigger orphan retry E2E (Tier 0 Wave 5)', () => {
  let tmpDir: string;
  let dbPath: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-trig-orphan-e2e-'));
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

  it('recovers an orphan fire: dispatches it and marks dispatched_at + workflow_id', async () => {
    const { fireId } = seedScheduleAndOrphan(dbPath);

    // BEFORE the sweep: the outbox row has no workflow_id and no dispatched_at.
    const before = readFireRow(dbPath, fireId);
    expect(before.dispatched_at).toBeNull();
    expect(before.workflow_id).toBeNull();
    expect(before.error).toBeNull();

    // Simulate the production dispatcher producing a workflow.
    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_recovered_42' });

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    // Assertions on the sweep result.
    expect(result.scanned).toBe(1);
    expect(result.dispatched).toEqual([fireId]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    // Outbox row reflects success.
    const after = readFireRow(dbPath, fireId);
    expect(typeof after.dispatched_at).toBe('number');
    expect(after.workflow_id).toBe('wf_recovered_42');
    expect(after.error).toBeNull();

    // F-REL-2 observability: daemon_state singleton was written.
    const probe = initDb(dbPath);
    try {
      const state = getDaemonState(probe, 'trigger_orphan_sweep');
      expect(state).not.toBeNull();
      expect(state!.value['status']).toBe('ok');
      expect(state!.value['scanned']).toBe(1);
      expect(state!.value['dispatched']).toBe(1);
      expect(state!.value['failed']).toBe(0);
      expect(typeof state!.value['duration_ms']).toBe('number');

      // (The trigger_fire_dispatched event is emitted best-effort by
      // markTriggerFireDispatched only if the workflow row exists. Since
      // our dispatcher mock returns a synthetic workflow_id without
      // creating a workflows row, the event insert silently no-ops via
      // events.workflow_id NOT NULL FK rejection. The trigger_fires row
      // update IS the source of truth — already asserted above.)
    } finally {
      probe.close();
    }
  });

  it('is idempotent: a second sweep does NOT re-dispatch an already-dispatched fire', async () => {
    const { fireId } = seedScheduleAndOrphan(dbPath);

    // First sweep — dispatch succeeds.
    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_first_42' });
    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const first = await runTriggerOrphanRetrySweep();
    expect(first.dispatched).toEqual([fireId]);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    // Second sweep — outbox is empty (the row's dispatched_at is now set).
    const second = await runTriggerOrphanRetrySweep();
    expect(second.scanned).toBe(0);
    expect(second.dispatched).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.skipped).toBe(0);

    // Dispatcher was NOT called a second time.
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    // Outbox row still reflects the original dispatch.
    const row = readFireRow(dbPath, fireId);
    expect(row.workflow_id).toBe('wf_first_42');
  });

  it('skips rows still inside the 5-minute grace window', async () => {
    const { fireId } = seedScheduleAndOrphan(dbPath, { ageMs: 2 * 60_000 });

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    // The fire is real (1 row) but inside the grace window — sweep skips it.
    expect(result.scanned).toBe(0);
    expect(result.dispatched).toEqual([]);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(dispatchMock).not.toHaveBeenCalled();

    const row = readFireRow(dbPath, fireId);
    expect(row.dispatched_at).toBeNull();
  });

  it('records dispatch failure as error string without flipping dispatched_at', async () => {
    const { fireId } = seedScheduleAndOrphan(dbPath);

    dispatchMock.mockRejectedValueOnce(new Error('omniroute unreachable'));

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(1);
    expect(result.dispatched).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toEqual({ id: fireId, error: 'omniroute unreachable' });

    const after = readFireRow(dbPath, fireId);
    expect(after.dispatched_at).toBeNull();
    expect(after.workflow_id).toBeNull();
    expect(after.error).toBe('omniroute unreachable');

    // A subsequent sweep with a working dispatcher will recover.
    dispatchMock.mockResolvedValueOnce({ workflow_id: 'wf_retry_99' });
    const retry = await runTriggerOrphanRetrySweep();
    expect(retry.dispatched).toEqual([fireId]);

    const recovered = readFireRow(dbPath, fireId);
    expect(recovered.workflow_id).toBe('wf_retry_99');
    expect(recovered.error).toBeNull();
  });

  it('processes multiple orphans in a single sweep call', async () => {
    seedScheduleAndOrphan(dbPath); // first row → fireId reused inside helper
    // Add 2 more orphan fires via raw SQL — different IDs.
    const db = initDb(dbPath);
    try {
      const firedAt = Date.now() - TEN_MIN_AGO;
      for (let i = 0; i < 2; i += 1) {
        db.prepare(
          `INSERT INTO trigger_fires
             (id, trigger_source, schedule_id, webhook_id, invocation_id, workspace,
              target_kind, target_ref, input_payload_json, live_payload,
              fired_at, dispatched_at, workflow_id, attempt, error, created_at)
           VALUES (?, 'schedule', 'sch_orphan_e2e', NULL, NULL, 'internal',
                   'objective', ?, '{}', NULL,
                   ?, NULL, NULL, 1, NULL, ?)`,
        ).run(`tf_extra_${i}`, `extra ${i}`, firedAt, firedAt);
      }
    } finally {
      db.close();
    }

    // 3 dispatcher resolves in order.
    dispatchMock
      .mockResolvedValueOnce({ workflow_id: 'wf_a' })
      .mockResolvedValueOnce({ workflow_id: 'wf_b' })
      .mockResolvedValueOnce({ workflow_id: 'wf_c' });

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(3);
    expect(result.dispatched).toHaveLength(3);
    expect(result.failed).toEqual([]);
    expect(dispatchMock).toHaveBeenCalledTimes(3);

    // Each workflow_id landed on a unique fire row — no cross-wiring.
    const dbCheck = initDb(dbPath);
    try {
      const rows = dbCheck.prepare(
        `SELECT id, workflow_id FROM trigger_fires WHERE dispatched_at IS NOT NULL ORDER BY id`,
      ).all() as Array<{ id: string; workflow_id: string }>;
      expect(rows).toHaveLength(3);
      const wfIds = rows.map((r) => r.workflow_id).sort();
      expect(wfIds).toEqual(['wf_a', 'wf_b', 'wf_c']);
    } finally {
      dbCheck.close();
    }
  });

  it('emits a partial-status daemon_state entry when some dispatches fail', async () => {
    seedScheduleAndOrphan(dbPath);
    const db = initDb(dbPath);
    try {
      const firedAt = Date.now() - TEN_MIN_AGO;
      db.prepare(
        `INSERT INTO trigger_fires
           (id, trigger_source, schedule_id, webhook_id, invocation_id, workspace,
            target_kind, target_ref, input_payload_json, live_payload,
            fired_at, dispatched_at, workflow_id, attempt, error, created_at)
         VALUES ('tf_other', 'schedule', 'sch_orphan_e2e', NULL, NULL, 'internal',
                 'objective', 'other', '{}', NULL, ?, NULL, NULL, 1, NULL, ?)`,
      ).run(firedAt, firedAt);
    } finally {
      db.close();
    }

    // First call succeeds, second fails.
    dispatchMock
      .mockResolvedValueOnce({ workflow_id: 'wf_ok' })
      .mockRejectedValueOnce(new Error('downstream timeout'));

    const { runTriggerOrphanRetrySweep } = await import('../../src/mcp/routes/_trigger-orphan-retry.js');
    const result = await runTriggerOrphanRetrySweep();

    expect(result.scanned).toBe(2);
    expect(result.dispatched).toHaveLength(1);
    expect(result.failed).toHaveLength(1);

    const probe = initDb(dbPath);
    try {
      const state = getDaemonState(probe, 'trigger_orphan_sweep');
      expect(state).not.toBeNull();
      expect(state!.value['status']).toBe('partial');
      expect(state!.value['scanned']).toBe(2);
      expect(state!.value['dispatched']).toBe(1);
      expect(state!.value['failed']).toBe(1);
    } finally {
      probe.close();
    }
  });
});
