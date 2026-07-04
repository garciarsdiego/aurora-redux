// Sprint 5.5 (D-H2.066, F-AUDIT gap): schedule tick failure recovery.
//
// The audit flagged that no test covered the case where runDashboardScheduleTickOnce
// throws — operator should still see the error in daemon_state['schedule_tick']
// and the next tick should be allowed to proceed (no stuck state).
//
// Sprint 2.6 wired the persist-on-finally; this test exercises it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../../src/db/client.js';
import { getDaemonState, setDaemonState } from '../../src/db/persist.js';

describe('schedule tick failure recovery (F-REL-2)', () => {
  let dbPath: string;
  let tmpDir: string;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-tick-test-'));
    dbPath = join(tmpDir, 'omniforge.db');
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
  });

  afterEach(() => {
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('persists schedule_tick=ok with metrics after a clean tick', async () => {
    // Initialize DB so the migrations that create daemon_state run.
    const db = initDb(dbPath);
    db.close();

    const { runDashboardScheduleTickOnce } = await import('../../src/mcp/routes/_schedule-tick.js');

    const result = await runDashboardScheduleTickOnce();
    expect(result.processed).toBe(0); // no schedules due

    const after = initDb(dbPath);
    try {
      const entry = getDaemonState(after, 'schedule_tick');
      expect(entry).not.toBeNull();
      expect(entry!.value['status']).toBe('ok');
      expect(typeof entry!.value['duration_ms']).toBe('number');
      expect(entry!.value['error']).toBeNull();
      expect(entry!.value['processed']).toBe(0);
    } finally {
      after.close();
    }
  });

  it('persist round-trips error status (recoverable singleton row)', () => {
    const db = initDb(dbPath);
    try {
      setDaemonState(db, 'schedule_tick', {
        status: 'error',
        processed: 0,
        duration_ms: 12,
        error: 'simulated catastrophic failure',
      });
      const entry = getDaemonState(db, 'schedule_tick');
      expect(entry).not.toBeNull();
      expect(entry!.value['status']).toBe('error');
      expect(entry!.value['error']).toBe('simulated catastrophic failure');
    } finally {
      db.close();
    }
  });

  it('subsequent tick after error overwrites schedule_tick with ok status (recovery)', async () => {
    const db = initDb(dbPath);
    setDaemonState(db, 'schedule_tick', {
      status: 'error',
      processed: 0,
      duration_ms: 5,
      error: 'prior failure',
    });
    db.close();

    const { runDashboardScheduleTickOnce } = await import('../../src/mcp/routes/_schedule-tick.js');
    await runDashboardScheduleTickOnce();

    const after = initDb(dbPath);
    try {
      const entry = getDaemonState(after, 'schedule_tick');
      expect(entry).not.toBeNull();
      expect(entry!.value['status']).toBe('ok');
      expect(entry!.value['error']).toBeNull();
    } finally {
      after.close();
    }
  });
});
