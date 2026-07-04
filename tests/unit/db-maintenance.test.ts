// Tier 0 / Wave 2 / D — WAL checkpoint maintenance tick unit tests.
//
// Coverage targets:
//   1. `walCheckpoint` returns a structured result on a real WAL-mode DB.
//   2. `walCheckpoint` returns `null` when the journal is not WAL.
//   3. `scheduleWalCheckpointTick` returns a cleanup fn that clears the timer.
//   4. The interval is `.unref()`ed so it does not pin the event loop.
//   5. Checkpoint exceptions do not propagate out of the tick.

import { describe, it, expect, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  walCheckpoint,
  scheduleWalCheckpointTick,
  WAL_CHECKPOINT_INTERVAL_MS,
} from '../../src/db/maintenance.js';

function makeWalDb(): { db: Database.Database; cleanup: () => void } {
  // WAL mode requires a file-backed DB; the WAL sidecar is created next to it.
  const dir = mkdtempSync(path.join(tmpdir(), 'omniforge-wal-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Minimal schema so we can issue a few INSERTs to grow the WAL.
  db.exec(`CREATE TABLE IF NOT EXISTS scratch (id INTEGER PRIMARY KEY, v TEXT);`);
  return {
    db,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('walCheckpoint', () => {
  let teardown: Array<() => void> = [];
  afterEach(() => {
    for (const fn of teardown.splice(0)) fn();
  });

  it('returns a structured result on a WAL-mode database', () => {
    const { db, cleanup } = makeWalDb();
    teardown.push(cleanup);

    // Force at least one frame into the WAL so `log`/`checkpointed` are non-zero.
    db.exec(`INSERT INTO scratch (v) VALUES ('a');`);
    db.exec(`INSERT INTO scratch (v) VALUES ('b');`);

    const result = walCheckpoint(db, 'passive');

    expect(result).not.toBeNull();
    expect(result!.mode).toBe('passive');
    expect(typeof result!.busy).toBe('number');
    expect(typeof result!.log).toBe('number');
    expect(typeof result!.checkpointed).toBe('number');
    expect(result!.busy).toBeGreaterThanOrEqual(0);
  });

  it('returns null when journal_mode is not WAL', () => {
    // `:memory:` defaults to memory journal, never WAL.
    const db = new Database(':memory:');
    db.pragma('journal_mode = MEMORY');
    teardown.push(() => db.close());

    expect(walCheckpoint(db, 'passive')).toBeNull();
  });

  it('accepts every checkpoint mode without throwing', () => {
    const { db, cleanup } = makeWalDb();
    teardown.push(cleanup);
    db.exec(`INSERT INTO scratch (v) VALUES ('x');`);

    for (const mode of ['passive', 'restart', 'full', 'truncate'] as const) {
      const result = walCheckpoint(db, mode);
      expect(result).not.toBeNull();
      expect(result!.mode).toBe(mode);
    }
  });
});

describe('scheduleWalCheckpointTick', () => {
  let teardown: Array<() => void> = [];
  afterEach(() => {
    for (const fn of teardown.splice(0)) fn();
    vi.useRealTimers();
  });

  it('returns a cleanup function', () => {
    const { db, cleanup } = makeWalDb();
    teardown.push(cleanup);

    const stop = scheduleWalCheckpointTick(db);
    expect(typeof stop).toBe('function');
    stop();
  });

  it('exposes a sensible default interval (1 hour)', () => {
    expect(WAL_CHECKPOINT_INTERVAL_MS).toBe(60 * 60 * 1000);
  });

  it('unref()s the underlying timer so it does not pin the event loop', () => {
    const unrefSpy = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, 'setInterval')
      // The real Timeout has `.unref()`; we substitute a stub so we can
      // observe the call without keeping a live timer alive.
      .mockImplementation(((..._args: unknown[]) => {
        return { unref: unrefSpy, ref: () => undefined } as unknown as NodeJS.Timeout;
      }) as typeof setInterval);

    const { db, cleanup } = makeWalDb();
    teardown.push(cleanup);

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    const stop = scheduleWalCheckpointTick(db);
    expect(unrefSpy).toHaveBeenCalledOnce();

    // Cleanup fn should clearInterval the same handle setInterval returned.
    stop();
    expect(clearIntervalSpy).toHaveBeenCalledOnce();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('runs the checkpoint on each tick', () => {
    vi.useFakeTimers();
    const { db, cleanup } = makeWalDb();
    teardown.push(cleanup);
    // Seed work so the checkpoint actually has pages to move.
    db.exec(`INSERT INTO scratch (v) VALUES ('seed');`);

    // Use a tiny interval to make the test fast.
    const intervalMs = 5_000;
    const stop = scheduleWalCheckpointTick(db, intervalMs);
    teardown.push(stop);

    const pragmaSpy = vi.spyOn(db, 'pragma');

    vi.advanceTimersByTime(intervalMs);
    // Each tick reads journal_mode (1 call) + invokes wal_checkpoint (1 call).
    // We don't pin the count exactly because future internal callers might
    // share this DB; only assert the checkpoint pragma fired.
    const calls = pragmaSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.startsWith('wal_checkpoint'))).toBe(true);

    pragmaSpy.mockRestore();
  });

  it('does not propagate errors when the checkpoint pragma throws', () => {
    vi.useFakeTimers();
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const { db, cleanup } = makeWalDb();
    teardown.push(cleanup);

    const pragmaSpy = vi.spyOn(db, 'pragma').mockImplementation(((sql: string) => {
      if (typeof sql === 'string' && sql.startsWith('wal_checkpoint')) {
        throw new Error('synthetic checkpoint failure');
      }
      // journal_mode probe → return WAL so the checkpoint path runs.
      return 'wal';
    }) as Database.Database['pragma']);

    const intervalMs = 1_000;
    const stop = scheduleWalCheckpointTick(db, intervalMs);
    teardown.push(stop);

    // Should not throw.
    expect(() => vi.advanceTimersByTime(intervalMs)).not.toThrow();

    const stderr = stderrSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(stderr).toContain('wal_checkpoint failed');
    expect(stderr).toContain('synthetic checkpoint failure');

    pragmaSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
