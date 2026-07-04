/**
 * Wave 1 Agent C — Atomic workflow cancel (Fix 2 / A15).
 *
 * Before this fix: `broadcastCancelToWorkflow` + `UPDATE workflows status='cancelled'`
 * + `setWorkflowMetadata` were three separate writes. Process death between
 * them left the workflow stuck in 'executing' with all tasks 'cancelled' — a
 * state the executor would never recover from.
 *
 * After this fix: the three writes commit inside a single SQLite transaction.
 * If anything throws mid-transaction, SQLite rolls back the entire commit;
 * neither the workflow row nor the task rows are mutated. The retry layer
 * additionally protects the operation from transient SQLITE_BUSY.
 *
 * What we verify:
 *   1. **Happy path**: cancel succeeds → workflow.status='cancelled',
 *      task.status='cancelled', metadata patched, all in one commit.
 *   2. **Crash path**: force the transaction to throw mid-step → rollback
 *      ensures workflow.status stays 'executing' AND task.status stays
 *      'running'. No partial cancel state leaks.
 *   3. **Retry path**: a sister test elsewhere proves SQLITE_BUSY recovery;
 *      here we focus on atomicity of the multi-row write.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import {
  _resetControlRegistry,
  broadcastCancelToWorkflow,
} from '../../src/v2/subagent/control.js';
import {
  loadWorkflowById,
  setWorkflowMetadata,
  insertEvent,
} from '../../src/db/persist.js';
import { withSqliteRetrySync } from '../../src/db/sqlite-retry.js';

interface SeedRefs {
  workflowId: string;
  taskIds: string[];
}

function seedExecutingWorkflowWithRunningTasks(db: Database.Database): SeedRefs {
  const now = Date.now();
  const workflowId = 'wf_cancel_atomic';
  const taskIds = ['tk_atomic_1', 'tk_atomic_2'];

  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, started_at, created_at, metadata)
     VALUES (?, 'internal', 'atomic cancel', 'executing', ?, ?, ?)`,
  ).run(workflowId, now, now, JSON.stringify({ pre_existing: true }));

  for (const taskId of taskIds) {
    db.prepare(
      `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at, started_at)
       VALUES (?, ?, 'work', 'llm_call', 'running', ?, ?)`,
    ).run(taskId, workflowId, now, now);
  }

  return { workflowId, taskIds };
}

/**
 * Mirrors the production `handleWorkflowCancel` body (src/mcp/routes/actor.ts).
 * We replicate it in the test rather than calling the HTTP route directly so
 * we can synthesize a mid-transaction crash. The shape MUST stay identical to
 * the production code path or the test no longer pins the contract.
 *
 * If `mockMidTransactionCrash` is non-null, the supplied function fires
 * BEFORE the `UPDATE workflows status='cancelled'` step inside the
 * transaction — simulating a process death between `broadcastCancelToWorkflow`
 * and the workflow status flip. The transaction throws, SQLite rolls back,
 * and the caller observes a thrown error WITH the workflow + tasks fully
 * restored.
 */
function attemptAtomicCancel(
  db: Database.Database,
  workflowId: string,
  reason: string | null,
  mockMidTransactionCrash: (() => never) | null = null,
): { ok: true; broadcast: ReturnType<typeof broadcastCancelToWorkflow> } | { ok: false; error: Error } {
  const wf = loadWorkflowById(db, workflowId);
  if (!wf) throw new Error(`Workflow not found: ${workflowId}`);

  const now = Date.now();
  let broadcast: ReturnType<typeof broadcastCancelToWorkflow>;

  try {
    const cancelTx = db.transaction(() => {
      broadcast = broadcastCancelToWorkflow(db, workflowId, reason);

      // Inject the crash *between* the two write steps that previously
      // failed to be atomic. If this fires, SQLite rolls back ALL writes
      // inside the txn — including the inner ones performed by
      // broadcastCancelToWorkflow.
      if (mockMidTransactionCrash !== null) {
        mockMidTransactionCrash();
      }

      db.prepare(`UPDATE workflows SET status = 'cancelled', completed_at = ? WHERE id = ?`)
        .run(now, workflowId);

      const existingMeta = wf.metadata ? JSON.parse(wf.metadata) as Record<string, unknown> : {};
      const newMeta = {
        ...existingMeta,
        cancelled_reason: reason,
        cancelled_at: now,
        cancel_propagation: broadcast,
      };
      setWorkflowMetadata(db, workflowId, JSON.stringify(newMeta));
    });
    withSqliteRetrySync(() => cancelTx());

    insertEvent(db, {
      workflow_id: workflowId,
      type: 'workflow_cancelled',
      payload: {
        reason,
        tasks_cancelled: broadcast!.tasks_cancelled,
        controllers_aborted: broadcast!.controllers_aborted,
        messages_cancelled: broadcast!.messages_cancelled,
      },
    });

    return { ok: true, broadcast: broadcast! };
  } catch (err) {
    return { ok: false, error: err as Error };
  }
}

