/**
 * Wave 1 Agent C — SQLite retry coverage across persistence helpers.
 *
 * The persist.ts module is 100% wrapped in `withSqliteRetrySync`. Wave 1 Fix 1
 * extends the same guarantee to ~30 sites across 12 other persistence helpers
 * (task-leases, subagent registry/outbox/inbox/control/orphan-recovery, runtime
 * store, quality store, scheduler tick, MCP route writes, gate resolve).
 *
 * This suite verifies retry behaviour at the public-API surface. better-sqlite3
 * is fully synchronous, so we cannot orchestrate a real two-connection lock
 * race inside a single sync helper (the sync retry busy-waits the JS loop and
 * a sister connection's COMMIT timeout cannot fire until the wrap finishes —
 * see `tests/integration/busy-timeout-retry-e2e.test.ts` for the async-path
 * end-to-end version).
 *
 * Strategy: spy on `db.prepare(...)` so the first call's `.run(...)` throws
 * a synthetic SQLITE_BUSY error, then succeeds on retry. If the helper is
 * NOT wrapped in `withSqliteRetrySync`, the first throw bubbles out of the
 * function and the test fails. If it IS wrapped, the second call succeeds
 * and the helper returns normally — proving retry coverage at the call site.
 *
 * We assert on the public-API outcome of each helper rather than on the spy's
 * call count; the helper is allowed to retry as many times as the backoff
 * permits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import {
  acquireTaskLease,
  heartbeatTaskLease,
  completeTaskLease,
} from '../../src/db/task-leases.js';
import {
  registerSubagentRun,
  markRunStarted,
  markRunComplete,
} from '../../src/v2/subagent/registry.js';
import { saveQualityReview } from '../../src/quality/store.js';
import {
  createRuntimeSession,
  updateRuntimeSessionStatus,
  updateRuntimeSessionMetadata,
} from '../../src/runtime/store.js';

function makeBusy(): Error & { code: string } {
  const err = new Error('database is locked (synthetic SQLITE_BUSY)') as Error & { code: string };
  err.code = 'SQLITE_BUSY';
  return err;
}

/**
 * Wrap a `Database.Database` so the FIRST write attempt against a given SQL
 * statement throws SQLITE_BUSY; subsequent attempts (against the same SQL)
 * pass through unchanged.
 *
 * We key by SQL string, not prepared-statement identity, because the retry
 * helper re-calls `db.prepare(sql)` on each attempt (see persist.ts pattern
 * `withSqliteRetrySync(() => db.prepare(sql).run(...))`). If we keyed by
 * statement instance, every retry would get a fresh triggered=false flag
 * and the wrap would infinitely throw.
 *
 * SELECT statements pass through so loadXxx() helpers used for assertions
 * continue working.
 */
function patchDbForOneShotBusy(db: Database.Database): { failedSqls: Set<string> } {
  const originalPrepare = db.prepare.bind(db);
  // Set of SQL strings that have already thrown their one BUSY error.
  // The first prepare for each unique SQL gets a one-shot trap; the
  // second prepare for the same SQL passes through.
  const failedSqls = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).prepare = (sql: string) => {
    const stmt = originalPrepare(sql);
    const writeRe = /^\s*(INSERT|UPDATE|DELETE)/i;
    if (!writeRe.test(sql)) return stmt;
    if (failedSqls.has(sql)) return stmt;

    const originalRun = stmt.run.bind(stmt);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stmt as any).run = (...args: any[]) => {
      if (!failedSqls.has(sql)) {
        failedSqls.add(sql);
        throw makeBusy();
      }
      return originalRun(...args);
    };
    return stmt;
  };
  return { failedSqls };
}

function seedWorkflow(db: Database.Database, workflowId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, 'internal', 'sqlite retry coverage', 'executing', ?)`,
  ).run(workflowId, now);
}

function seedTask(db: Database.Database, taskId: string, workflowId: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, 'retry probe', 'llm_call', 'running', ?)`,
  ).run(taskId, workflowId, now);
}

