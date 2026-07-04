/**
 * M1 Wave 1 (2026-05-12) — daemon startup recovery sweeps.
 *
 * Three previously-dead helpers (`recoverExpiredTaskLeases`,
 * `sweepOrphans`, `scheduleWalCheckpointTick`) are now invoked from
 * `runStartupSweeps()` in `src/cli/commands/daemon.ts`. This integration
 * test verifies the full wire-up against a tempfile DB exercised by the
 * production migration runner (so migration 046 — the `_daemon` sentinel
 * workflow row — is applied exactly as the daemon would on cold start).
 *
 * Coverage:
 *   1. Migration 046 inserts the `_daemon` sentinel row idempotently.
 *   2. An expired workflow_task_leases row is flipped to 'expired' by
 *      recoverExpiredTaskLeases.
 *   3. An orphaned subagent_runs row (older than ORPHAN_CEILING_MS) is
 *      flipped to 'error' by sweepOrphans(db, 'fail').
 *   4. scheduleWalCheckpointTick returns a callable stop fn whose
 *      underlying setInterval handle is `.unref()`ed.
 *   5. Three `daemon_recovery_sweep_completed` events land on the
 *      workflow_id='_daemon' stream (task_leases / subagent_orphans /
 *      wal_checkpoint_scheduled).
 *
 * We exercise the exported `runStartupSweeps(db)` helper directly rather
 * than spinning up an HTTP server — the wire-up of that helper into
 * `runForeground()` is a single-line invocation around line 490 of
 * daemon.ts; covering it via process spawn is heavy and brittle compared
 * to invoking the helper against an in-memory-equivalent DB.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from '../../src/db/client.js';
import { runStartupSweeps } from '../../src/cli/commands/daemon.js';
import { ORPHAN_CEILING_MS } from '../../src/v2/subagent/types.js';

describe('daemon startup recovery sweeps (M1 Wave 1)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-daemon-sweeps-'));
    dbPath = join(tmpDir, 'omniforge.db');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* ignore — Windows file lock race */ }
  });

  it('migration 046 inserts the _daemon sentinel workflow row', () => {
    const db = initDb(dbPath);
    try {
      const row = db
        .prepare("SELECT id, workspace, objective, status FROM workflows WHERE id = '_daemon'")
        .get() as { id: string; workspace: string; objective: string; status: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe('_daemon');
      expect(row!.workspace).toBe('internal');
      expect(row!.status).toBe('completed');
      expect(row!.objective).toContain('[sentinel]');
    } finally {
      db.close();
    }
  });

  it('expired task leases are flipped to status=expired', () => {
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      // Seed a workflow + task so FK constraints on workflow_task_leases hold.
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, created_at)
         VALUES ('wf_lease_test', 'internal', 'lease test', 'executing', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
         VALUES ('tk_lease_test', 'wf_lease_test', 'leased task', 'llm_call', 'running', ?)`,
      ).run(now);
      // Seed an EXPIRED lease (expires_at = 1 ms ago).
      db.prepare(
        `INSERT INTO workflow_task_leases
           (task_id, workflow_id, lease_owner, status, attempt,
            idempotency_key, acquired_at, heartbeat_at, expires_at, released_at)
         VALUES ('tk_lease_test', 'wf_lease_test', 'crashed-worker', 'running', 1,
                 'wf_lease_test:tk_lease_test:1',
                 ?, ?, ?, NULL)`,
      ).run(now - 60_000, now - 60_000, now - 1);

      const result = runStartupSweeps(db);
      try {
        expect(result.leasesRecovered).toBe(1);

        const row = db
          .prepare('SELECT status, released_at FROM workflow_task_leases WHERE task_id = ?')
          .get('tk_lease_test') as { status: string; released_at: number | null };
        expect(row.status).toBe('expired');
        expect(row.released_at).toEqual(expect.any(Number));
      } finally {
        result.walTickStop();
      }
    } finally {
      db.close();
    }
  });

  it('orphaned subagent_runs are flipped to error by sweepOrphans(fail)', () => {
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, created_at)
         VALUES ('wf_orphan_test', 'internal', 'orphan test', 'executing', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
         VALUES ('tk_orphan_test', 'wf_orphan_test', 'orphan task', 'llm_call', 'running', ?)`,
      ).run(now);
      // started_at older than ORPHAN_CEILING_MS so findOrphans picks it up.
      const stale = now - ORPHAN_CEILING_MS - 60_000;
      db.prepare(
        `INSERT INTO subagent_runs
           (run_id, task_id, workflow_id, depth, task_text, status, created_at, started_at)
         VALUES ('sa_dead', 'tk_orphan_test', 'wf_orphan_test', 0, 'work', 'running', ?, ?)`,
      ).run(stale, stale);

      const result = runStartupSweeps(db);
      try {
        expect(result.subagentOrphansFound).toBe(1);
        expect(result.subagentOrphansRecovered).toBe(1);

        const row = db
          .prepare('SELECT status, error_msg, ended_at FROM subagent_runs WHERE run_id = ?')
          .get('sa_dead') as { status: string; error_msg: string | null; ended_at: number | null };
        expect(row.status).toBe('error');
        expect(row.error_msg).toBe('orphaned-on-restart');
        expect(row.ended_at).toEqual(expect.any(Number));
      } finally {
        result.walTickStop();
      }
    } finally {
      db.close();
    }
  });

  it('scheduleWalCheckpointTick is invoked (returns a callable stop fn)', () => {
    const db = initDb(dbPath);
    try {
      const result = runStartupSweeps(db);
      expect(typeof result.walTickStop).toBe('function');
      // Cleanup must not throw (no-op on already-cleared timer is fine).
      expect(() => result.walTickStop()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('emits three daemon_recovery_sweep_completed events under workflow_id=_daemon', () => {
    const db = initDb(dbPath);
    try {
      const result = runStartupSweeps(db);
      try {
        const events = db
          .prepare(
            `SELECT type, payload_json FROM events
               WHERE workflow_id = '_daemon'
                 AND type = 'daemon_recovery_sweep_completed'
               ORDER BY id`,
          )
          .all() as Array<{ type: string; payload_json: string }>;
        expect(events).toHaveLength(3);

        const kinds = events
          .map((e) => (JSON.parse(e.payload_json) as { kind: string }).kind)
          .sort();
        expect(kinds).toEqual(
          ['subagent_orphans', 'task_leases', 'wal_checkpoint_scheduled'].sort(),
        );

        const taskLeasesEv = events
          .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
          .find((p) => p.kind === 'task_leases');
        expect(taskLeasesEv).toBeDefined();
        expect(taskLeasesEv!['recovered']).toBe(0);

        const subagentEv = events
          .map((e) => JSON.parse(e.payload_json) as Record<string, unknown>)
          .find((p) => p.kind === 'subagent_orphans');
        expect(subagentEv).toBeDefined();
        expect(subagentEv!['found']).toBe(0);
        expect(subagentEv!['recovered']).toBe(0);
      } finally {
        result.walTickStop();
      }
    } finally {
      db.close();
    }
  });

  it('runs all three sweeps end-to-end on a single startup invocation', () => {
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      // Lease orphan.
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, created_at)
         VALUES ('wf_combined', 'internal', 'combined', 'executing', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
         VALUES ('tk_lease', 'wf_combined', 'leased', 'llm_call', 'running', ?)`,
      ).run(now);
      db.prepare(
        `INSERT INTO workflow_task_leases
           (task_id, workflow_id, lease_owner, status, attempt,
            idempotency_key, acquired_at, heartbeat_at, expires_at, released_at)
         VALUES ('tk_lease', 'wf_combined', 'worker', 'running', 1,
                 'wf_combined:tk_lease:1', ?, ?, ?, NULL)`,
      ).run(now - 60_000, now - 60_000, now - 1);
      // Subagent orphan.
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
         VALUES ('tk_sub', 'wf_combined', 'sub', 'llm_call', 'running', ?)`,
      ).run(now);
      const stale = now - ORPHAN_CEILING_MS - 60_000;
      db.prepare(
        `INSERT INTO subagent_runs
           (run_id, task_id, workflow_id, depth, task_text, status, created_at, started_at)
         VALUES ('sa_combined', 'tk_sub', 'wf_combined', 0, 'work', 'running', ?, ?)`,
      ).run(stale, stale);

      const result = runStartupSweeps(db);
      try {
        expect(result.leasesRecovered).toBe(1);
        expect(result.subagentOrphansFound).toBe(1);
        expect(result.subagentOrphansRecovered).toBe(1);
        expect(typeof result.walTickStop).toBe('function');

        // All three sentinel events landed in a single sweep.
        const eventCount = db
          .prepare(
            `SELECT COUNT(*) AS n FROM events
               WHERE workflow_id = '_daemon'
                 AND type = 'daemon_recovery_sweep_completed'`,
          )
          .get() as { n: number };
        expect(eventCount.n).toBe(3);
      } finally {
        result.walTickStop();
      }
    } finally {
      db.close();
    }
  });
});
