import { afterEach, describe, it, expect, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  acquireTaskLease,
  completeTaskLease,
  recoverExpiredTaskLeases,
  startTaskLeaseHeartbeat,
} from '../../src/db/task-leases.js';

function insertWorkflowAndTask(db: ReturnType<typeof initDb>, taskId: string): void {
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES ('wf_1', 'internal', 'lease test', 'executing', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, status, depends_on_json, timeout_seconds,
        max_retries, retry_count, retry_policy, created_at)
     VALUES (?, 'wf_1', 'leased task', 'llm_call', 'pending', '[]', 60, 3, 0, 'exponential', 1)`,
  ).run(taskId);
}

describe('workflow task leases', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the lease table via migrations', () => {
    const db = initDb(':memory:');
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_task_leases'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('workflow_task_leases');
    db.close();
  });

  it('acquires and completes a durable lease for a task execution attempt', () => {
    const db = initDb(':memory:');
    insertWorkflowAndTask(db, 'tk_1');
    const lease = acquireTaskLease(db, {
      workflowId: 'wf_1',
      taskId: 'tk_1',
      owner: 'test-worker',
      ttlMs: 60_000,
    });

    expect(lease.status).toBe('running');
    expect(lease.attempt).toBe(1);
    expect(lease.idempotency_key).toBe('wf_1:tk_1:1');

    completeTaskLease(db, 'tk_1', 'completed');
    const row = db
      .prepare('SELECT status, released_at FROM workflow_task_leases WHERE task_id = ?')
      .get('tk_1') as { status: string; released_at: number | null };
    expect(row.status).toBe('completed');
    expect(row.released_at).toEqual(expect.any(Number));
    db.close();
  });

  it('recovers expired running leases so resume can requeue stale tasks', () => {
    const db = initDb(':memory:');
    insertWorkflowAndTask(db, 'tk_stale');
    acquireTaskLease(db, {
      workflowId: 'wf_1',
      taskId: 'tk_stale',
      owner: 'test-worker',
      ttlMs: 1,
      now: 1_000,
    });

    const recovered = recoverExpiredTaskLeases(db, 2_000);
    expect(recovered).toEqual([
      expect.objectContaining({ task_id: 'tk_stale', status: 'expired' }),
    ]);
    db.close();
  });

  it('renews a running lease heartbeat until stopped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const db = initDb(':memory:');
    insertWorkflowAndTask(db, 'tk_heartbeat');
    acquireTaskLease(db, {
      workflowId: 'wf_1',
      taskId: 'tk_heartbeat',
      owner: 'test-worker',
      ttlMs: 60_000,
      now: 1_000,
    });

    const heartbeat = startTaskLeaseHeartbeat(db, {
      taskId: 'tk_heartbeat',
      ttlMs: 60_000,
      intervalMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    let row = db
      .prepare('SELECT heartbeat_at, expires_at FROM workflow_task_leases WHERE task_id = ?')
      .get('tk_heartbeat') as { heartbeat_at: number; expires_at: number };
    expect(row.heartbeat_at).toBe(6_000);
    expect(row.expires_at).toBe(66_000);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    row = db
      .prepare('SELECT heartbeat_at, expires_at FROM workflow_task_leases WHERE task_id = ?')
      .get('tk_heartbeat') as { heartbeat_at: number; expires_at: number };
    expect(row.heartbeat_at).toBe(6_000);
    expect(row.expires_at).toBe(66_000);

    db.close();
  });
});
