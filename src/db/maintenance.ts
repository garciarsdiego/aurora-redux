// Tier 0 / Wave 2 / D — WAL checkpoint maintenance tick.
//
// Aurora opens better-sqlite3 in WAL mode (`src/db/client.ts`). WAL is great
// for concurrent reads but the `<db>-wal` sidecar grows unbounded as long as
// SQLite cannot recycle pages — and the daemon runs 24/7. Without an explicit
// `PRAGMA wal_checkpoint(...)` the WAL file can drift into the GBs over weeks
// of operation, eventually slowing down every read because the page cache
// cannot keep the WAL hot.
//
// This module exposes:
//   1. `walCheckpoint(db, mode='passive')` — one-shot wrapper around the
//      pragma. Returns the busy/log/checkpointed counters or `null` when the
//      DB is not in WAL mode (defensive — don't blow up on `:memory:` or
//      installs that explicitly disable WAL).
//   2. `scheduleWalCheckpointTick(db, intervalMs)` — registers a periodic
//      `setInterval` that fires `walCheckpoint(db, 'passive')` and emits a
//      `wal_checkpoint` event when work happened. Returns a cleanup fn for
//      the daemon shutdown handler.
//
// Design notes:
//   - PASSIVE mode is intentional: it returns immediately if a writer holds
//     the lock, so we never block the daemon's foreground work. Truncation
//     of the WAL file (TRUNCATE mode) would block on writers; not worth it
//     when running every hour — the next tick will catch up.
//   - The interval is `.unref()`ed so a daemon shutdown is not held open by
//     the timer.
//   - Checkpoint failures are non-fatal. Catch + stderr log; the next tick
//     retries. Event emission is best-effort (silent catch) per CLAUDE.md
//     guidance for observability hooks.

import type Database from 'better-sqlite3';
import { insertEvent } from './persist.js';

export interface WalCheckpointResult {
  mode: 'passive' | 'restart' | 'full' | 'truncate';
  /** 0 if successful; non-zero if a writer was holding the lock (PASSIVE). */
  busy: number;
  /** Pages still in the WAL after this checkpoint attempt. */
  log: number;
  /** Pages successfully moved from the WAL into the main DB. */
  checkpointed: number;
}

export type WalCheckpointMode = WalCheckpointResult['mode'];

/**
 * Run a WAL checkpoint. Defaults to PASSIVE mode (non-blocking, idle-friendly).
 *
 * Returns `null` when the database is not in WAL mode — typical for
 * `:memory:` databases or installs that explicitly opted out. Otherwise
 * returns the three counters reported by `PRAGMA wal_checkpoint`.
 */
export function walCheckpoint(
  db: Database.Database,
  mode: WalCheckpointMode = 'passive',
): WalCheckpointResult | null {
  const journalRaw = db.pragma('journal_mode', { simple: true });
  const journalMode =
    typeof journalRaw === 'string' ? journalRaw.toLowerCase() : '';
  if (journalMode !== 'wal') return null;

  // `PRAGMA wal_checkpoint(<mode>)` returns one row with three integer
  // columns. Names depend on the SQLite version; better-sqlite3 maps them to
  // `busy`, `log`, `checkpointed` — we read defensively so a future column
  // rename does not crash the daemon.
  const raw = db.pragma(`wal_checkpoint(${mode})`);
  const row = (Array.isArray(raw) ? raw[0] : raw) as
    | { busy?: number; log?: number; checkpointed?: number }
    | undefined;

  return {
    mode,
    busy: typeof row?.busy === 'number' ? row.busy : 0,
    log: typeof row?.log === 'number' ? row.log : 0,
    checkpointed:
      typeof row?.checkpointed === 'number' ? row.checkpointed : 0,
  };
}

/** One hour. */
export const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Schedule periodic WAL checkpoints on `db`. Returns a cleanup fn that
 * clears the interval — wire it into the daemon shutdown handler.
 *
 * The timer is `.unref()`ed so the daemon process can exit cleanly without
 * waiting for the next tick. Each successful checkpoint that moved work
 * (or has WAL pages remaining) emits a `wal_checkpoint` event under a
 * sentinel `_daemon` workflow_id for observability. Event emission is
 * best-effort: a foreign-key violation (no `_daemon` row exists) or any
 * other failure is swallowed so the maintenance tick never disrupts the
 * daemon.
 */
export function scheduleWalCheckpointTick(
  db: Database.Database,
  intervalMs: number = WAL_CHECKPOINT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      const result = walCheckpoint(db, 'passive');
      if (!result) return;
      if (result.checkpointed > 0 || result.log > 0) {
        try {
          insertEvent(db, {
            workflow_id: '_daemon',
            type: 'wal_checkpoint',
            payload: result,
          });
        } catch {
          // Event emission is best-effort. The events table has a FK on
          // workflows(id) so writing under '_daemon' will fail unless the
          // sentinel row exists; that is acceptable. Stderr is the
          // fallback observability channel.
          process.stderr.write(
            `[daemon] wal_checkpoint ok mode=${result.mode} ` +
              `checkpointed=${result.checkpointed} log=${result.log} busy=${result.busy}\n`,
          );
        }
      }
    } catch (err) {
      // Checkpoint failure is non-fatal. The next tick retries.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[daemon] wal_checkpoint failed: ${msg}\n`);
    }
  }, intervalMs);
  // setInterval in Node returns a Timeout with .unref(); be defensive in
  // case a test runner injects a bare number-typed shim.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
  return () => clearInterval(timer);
}
