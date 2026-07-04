// F3-2 (Sprint 2.6, F-REL-2): daemon liveness heartbeat.
//
// Writes a singleton row into `daemon_state` under key `daemon_alive` every
// few seconds while the daemon is alive. The /health endpoint exposes
// `alive_at_age_ms` (= Date.now() - daemon_alive.alive_at) so external
// pollers (Studio status indicator, `omniforge daemon status`, monitoring
// scripts) can distinguish:
//
//   - "daemon is up and ticking"  → age_ms < ~10s
//   - "daemon is wedged"          → age_ms growing without bound
//   - "daemon was killed"         → age_ms grows past last write forever
//   - "daemon never started"      → row missing (alive_at_age_ms === null)
//
// The schedule_tick row (fired every 60s) cannot serve this purpose because
// some daemons run with schedule_tick disabled or paused; heartbeat is
// independent and ticks at a higher cadence (default 5s). Distinct key,
// distinct semantics.
//
// Schema (migration 022): daemon_state(key TEXT PK, value_json TEXT NOT NULL,
// updated_at INTEGER NOT NULL). Reuses setDaemonState from persist.ts which
// handles the upsert atomically.

import type Database from 'better-sqlite3';
import { setDaemonState, getDaemonState } from './persist.js';

export const DAEMON_HEARTBEAT_KEY = 'daemon_alive';
export const DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;

export interface DaemonHeartbeatPayload {
  pid: number;
  alive_at: number;
}

export interface DaemonHeartbeatRecord extends DaemonHeartbeatPayload {
  age_ms: number;
}

/**
 * Writes (or upserts) the heartbeat row. Idempotent — calling repeatedly with
 * the same db instance simply refreshes `alive_at` and `updated_at`.
 *
 * Throws on db error (caller should catch + log + continue ticking; one
 * missed write is not fatal).
 */
export function writeDaemonHeartbeat(
  db: Database.Database,
  now = Date.now(),
  pid = process.pid,
): DaemonHeartbeatPayload {
  const payload: DaemonHeartbeatPayload = { pid, alive_at: now };
  setDaemonState(db, DAEMON_HEARTBEAT_KEY, payload as unknown as Record<string, unknown>, now);
  return payload;
}

/**
 * Returns the heartbeat row enriched with age (Date.now - alive_at), or null
 * if the row was never written (daemon never started since DB creation).
 *
 * Used by /health to surface `alive_at_age_ms` without leaking pid into
 * unauthenticated responses (caller decides what to expose).
 */
export function readDaemonHeartbeat(
  db: Database.Database,
  now = Date.now(),
): DaemonHeartbeatRecord | null {
  const entry = getDaemonState(db, DAEMON_HEARTBEAT_KEY);
  if (!entry) return null;
  const value = entry.value as Partial<DaemonHeartbeatPayload>;
  const aliveAt = typeof value.alive_at === 'number' ? value.alive_at : entry.updated_at;
  const pid = typeof value.pid === 'number' ? value.pid : -1;
  return {
    pid,
    alive_at: aliveAt,
    age_ms: Math.max(0, now - aliveAt),
  };
}