describe('atomic workflow cancel (Wave 1 Fix 2 / A15)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-cancel-atomic-'));
    db = initDb(join(tmpDir, 'omniforge.db'));
    _resetControlRegistry();
  });

  afterEach(() => {
    try { db.close(); } catch { /* benign */ }
    _resetControlRegistry();
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* ignore */ }
  });

  it('happy path: cancels workflow + flips tasks + patches metadata in a single atomic commit', () => {
    const { workflowId, taskIds } = seedExecutingWorkflowWithRunningTasks(db);

    const result = attemptAtomicCancel(db, workflowId, 'integration_test_cancel');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    expect(result.broadcast.tasks_cancelled).toBe(2);

    // Workflow row reached terminal state.
    const wfRow = db.prepare(`SELECT status, completed_at, metadata FROM workflows WHERE id = ?`).get(workflowId) as {
      status: string;
      completed_at: number | null;
      metadata: string | null;
    };
    expect(wfRow.status).toBe('cancelled');
    expect(typeof wfRow.completed_at).toBe('number');
    expect(wfRow.metadata).not.toBeNull();
    const meta = JSON.parse(wfRow.metadata!) as Record<string, unknown>;
    expect(meta['cancelled_reason']).toBe('integration_test_cancel');
    expect(typeof meta['cancelled_at']).toBe('number');
    // Pre-existing metadata is preserved (merge, not replace).
    expect(meta['pre_existing']).toBe(true);
    expect(meta['cancel_propagation']).toMatchObject({ tasks_cancelled: 2 });

    // Every task ended cancelled (never failed).
    for (const taskId of taskIds) {
      const tRow = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      expect(tRow.status).toBe('cancelled');
    }

    // Cancel event was emitted.
    const events = db.prepare(`SELECT type FROM events WHERE workflow_id = ? ORDER BY id`).all(workflowId) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain('task_cancelled_by_workflow');
    expect(types).toContain('workflow_cancelled');
  });

  it('crash path: throw between broadcast and status flip → rollback restores workflow=executing AND tasks=running', () => {
    const { workflowId, taskIds } = seedExecutingWorkflowWithRunningTasks(db);

    // Pin baseline state so we can assert NOTHING was mutated post-rollback.
    const baselineWf = db.prepare(`SELECT status, completed_at, metadata FROM workflows WHERE id = ?`).get(workflowId);
    const baselineTasks = db.prepare(`SELECT id, status FROM tasks WHERE workflow_id = ? ORDER BY id`).all(workflowId);

    // Force a synthetic crash mid-transaction. The injected callback runs
    // AFTER broadcastCancelToWorkflow has updated tasks.status='cancelled'
    // but BEFORE the workflow row + metadata flip. Without the atomic
    // transaction wrap, the test repo's prior behavior was: workflow stuck
    // at 'executing' with all tasks 'cancelled'. With the wrap, SQLite
    // rolls back the entire commit and BOTH stay at baseline.
    const crashError = new Error('synthetic process death mid-cancel');
    const crash = (): never => { throw crashError; };

    const result = attemptAtomicCancel(db, workflowId, 'should_rollback', crash);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.message).toContain('synthetic process death');

    // Workflow row UNCHANGED — still 'executing', metadata unchanged.
    const wfAfter = db.prepare(`SELECT status, completed_at, metadata FROM workflows WHERE id = ?`).get(workflowId);
    expect(wfAfter).toEqual(baselineWf);

    // Tasks UNCHANGED — still 'running'.
    const tasksAfter = db.prepare(`SELECT id, status FROM tasks WHERE workflow_id = ? ORDER BY id`).all(workflowId);
    expect(tasksAfter).toEqual(baselineTasks);
    for (const taskId of taskIds) {
      const tRow = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      expect(tRow.status).toBe('running');
    }

    // No 'workflow_cancelled' event was committed (insertEvent is OUTSIDE
    // the txn, so we never reached it — the throw bailed first).
    const cancelEvents = db
      .prepare(`SELECT type FROM events WHERE workflow_id = ? AND type = 'workflow_cancelled'`)
      .all(workflowId) as Array<{ type: string }>;
    expect(cancelEvents).toHaveLength(0);
  });

  it('retry path: cancel still commits atomically after the second attempt (regression guard)', () => {
    // This guards a subtle bug: if the inner transaction throws an
    // SQLITE_BUSY-like error on the FIRST attempt, the retry layer must
    // re-execute the closure cleanly. We simulate by having the FIRST call
    // through the txn throw a fake busy error, then a state-toggle lets
    // the SECOND attempt succeed.
    const { workflowId, taskIds } = seedExecutingWorkflowWithRunningTasks(db);

    let attempt = 0;
    const flakySpy = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        const busy = new Error('database is locked') as Error & { code: string };
        busy.code = 'SQLITE_BUSY';
        throw busy;
      }
      // Second pass: no-op, the transaction proceeds.
    });

    const result = attemptAtomicCancel(db, workflowId, 'retry_test', flakySpy as unknown as () => never);
    expect(result.ok).toBe(true);
    expect(flakySpy).toHaveBeenCalledTimes(2);

    // Final state is clean cancel.
    const wfRow = db.prepare(`SELECT status FROM workflows WHERE id = ?`).get(workflowId) as { status: string };
    expect(wfRow.status).toBe('cancelled');
    for (const taskId of taskIds) {
      const tRow = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      expect(tRow.status).toBe('cancelled');
    }
  });
});
