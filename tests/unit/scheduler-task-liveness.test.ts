import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { acquireTaskLease } from '../../src/db/task-leases.js';
import { expireTimedOutRunningTasks } from '../../src/scheduler/tick.js';

function insertWorkflowAndTask(db: ReturnType<typeof initDb>, taskId: string): void {
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at, started_at)
     VALUES ('wf_liveness', 'internal', 'liveness test', 'executing', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, status, depends_on_json, timeout_seconds,
        max_retries, retry_count, retry_policy, created_at, started_at)
     VALUES (?, 'wf_liveness', 'leased task', 'cli_spawn', 'running', '[]', 1, 3, 0, 'exponential', 1, 1)`,
  ).run(taskId);
}

describe('scheduler task liveness', () => {
  it('fails expired running tasks with structured lease-expired evidence', () => {
    const db = initDb(':memory:');
    insertWorkflowAndTask(db, 'tk_expired');
    acquireTaskLease(db, {
      workflowId: 'wf_liveness',
      taskId: 'tk_expired',
      owner: 'test-worker',
      ttlMs: 1_000,
      now: 1_000,
    });

    const result = expireTimedOutRunningTasks(db, 2_500);

    expect(result.expired).toEqual([
      expect.objectContaining({
        task_id: 'tk_expired',
        workflow_id: 'wf_liveness',
        age_ms: 1_500,
      }),
    ]);

    const task = db
      .prepare('SELECT status, completed_at, output_json FROM tasks WHERE id = ?')
      .get('tk_expired') as { status: string; completed_at: number | null; output_json: string | null };
    expect(task.status).toBe('failed');
    expect(task.completed_at).toBe(2_500);
    expect(task.output_json).toContain('task_lease_expired');
    expect(task.output_json).toContain('Lease expired before task completed');

    const lease = db
      .prepare('SELECT status, released_at FROM workflow_task_leases WHERE task_id = ?')
      .get('tk_expired') as { status: string; released_at: number | null };
    expect(lease.status).toBe('expired');
    expect(lease.released_at).toBe(2_500);

    const events = db
      .prepare('SELECT type, task_id, payload_json FROM events WHERE workflow_id = ? ORDER BY id ASC')
      .all('wf_liveness') as Array<{ type: string; task_id: string | null; payload_json: string | null }>;
    expect(events.map((event) => event.type)).toEqual([
      'task_lease_expired',
      'workflow_background_error',
    ]);
    expect(events[0]?.task_id).toBe('tk_expired');
    expect(events[0]?.payload_json).toContain('test-worker');

    db.close();
  });
});