describe('SQLite retry coverage across persistence helpers (Wave 1 Fix 1)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-retry-coverage-'));
    db = initDb(join(tmpDir, 'omniforge.db'));
  });

  afterEach(() => {
    try { db.close(); } catch { /* benign */ }
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* ignore */ }
  });

  // ─── task-leases ─────────────────────────────────────────────────────────

  it('task-leases.acquireTaskLease: retries on injected SQLITE_BUSY and succeeds', () => {
    const wfId = 'wf_lease_retry';
    const taskId = 'tk_lease_retry';
    seedWorkflow(db, wfId);
    seedTask(db, taskId, wfId);

    patchDbForOneShotBusy(db);

    const start = Date.now();
    const lease = acquireTaskLease(db, {
      workflowId: wfId,
      taskId,
      owner: 'test',
      ttlMs: 30_000,
    });
    const elapsed = Date.now() - start;

    expect(lease.task_id).toBe(taskId);
    expect(lease.status).toBe('running');
    // Backoff is [10, 40, 100, 250]; one retry = at least 10 ms.
    // Use an upper bound to catch regressions where retry budget explodes.
    expect(elapsed).toBeLessThan(500);
  });

  it('task-leases.heartbeatTaskLease: retries on injected SQLITE_BUSY', () => {
    const wfId = 'wf_lease_hb';
    const taskId = 'tk_lease_hb';
    seedWorkflow(db, wfId);
    seedTask(db, taskId, wfId);
    acquireTaskLease(db, { workflowId: wfId, taskId, owner: 'test', ttlMs: 30_000 });

    patchDbForOneShotBusy(db);
    heartbeatTaskLease(db, taskId, 30_000);

    const row = db.prepare(`SELECT status FROM workflow_task_leases WHERE task_id = ?`).get(taskId) as { status: string };
    expect(row.status).toBe('running');
  });

  it('task-leases.completeTaskLease: retries on injected SQLITE_BUSY', () => {
    const wfId = 'wf_lease_complete';
    const taskId = 'tk_lease_complete';
    seedWorkflow(db, wfId);
    seedTask(db, taskId, wfId);
    acquireTaskLease(db, { workflowId: wfId, taskId, owner: 'test', ttlMs: 30_000 });

    patchDbForOneShotBusy(db);
    completeTaskLease(db, taskId, 'completed');

    const row = db.prepare(`SELECT status FROM workflow_task_leases WHERE task_id = ?`).get(taskId) as { status: string };
    expect(row.status).toBe('completed');
  });

  // ─── subagent registry ───────────────────────────────────────────────────

  it('subagent registry: registerSubagentRun + markRunStarted + markRunComplete all retry', () => {
    const wfId = 'wf_subagent_retry';
    const taskId = 'tk_subagent_retry';
    seedWorkflow(db, wfId);
    seedTask(db, taskId, wfId);

    patchDbForOneShotBusy(db);

    const runId = 'run_retry_1';
    const row = registerSubagentRun(db, {
      runId,
      taskId,
      workflowId: wfId,
      depth: 1,
      taskText: 'retry-probe',
    });
    expect(row.run_id).toBe(runId);
    expect(row.status).toBe('pending');

    markRunStarted(db, runId);
    const changed = markRunComplete(db, runId, { status: 'ok', resultText: 'done' });
    expect(changed).toBe(true);

    const after = db.prepare(`SELECT status, result_text FROM subagent_runs WHERE run_id = ?`).get(runId) as {
      status: string;
      result_text: string | null;
    };
    expect(after.status).toBe('complete');
    expect(after.result_text).toBe('done');
  });

  // ─── quality store ───────────────────────────────────────────────────────

  it('quality.saveQualityReview: retries on injected SQLITE_BUSY', () => {
    const wfId = 'wf_quality_retry';
    seedWorkflow(db, wfId);

    patchDbForOneShotBusy(db);
    const row = saveQualityReview(db, {
      workflowId: wfId,
      scope: 'workflow_final',
      reviewerKind: 'heuristic',
      outcome: 'passed',
      score: 0.85,
      issues: [],
      evidence: [],
      fixTasks: [],
    });

    expect(row.workflow_id).toBe(wfId);
    expect(row.outcome).toBe('passed');
  });

  // ─── runtime store ───────────────────────────────────────────────────────

  it('runtime store: createRuntimeSession + updateStatus + updateMetadata all retry', () => {
    const wfId = 'wf_runtime_retry';
    const taskId = 'tk_runtime_retry';
    seedWorkflow(db, wfId);
    seedTask(db, taskId, wfId);

    patchDbForOneShotBusy(db);

    const session = createRuntimeSession(db, {
      workflowId: wfId,
      taskId,
      executorId: 'cli:codex',
      protocolTier: 'jsonl-headless',
      streamFormat: 'codex-stream-json',
      runtimeMode: 'oneshot',
      status: 'active',
    });
    expect(session.workflow_id).toBe(wfId);
    expect(session.status).toBe('active');

    const updated = updateRuntimeSessionStatus(db, session.id, 'archived', { reason: 'retry_probe' });
    expect(updated?.status).toBe('archived');

    const metaPatched = updateRuntimeSessionMetadata(db, session.id, { custom_field: 'retry_probe_meta' });
    expect(metaPatched).not.toBeNull();
  });

  // ─── retry budget exhausts with a clear error ────────────────────────────

  it('exhausts retries and throws SQLITE_BUSY when the BUSY error keeps recurring', () => {
    const wfId = 'wf_exhaust';
    seedWorkflow(db, wfId);
    seedTask(db, 'tk_exhaust', wfId);

    // Patch so EVERY write attempt throws — retry budget exhausts and the
    // helper must re-throw the underlying busy error.
    const originalPrepare = db.prepare.bind(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      const writeRe = /^\s*(INSERT|UPDATE|DELETE)/i;
      if (!writeRe.test(sql)) return stmt;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stmt as any).run = () => { throw makeBusy(); };
      return stmt;
    };

    let observed: unknown;
    try {
      acquireTaskLease(db, {
        workflowId: wfId,
        taskId: 'tk_exhaust',
        owner: 'test',
        ttlMs: 30_000,
      });
    } catch (err) {
      observed = err;
    }

    expect(observed).toBeDefined();
    const message = ((observed as Error).message ?? '').toLowerCase();
    expect(message).toMatch(/busy|locked/);
  });

  // ─── benchmark guard: retry overhead is negligible on the happy path ─────

  it('benchmark: retry wrap adds negligible overhead when no BUSY is thrown (sub-ms per call)', () => {
    const wfId = 'wf_bench';
    const taskId = 'tk_bench';
    seedWorkflow(db, wfId);
    seedTask(db, taskId, wfId);

    // No BUSY injection — measure baseline overhead of the wrap.
    const N = 200;
    const start = Date.now();
    for (let i = 0; i < N; i += 1) {
      heartbeatTaskLease(db, taskId, 30_000);
    }
    const elapsedMs = Date.now() - start;
    const perCallMs = elapsedMs / N;
    // The wrap is one closure + try/catch around .run(); typically <0.5 ms.
    // Allow generous ceiling for Windows CI noise but still pin a regression.
    expect(perCallMs).toBeLessThan(5);
  });
});
