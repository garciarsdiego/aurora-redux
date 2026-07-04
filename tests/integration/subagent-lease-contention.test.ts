/**
 * M1 Wave 3 (D) — subagent / task lease contention.
 *
 * `workflow_task_leases` is a single-row-per-task table guarded by an ON
 * CONFLICT(task_id) DO UPDATE clause. When two processes race to acquire
 * a lease for the same task, the second writer SHOULD win cleanly (its
 * attempt counter increments + idempotency_key changes) — the conflict
 * does not throw, it overwrites.
 *
 * The cancel scenario: if a worker process A acquires lease attempt=1,
 * then a sibling worker B acquires attempt=2 (because A crashed or the
 * lease was expired), A's later cancel based on the OLD idempotency_key
 * MUST be ignored — it does NOT touch B's lease.
 *
 * Pin these contracts:
 *   1. Two parallel `acquireTaskLease` calls do not throw; the LATER call
 *      wins and bumps `attempt` (last-write-wins under ON CONFLICT).
 *   2. After lease expiry (`expires_at <= now`), a fresh acquire creates
 *      attempt=N+1.
 *   3. An old-owner mutation keyed by stale `idempotency_key` does not
 *      affect the current lease (we filter by idempotency_key + status).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import {
  acquireTaskLease,
  loadTaskLease,
  recoverExpiredTaskLeases,
} from '../../src/db/task-leases.js';

describe('subagent / task lease contention (M1 W3 D)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    const now = Date.now();
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES ('wf_lease_contend', 'internal', 'lease contention', 'executing', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
       VALUES ('tk_lease_contend', 'wf_lease_contend', 't', 'llm_call', 'running', ?)`,
    ).run(now);
  });

  afterEach(() => { db.close(); });

  it('two parallel acquires for the same task land cleanly (last write wins)', () => {
    // Both calls return — neither throws on the unique-key conflict. SQLite
    // is single-threaded inside better-sqlite3 (one writer at a time on the
    // same handle), but the ON CONFLICT clause makes the operation idempotent
    // and the LATER acquire bumps `attempt`.
    const ownerA = 'worker-A';
    const ownerB = 'worker-B';

    const leaseA = acquireTaskLease(db, {
      workflowId: 'wf_lease_contend',
      taskId: 'tk_lease_contend',
      owner: ownerA,
      ttlMs: 30_000,
    });
    expect(leaseA.attempt).toBe(1);
    expect(leaseA.lease_owner).toBe(ownerA);

    const leaseB = acquireTaskLease(db, {
      workflowId: 'wf_lease_contend',
      taskId: 'tk_lease_contend',
      owner: ownerB,
      ttlMs: 30_000,
    });
    expect(leaseB.attempt).toBe(2);
    expect(leaseB.lease_owner).toBe(ownerB);
    expect(leaseB.idempotency_key).not.toBe(leaseA.idempotency_key);

    // Only one row exists (PK on task_id).
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM workflow_task_leases WHERE task_id = ?`)
      .get('tk_lease_contend') as { n: number }).n;
    expect(count).toBe(1);

    // The persisted row reflects B.
    const persisted = loadTaskLease(db, 'tk_lease_contend');
    expect(persisted).not.toBeNull();
    expect(persisted!.lease_owner).toBe(ownerB);
    expect(persisted!.attempt).toBe(2);
  });

  it('expired lease is recoverable: re-acquire creates a fresh attempt and clears expired status', () => {
    // Acquire then back-date expires_at so the recovery sweep treats it as
    // expired. After recoverExpiredTaskLeases runs, a new acquire bumps
    // `attempt` to N+1 and resets status to 'running'.
    const initial = acquireTaskLease(db, {
      workflowId: 'wf_lease_contend',
      taskId: 'tk_lease_contend',
      owner: 'crashed-A',
      ttlMs: 30_000,
    });
    expect(initial.status).toBe('running');

    // Force-expire by rewriting expires_at to 1 ms ago.
    db.prepare(
      `UPDATE workflow_task_leases SET expires_at = ? WHERE task_id = ?`,
    ).run(Date.now() - 1, 'tk_lease_contend');

    const recovered = recoverExpiredTaskLeases(db, Date.now());
    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('expired');

    // New owner picks up.
    const fresh = acquireTaskLease(db, {
      workflowId: 'wf_lease_contend',
      taskId: 'tk_lease_contend',
      owner: 'worker-B',
      ttlMs: 30_000,
    });
    expect(fresh.attempt).toBe(2);
    expect(fresh.status).toBe('running');
    expect(fresh.lease_owner).toBe('worker-B');
  });

  it('cancel/release from old owner (stale idempotency_key) is ignored', () => {
    // Worker A holds lease attempt=1. A "crashes" — its dying release call
    // (UPDATE ... WHERE idempotency_key = '...:1') must not affect worker
    // B's lease attempt=2.
    const leaseA = acquireTaskLease(db, {
      workflowId: 'wf_lease_contend',
      taskId: 'tk_lease_contend',
      owner: 'worker-A',
      ttlMs: 30_000,
    });
    const staleKey = leaseA.idempotency_key;

    // Force expiry + recovery so worker B can acquire attempt=2 cleanly.
    db.prepare(
      `UPDATE workflow_task_leases SET expires_at = ? WHERE task_id = ?`,
    ).run(Date.now() - 1, 'tk_lease_contend');
    recoverExpiredTaskLeases(db, Date.now());

    const leaseB = acquireTaskLease(db, {
      workflowId: 'wf_lease_contend',
      taskId: 'tk_lease_contend',
      owner: 'worker-B',
      ttlMs: 30_000,
    });
    expect(leaseB.attempt).toBe(2);
    expect(leaseB.idempotency_key).not.toBe(staleKey);

    // Simulate worker-A's stale cancel — keyed on the old idempotency_key.
    const oldOwnerCancel = db.prepare(
      `UPDATE workflow_task_leases
          SET status = 'failed', released_at = ?
        WHERE task_id = ? AND idempotency_key = ?`,
    ).run(Date.now(), 'tk_lease_contend', staleKey);

    // No rows matched — the stale key is gone.
    expect(oldOwnerCancel.changes).toBe(0);

    // Lease B is untouched.
    const stillB = loadTaskLease(db, 'tk_lease_contend');
    expect(stillB).not.toBeNull();
    expect(stillB!.status).toBe('running');
    expect(stillB!.lease_owner).toBe('worker-B');
    expect(stillB!.attempt).toBe(2);
  });
});
