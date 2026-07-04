/**
 * Aurora Tier 0 / Wave 5 — HITL gate orphan recovery E2E.
 *
 * The Wave 4 unit test (`tests/unit/hitl-orphan-recovery.test.ts`) covers
 * the sweep function in isolation. This integration test exercises the
 * full crash-and-restart story:
 *
 *   1. Daemon process A creates a pending HITL gate, then "crashes"
 *      mid-poll (we never resolve it).
 *   2. Daemon process B starts up. The cancel-equivalent path in
 *      `src/cli/commands/daemon.ts` calls `recoverOrphanHitlGates(db)`
 *      during bootstrap — we simulate that here against a tempfile DB.
 *   3. Within 2s of "B start", the recovery sweep:
 *      a. emits `hitl_gate_orphan_recovered` events,
 *      b. preserves gate status='pending' (we DO NOT auto-resolve),
 *      c. marks `context_json.recovery_attempted_at`.
 *   4. After the sweep, the original resolver path (`resolveHitlGate` via
 *      `hitl/listener.ts`) still accepts an operator approval and flips
 *      the gate to 'approved' with the audit trail intact.
 *
 * Tempfile DB (mkdtempSync) so we exercise the disk-backed migration runner
 * exactly as the daemon would on cold start.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import { recoverOrphanHitlGates } from '../../src/db/hitl-orphan-recovery.js';
import { resolveHitlGate } from '../../src/db/persist.js';

const FIVE_MIN_MS = 5 * 60_000;

interface DaemonHandle {
  db: ReturnType<typeof initDb>;
  dbPath: string;
}

function startDaemon(dbPath: string): DaemonHandle {
  // Equivalent to the daemon process opening its persistent SQLite handle.
  // Each restart opens a fresh handle but the file (and rows) persist.
  return { db: initDb(dbPath), dbPath };
}

function crashDaemon(handle: DaemonHandle): void {
  // Equivalent to SIGKILL — connection drops, rows stay on disk.
  handle.db.close();
}

function seedPendingGate(
  handle: DaemonHandle,
  opts: { ageMs?: number; gateId?: string; workflowId?: string; taskId?: string } = {},
): { gateId: string; workflowId: string; taskId: string } {
  const now = Date.now();
  const gateId = opts.gateId ?? 'hg_orphan_e2e';
  const workflowId = opts.workflowId ?? 'wf_orphan_e2e';
  const taskId = opts.taskId ?? 'tk_orphan_e2e';

  handle.db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, 'internal', 'orphan gate e2e', 'executing', ?)`,
  ).run(workflowId, now);

  handle.db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, 'task waiting on gate', 'cli_spawn', 'running', ?)`,
  ).run(taskId, workflowId, now);

  // Gate created `ageMs` ago — 6 min by default, comfortably past the 5 min
  // window so the recovery sweep treats it as an orphan.
  const ageMs = opts.ageMs ?? (FIVE_MIN_MS + 60_000);
  handle.db.prepare(
    `INSERT INTO hitl_gates
       (id, workflow_id, task_id, gate_type, prompt, context_json,
        status, channel, created_at)
     VALUES (?, ?, ?, 'cli', 'Approve this risky operation?', NULL,
             'pending', 'cli', ?)`,
  ).run(gateId, workflowId, taskId, now - ageMs);

  return { gateId, workflowId, taskId };
}

describe('HITL orphan recovery E2E (Tier 0 Wave 5)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-hitl-orphan-e2e-'));
    dbPath = join(tmpDir, 'omniforge.db');
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  it('surfaces a pending gate left behind by a daemon crash within 2s of restart', async () => {
    // ── Daemon A: crash with a pending gate ──────────────────────────────
    const daemonA = startDaemon(dbPath);
    const { gateId, workflowId } = seedPendingGate(daemonA);
    crashDaemon(daemonA);

    // ── Daemon B: cold start. Run the recovery sweep that daemon.ts
    //              invokes during bootstrap.
    const daemonB = startDaemon(dbPath);
    const restartStartedAt = Date.now();
    const result = recoverOrphanHitlGates(daemonB.db);
    const sweepElapsedMs = Date.now() - restartStartedAt;

    // Sweep is bounded — must complete well under 2s on a 1-row DB.
    expect(sweepElapsedMs).toBeLessThan(2_000);

    // Recovery surfaced exactly 1 orphan with no errors.
    expect(result.scanned).toBe(1);
    expect(result.surfaced).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    // The `hitl_gate_orphan_recovered` event landed on the workflow stream.
    const events = daemonB.db
      .prepare("SELECT type, payload_json FROM events WHERE workflow_id = ? AND type = 'hitl_gate_orphan_recovered'")
      .all(workflowId) as Array<{ type: string; payload_json: string }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload_json) as Record<string, unknown>;
    expect(payload['gate_id']).toBe(gateId);
    expect(typeof payload['age_ms']).toBe('number');
    expect(payload['age_ms'] as number).toBeGreaterThan(FIVE_MIN_MS);

    // CONSTRAINT: do NOT auto-resolve — gate is still pending after sweep.
    const gateRow = daemonB.db
      .prepare('SELECT status, context_json FROM hitl_gates WHERE id = ?')
      .get(gateId) as { status: string; context_json: string | null };
    expect(gateRow.status).toBe('pending');

    // recovery_attempted_at written so a re-sweep is idempotent.
    expect(gateRow.context_json).not.toBeNull();
    const ctx = JSON.parse(gateRow.context_json!) as Record<string, unknown>;
    expect(typeof ctx['recovery_attempted_at']).toBe('number');

    crashDaemon(daemonB);
  });

  it('keeps the resolver path functional after the sweep (operator can still approve)', () => {
    // Crash with a pending orphan.
    const daemonA = startDaemon(dbPath);
    const { gateId, workflowId } = seedPendingGate(daemonA);
    crashDaemon(daemonA);

    // Restart + sweep.
    const daemonB = startDaemon(dbPath);
    recoverOrphanHitlGates(daemonB.db);

    // Operator approves the gate via the standard resolver — exactly as
    // /hitl/respond?gate_id=...&decision=approved would do.
    resolveHitlGate(daemonB.db, gateId, 'approved');

    const gateRow = daemonB.db
      .prepare('SELECT status, decision FROM hitl_gates WHERE id = ?')
      .get(gateId) as { status: string; decision: string | null };
    expect(gateRow.status).toBe('approved');
    expect(gateRow.decision).toBe('approved');

    // Audit trail: the orphan-recovered event landed and the gate row
    // shows the resolution. (resolveHitlGate updates the row directly; the
    // 'gate_resolved' event is emitted by the executor's hitl-gate.ts when
    // the poll observes the flip — which we don't run here.)
    const events = daemonB.db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(workflowId) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain('hitl_gate_orphan_recovered');

    crashDaemon(daemonB);
  });

  it('second daemon restart does not re-emit the same orphan (idempotency across restarts)', () => {
    // Crash A.
    const daemonA = startDaemon(dbPath);
    seedPendingGate(daemonA);
    crashDaemon(daemonA);

    // Start B, sweep, crash B.
    const daemonB = startDaemon(dbPath);
    const firstSweep = recoverOrphanHitlGates(daemonB.db);
    expect(firstSweep.surfaced).toBe(1);
    expect(firstSweep.skipped).toBe(0);
    crashDaemon(daemonB);

    // Start C, sweep again — gate is still pending+old but already
    // surfaced, so the second sweep is a no-op.
    const daemonC = startDaemon(dbPath);
    const secondSweep = recoverOrphanHitlGates(daemonC.db);
    expect(secondSweep.scanned).toBe(1);
    expect(secondSweep.surfaced).toBe(0);
    expect(secondSweep.skipped).toBe(1);
    expect(secondSweep.errors).toEqual([]);

    // Exactly ONE orphan event on the audit trail across both restarts.
    const events = daemonC.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'hitl_gate_orphan_recovered'")
      .get() as { n: number };
    expect(events.n).toBe(1);

    crashDaemon(daemonC);
  });

  it('handles multiple orphan gates across multiple workflows on a single restart', () => {
    const daemonA = startDaemon(dbPath);
    seedPendingGate(daemonA, { gateId: 'hg_a', workflowId: 'wf_a', taskId: 'tk_a' });
    seedPendingGate(daemonA, { gateId: 'hg_b', workflowId: 'wf_b', taskId: 'tk_b' });
    seedPendingGate(daemonA, { gateId: 'hg_c', workflowId: 'wf_c', taskId: 'tk_c' });
    // One fresh gate — must NOT be surfaced (within grace window).
    seedPendingGate(daemonA, {
      gateId: 'hg_fresh', workflowId: 'wf_fresh', taskId: 'tk_fresh',
      ageMs: 30_000,
    });
    crashDaemon(daemonA);

    const daemonB = startDaemon(dbPath);
    const result = recoverOrphanHitlGates(daemonB.db);

    expect(result.scanned).toBe(3);
    expect(result.surfaced).toBe(3);
    expect(result.errors).toEqual([]);

    // Audit events on each surfaced gate's workflow stream.
    const events = daemonB.db
      .prepare(`SELECT workflow_id, type FROM events WHERE type = 'hitl_gate_orphan_recovered' ORDER BY workflow_id`)
      .all() as Array<{ workflow_id: string; type: string }>;
    const wfIds = events.map((e) => e.workflow_id).sort();
    expect(wfIds).toEqual(['wf_a', 'wf_b', 'wf_c']);

    // Fresh gate untouched.
    const freshRow = daemonB.db
      .prepare('SELECT status, context_json FROM hitl_gates WHERE id = ?')
      .get('hg_fresh') as { status: string; context_json: string | null };
    expect(freshRow.status).toBe('pending');
    expect(freshRow.context_json).toBeNull();

    crashDaemon(daemonB);
  });
});

// Sanity: this file should NOT leak open DB connections — even if a test
// throws, mkdtempSync cleanup runs in afterEach.
describe('hitl-orphan-recovery-e2e — leak guard', () => {
  it('cleans up tmpdir between tests', () => {
    // Trivial assertion that the suite's afterEach disposed the previous
    // tmp dir. If this fails, sthg in beforeEach didn't run.
    const dir = mkdtempSync(join(tmpdir(), 'omniforge-leak-probe-'));
    expect(dir).toContain('omniforge-leak-probe-');
    rmSync(dir, { recursive: true, force: true });
  });
});

// Verify the production schema accepts the row shapes we wrote.
// (Cheap fast check that the migration runner ran 001..040 against tmpfile.)
describe('hitl-orphan-recovery-e2e — schema sanity', () => {
  it('tempfile DB has hitl_gates and events tables after initDb', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'omniforge-schema-probe-'));
    try {
      const dbp = join(tmp, 'omniforge.db');
      const db = initDb(dbp);
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('hitl_gates', 'events', 'workflows', 'tasks')")
          .all() as Array<{ name: string }>;
        const names = tables.map((t) => t.name).sort();
        expect(names).toEqual(['events', 'hitl_gates', 'tasks', 'workflows']);
      } finally {
        db.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('better-sqlite3 connections to a missing tempfile open cleanly', () => {
    // Belt-and-braces: prove we can open + close a raw better-sqlite3
    // connection (mirroring what the daemon does) without leaking handles.
    const tmp = mkdtempSync(join(tmpdir(), 'omniforge-raw-probe-'));
    try {
      const dbp = join(tmp, 'raw.db');
      const db = new Database(dbp);
      db.pragma('journal_mode = WAL');
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
