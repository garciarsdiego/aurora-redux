// F3-2: daemon heartbeat helper tests.
//
// Covers:
//   1. writeDaemonHeartbeat inserts a row keyed `daemon_alive` with pid +
//      alive_at, retrievable via readDaemonHeartbeat with age computed from
//      Date.now().
//   2. Repeated calls upsert (idempotent — no duplicate row error from the
//      PRIMARY KEY conflict, and the latest payload wins).
//
// We intentionally do NOT exercise the 5s setInterval here — that path is
// a thin schedule wrapper around writeDaemonHeartbeat and would require a
// real daemon process to test end-to-end (covered tangentially by the
// existing daemon-graceful-shutdown.test.ts integration test).

import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  writeDaemonHeartbeat,
  readDaemonHeartbeat,
  DAEMON_HEARTBEAT_KEY,
} from '../../src/db/daemon-heartbeat.js';
import { getDaemonState } from '../../src/db/persist.js';

describe('writeDaemonHeartbeat (F3-2)', () => {
  it('writes a daemon_alive row with pid + alive_at, readable via readDaemonHeartbeat', () => {
    const db = initDb(':memory:');
    try {
      // Pre-condition: row does not exist yet (only schedule_tick is seeded
      // by migration 022 — daemon_alive is created lazily on first heartbeat).
      expect(getDaemonState(db, DAEMON_HEARTBEAT_KEY)).toBeNull();

      const now = 1_700_000_000_000;
      const pid = 12345;
      const payload = writeDaemonHeartbeat(db, now, pid);
      expect(payload).toEqual({ pid: 12345, alive_at: now });

      const stored = getDaemonState(db, DAEMON_HEARTBEAT_KEY);
      expect(stored).not.toBeNull();
      expect(stored!.key).toBe(DAEMON_HEARTBEAT_KEY);
      expect(stored!.value).toEqual({ pid: 12345, alive_at: now });
      expect(stored!.updated_at).toBe(now);

      // readDaemonHeartbeat enriches the row with age_ms = readNow - alive_at.
      const readNow = now + 2_500;
      const record = readDaemonHeartbeat(db, readNow);
      expect(record).not.toBeNull();
      expect(record!.pid).toBe(12345);
      expect(record!.alive_at).toBe(now);
      expect(record!.age_ms).toBe(2_500);
    } finally {
      db.close();
    }
  });

  it('upserts on repeated calls — second write replaces first, no duplicate row', () => {
    const db = initDb(':memory:');
    try {
      writeDaemonHeartbeat(db, 1_000, 100);

      // First write: row exists, alive_at = 1000.
      const first = readDaemonHeartbeat(db, 1_000);
      expect(first).not.toBeNull();
      expect(first!.pid).toBe(100);
      expect(first!.alive_at).toBe(1_000);

      // Second write: same pid, advanced alive_at. Must NOT throw on the
      // PRIMARY KEY conflict — the upsert clause owns the resolution.
      writeDaemonHeartbeat(db, 5_000, 100);

      const second = readDaemonHeartbeat(db, 5_000);
      expect(second).not.toBeNull();
      expect(second!.pid).toBe(100);
      expect(second!.alive_at).toBe(5_000);
      expect(second!.age_ms).toBe(0);

      // Third write with a different pid (e.g. daemon was respawned with a
      // new PID under the same DB) — pid should update too.
      writeDaemonHeartbeat(db, 6_000, 200);
      const third = readDaemonHeartbeat(db, 6_500);
      expect(third!.pid).toBe(200);
      expect(third!.alive_at).toBe(6_000);
      expect(third!.age_ms).toBe(500);

      // Sanity: still exactly one row in the table for our key.
      const countRow = db
        .prepare(`SELECT COUNT(*) AS n FROM daemon_state WHERE key = ?`)
        .get(DAEMON_HEARTBEAT_KEY) as { n: number };
      expect(countRow.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
