/**
 * Aurora Tier 0 / Wave 5 — busy_timeout retry under real contention.
 *
 * The Wave 2 unit test (`tests/unit/db-concurrency.test.ts`) verifies the
 * retry helper against an injected SQLITE_BUSY error. This integration
 * test opens TWO real better-sqlite3 connections to the same tempfile DB
 * and exercises the contention path end-to-end:
 *
 *   Connection A: begins a transaction, holds the write lock by inserting
 *                 rows but NOT committing for a measurable window.
 *   Connection B: tries to INSERT via `withSqliteRetrySync` which must
 *                 a) retry on the bounded backoff schedule,
 *                 b) either succeed once A commits inside ~400ms, or
 *                 c) propagate a clear SQLITE_BUSY error after exhausting
 *                    retries.
 *
 * Why this is meaningful vs the unit test: the production daemon runs the
 * HTTP server (one writer) alongside the executor (another writer) and
 * the schedule tick (a third writer). All three speak to the same SQLite
 * file. The retry helper guarantees forward progress as long as the lock
 * holder releases within the backoff window. This test pins that guarantee
 * with a REAL contention scenario rather than a mocked error.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import { withSqliteRetry, withSqliteRetrySync, isSqliteBusy } from '../../src/db/sqlite-retry.js';

function openSecondConnection(dbPath: string): Database.Database {
  // Same pragma stack as initDb so the second connection behaves like the
  // production daemon's secondary writer. We deliberately set a SHORTER
  // busy_timeout than 5s so the test can observe the retry behavior — the
  // production 5s would just absorb the contention into the driver's own
  // wait and never reach our retry path.
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 50ms — much smaller than the retry backoff schedule [10, 40, 100, 250]
  // so when the prepared INSERT collides with connection A's lock, the
  // driver throws SQLITE_BUSY quickly and the retry layer sees it.
  db.pragma('busy_timeout = 50');
  return db;
}

interface SeedRefs {
  workflowId: string;
}

function seedWorkflow(db: Database.Database): SeedRefs {
  const now = Date.now();
  const workflowId = `wf_busy_${Date.now()}`;
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, 'internal', 'busy timeout e2e', 'executing', ?)`,
  ).run(workflowId, now);
  return { workflowId };
}

describe('busy_timeout retry under contention (Tier 0 Wave 5)', () => {
  let tmpDir: string;
  let dbPath: string;
  let connA: Database.Database;
  let connB: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-busy-e2e-'));
    dbPath = join(tmpDir, 'omniforge.db');
    // First open via initDb so migrations run.
    connA = initDb(dbPath);
    // Subsequent connection — bypasses initDb so migrations don't run twice.
    connB = openSecondConnection(dbPath);
  });

  afterEach(() => {
    try { connA.close(); } catch { /* already closed */ }
    try { connB.close(); } catch { /* already closed */ }
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  it('connection B retries and SUCCEEDS once connection A releases its write lock (async helper)', async () => {
    // We MUST use the async retry helper for this scenario because the
    // sync helper uses a busy-wait spinlock between retries, which would
    // block the JS event loop and prevent connection A's setTimeout(COMMIT)
    // callback from firing. The async helper yields to the loop on every
    // sleep, so A's commit lands while B is waiting.
    const { workflowId } = seedWorkflow(connA);

    // Connection A acquires the write lock by beginning an IMMEDIATE
    // transaction. We hold it for ~150ms then commit. Within that window
    // connection B's insert MUST block + retry.
    let aCommittedAt = 0;
    const lockHoldStart = Date.now();
    connA.exec('BEGIN IMMEDIATE');
    connA.prepare(`UPDATE workflows SET completed_at = ? WHERE id = ?`).run(Date.now(), workflowId);

    // Release after 150ms.
    const holdLock = new Promise<void>((resolve) => {
      setTimeout(() => {
        try {
          connA.exec('COMMIT');
          aCommittedAt = Date.now();
        } catch (err) {
          // Surface but don't kill the test.
          process.stderr.write(`[busy-timeout-e2e] commit error: ${(err as Error).message}\n`);
        }
        resolve();
      }, 150);
    });

    // Connection B retries via the ASYNC helper — sleeps yield to the
    // event loop so A's commit callback can fire.
    const bAttempts: number[] = [];
    const bStartedAt = Date.now();
    await withSqliteRetry(() => {
      connB.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES (?, NULL, ?, ?, ?)`,
      ).run(workflowId, 'contention_probe', '{}', Date.now());
    }, {
      // Generous schedule: [50, 100, 200, 400] = up to ~750ms patience,
      // comfortably more than A's 150ms hold.
      backoffMs: [50, 100, 200, 400],
      onRetry: (attempt) => bAttempts.push(attempt),
    });
    const bSucceededAt = Date.now();

    await holdLock;
    expect(aCommittedAt).toBeGreaterThan(0);
    expect(aCommittedAt - lockHoldStart).toBeGreaterThanOrEqual(140);

    // M1-W3-D (theater cleanup): assert AT LEAST one retry fired (proves
    // the BUSY → wait → retry path was exercised) AND that the first
    // observed attempt number is 0 (the helper passes the *attempt index*
    // to onRetry, so attempt 0 means the very first failure → retry pair).
    // Note: we cannot tighten to `>= 2` because the underlying driver's
    // busy_timeout=50ms can synchronously block B's first retry past A's
    // 150ms release window, producing a 1-retry success path. The retry
    // semantics are still verifiably exercised either way.
    expect(bAttempts.length).toBeGreaterThanOrEqual(1);
    expect(bAttempts[0]).toBe(0);
    // Additional regression guard: every recorded retry attempt index is
    // strictly increasing — proves the onRetry callback receives the
    // attempt counter, not a constant.
    for (let i = 1; i < bAttempts.length; i += 1) {
      expect(bAttempts[i]).toBe(bAttempts[i - 1]! + 1);
    }
    // B's success landed AT OR AFTER A committed.
    expect(bSucceededAt).toBeGreaterThanOrEqual(aCommittedAt - 50);
    // B's total elapsed must be bounded — generous ceiling to absorb CI
    // scheduler jitter (Windows runners are noisy).
    expect(bSucceededAt - bStartedAt).toBeLessThan(1_500);

    // The event row landed on the shared file.
    const probe = connA.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND type = 'contention_probe'`,
    ).get(workflowId) as { n: number };
    expect(probe.n).toBe(1);
  });

  it('connection B FAILS with a clear SQLITE_BUSY error after exhausting retries', async () => {
    const { workflowId } = seedWorkflow(connA);

    // Hold the lock indefinitely (longer than the retry budget). We
    // explicitly DO NOT commit until the test cleans up.
    connA.exec('BEGIN IMMEDIATE');
    connA.prepare(`UPDATE workflows SET completed_at = ? WHERE id = ?`).run(Date.now(), workflowId);

    let observedError: unknown;
    try {
      // Tight retry budget: [5, 5, 5] → ~15ms total wait. A holds the lock
      // for the entire test duration, so this MUST exhaust + throw.
      withSqliteRetrySync(() => {
        connB.prepare(
          `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
           VALUES (?, NULL, 'should_fail', '{}', ?)`,
        ).run(workflowId, Date.now());
      }, { backoffMs: [5, 5, 5], retries: 3 });
    } catch (err) {
      observedError = err;
    }

    // Release A so afterEach can close cleanly.
    connA.exec('ROLLBACK');

    expect(observedError).toBeDefined();
    expect(isSqliteBusy(observedError)).toBe(true);
    const message = (observedError as Error).message;
    expect(typeof message).toBe('string');
    expect(message.toLowerCase()).toMatch(/busy|locked/);

    // The row did NOT land.
    const probe = connA.prepare(
      `SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND type = 'should_fail'`,
    ).get(workflowId) as { n: number };
    expect(probe.n).toBe(0);
  });

  it('isSqliteBusy correctly classifies the production error shape from the driver', async () => {
    // Make a real driver-level SQLITE_BUSY happen by holding the lock from
    // A, then driving B with NO retry wrapper. The driver returns its own
    // typed error which `isSqliteBusy` must accept as retry-eligible.
    const { workflowId } = seedWorkflow(connA);
    connA.exec('BEGIN IMMEDIATE');
    connA.prepare(`UPDATE workflows SET completed_at = ? WHERE id = ?`).run(Date.now(), workflowId);

    let rawErr: unknown;
    try {
      connB.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES (?, NULL, 'unwrapped', '{}', ?)`,
      ).run(workflowId, Date.now());
    } catch (err) {
      rawErr = err;
    }
    connA.exec('ROLLBACK');

    expect(rawErr).toBeDefined();
    // The driver may surface this as either:
    //   err.code === 'SQLITE_BUSY' / 'SQLITE_LOCKED'
    //   err.message contains 'database is locked' / 'SQLITE_BUSY'
    // Both shapes pass isSqliteBusy.
    expect(isSqliteBusy(rawErr)).toBe(true);
  });

  it('a non-busy error (UNIQUE constraint) does NOT trigger a retry', () => {
    const { workflowId } = seedWorkflow(connA);
    // Make a task row that we will then try to re-insert with the same PK,
    // tripping UNIQUE. That MUST throw immediately — no retries.
    connA.prepare(
      `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
       VALUES ('tk_dup', ?, 'first', 'llm_call', 'pending', ?)`,
    ).run(workflowId, Date.now());

    let attempts = 0;
    expect(() => {
      withSqliteRetrySync(() => {
        attempts += 1;
        connB.prepare(
          `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
           VALUES ('tk_dup', ?, 'second', 'llm_call', 'pending', ?)`,
        ).run(workflowId, Date.now());
      }, { backoffMs: [5, 5, 5], retries: 3 });
    }).toThrow(/UNIQUE/i);

    // Exactly ONE attempt — the helper saw the error wasn't a BUSY and bailed.
    expect(attempts).toBe(1);
  });
});
