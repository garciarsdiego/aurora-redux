import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import {
  registerSubagentRun,
  markRunStarted,
  markRunComplete,
  getRunById,
  listRunsForTask,
  listRunsForWorkflow,
  countActiveRunsForTask,
  countActiveDescendants,
} from '../../src/v2/subagent/registry.js';
import { newSubagentRunId } from '../../src/v2/subagent/types.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

interface TestFixture {
  workflowId: string;
  taskId: string;
}

/**
 * Inserts a minimal workflow + task pair to satisfy FK constraints.
 * Tests cannot insert subagent_runs without these existing first.
 */
function setupWorkflow(db: Database.Database): TestFixture {
  const workflowId = `wf_test_${Math.random().toString(36).slice(2, 8)}`;
  const taskId = `tk_test_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, 'internal', 'test objective', 'pending', ?)`,
  ).run(workflowId, now);

  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, status, depends_on_json,
        max_retries, retry_count, retry_policy, refine_count, max_refine,
        hitl, created_at)
     VALUES (?, ?, 'Test Task', 'llm_call', 'pending', '[]',
             3, 0, 'exponential', 0, 2, 0, ?)`,
  ).run(taskId, workflowId, now);

  return { workflowId, taskId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('registerSubagentRun', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('inserts a row with all supplied values and correct defaults', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();

    const row = registerSubagentRun(db, {
      runId,
      taskId,
      workflowId,
      depth: 0,
      taskText: 'Do something useful',
    });

    expect(row.run_id).toBe(runId);
    expect(row.task_id).toBe(taskId);
    expect(row.workflow_id).toBe(workflowId);
    expect(row.depth).toBe(0);
    expect(row.task_text).toBe('Do something useful');
    expect(row.status).toBe('pending');
    expect(row.cleanup).toBe('delete');
    expect(row.spawn_mode).toBe('run');
    expect(row.parent_run_id).toBeNull();
    expect(row.model).toBeNull();
    expect(row.timeout_seconds).toBeNull();
    expect(row.result_text).toBeNull();
    expect(row.error_msg).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.ended_at).toBeNull();
    expect(typeof row.created_at).toBe('number');
    expect(row.created_at).toBeGreaterThan(0);
  });

  it('respects optional overrides (model, cleanup, spawnMode, timeoutSeconds)', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();

    const row = registerSubagentRun(db, {
      runId,
      taskId,
      workflowId,
      depth: 1,
      model: 'claude/claude-sonnet-4-6',
      taskText: 'Do override thing',
      cleanup: 'keep',
      spawnMode: 'session',
      timeoutSeconds: 120,
    });

    expect(row.model).toBe('claude/claude-sonnet-4-6');
    expect(row.cleanup).toBe('keep');
    expect(row.spawn_mode).toBe('session');
    expect(row.timeout_seconds).toBe(120);
    expect(row.depth).toBe(1);
  });

  it('FK violation: inserting a run for a non-existent task_id throws', () => {
    const { workflowId } = setupWorkflow(db);
    expect(() =>
      registerSubagentRun(db, {
        runId: newSubagentRunId(),
        taskId: 'tk_does_not_exist',
        workflowId,
        depth: 0,
        taskText: 'bad insert',
      }),
    ).toThrow();
  });
});

describe('markRunStarted', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('flips status from pending → running and stamps started_at', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 'start me' });

    const before = Date.now();
    markRunStarted(db, runId);
    const after = Date.now();

    const row = getRunById(db, runId);
    expect(row?.status).toBe('running');
    expect(row?.started_at).toBeGreaterThanOrEqual(before);
    expect(row?.started_at).toBeLessThanOrEqual(after);
  });

  it('is idempotent: calling twice does not change started_at on second call', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 'idem' });

    markRunStarted(db, runId);
    const firstStartedAt = getRunById(db, runId)?.started_at;

    // Second call should be a no-op because status is already 'running'
    markRunStarted(db, runId);
    const secondStartedAt = getRunById(db, runId)?.started_at;

    expect(secondStartedAt).toBe(firstStartedAt);
  });
});

describe('markRunComplete', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('marks an ok outcome as complete', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 'ok run' });
    markRunStarted(db, runId);

    markRunComplete(db, runId, { status: 'ok', resultText: 'done!' });

    const row = getRunById(db, runId);
    expect(row?.status).toBe('complete');
    expect(row?.result_text).toBe('done!');
    expect(row?.error_msg).toBeNull();
    expect(row?.ended_at).toBeGreaterThan(0);
  });

  it('marks an error outcome', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 'err run' });
    markRunStarted(db, runId);

    markRunComplete(db, runId, { status: 'error', errorMsg: 'something blew up' });

    const row = getRunById(db, runId);
    expect(row?.status).toBe('error');
    expect(row?.error_msg).toBe('something blew up');
    expect(row?.result_text).toBeNull();
  });

  it('marks a timeout outcome', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 'timeout run' });
    markRunStarted(db, runId);

    markRunComplete(db, runId, { status: 'timeout' });

    const row = getRunById(db, runId);
    expect(row?.status).toBe('timeout');
  });

  it('marks a killed outcome', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 'killed run' });
    markRunStarted(db, runId);

    markRunComplete(db, runId, { status: 'killed' });

    const row = getRunById(db, runId);
    expect(row?.status).toBe('killed');
  });

  it('is a no-op when the row is already terminal (complete)', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 'already done' });
    markRunStarted(db, runId);
    markRunComplete(db, runId, { status: 'ok', resultText: 'first' });

    // Attempt to overwrite with a different outcome
    markRunComplete(db, runId, { status: 'error', errorMsg: 'should not apply' });

    const row = getRunById(db, runId);
    // Status must still be complete and result_text unchanged
    expect(row?.status).toBe('complete');
    expect(row?.result_text).toBe('first');
    expect(row?.error_msg).toBeNull();
  });
});

describe('markRunComplete return value (R-HIGH-5)', () => {
  it('returns true when row transitioned from pending/running', () => {
    const db = initDb(':memory:');
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 't' });

    expect(markRunComplete(db, runId, { status: 'ok', resultText: 'done' })).toBe(true);
    db.close();
  });

  it('returns false when row was already terminal (no-op detection)', () => {
    const db = initDb(':memory:');
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 't' });

    markRunComplete(db, runId, { status: 'ok' }); // first call → terminal
    // second call must return false; caller can then log a contract violation
    expect(markRunComplete(db, runId, { status: 'error', errorMsg: 'late' })).toBe(false);
    db.close();
  });
});

describe('listRunsForTask', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns runs in created_at order', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const runId = newSubagentRunId();
      ids.push(runId);
      registerSubagentRun(db, {
        runId,
        taskId,
        workflowId,
        depth: 0,
        taskText: `task text ${i}`,
      });
    }

    const rows = listRunsForTask(db, taskId);
    expect(rows).toHaveLength(3);
    // created_at is monotonically increasing or equal — verify order via IDs
    expect(rows.map(r => r.run_id)).toEqual(ids);
  });

  it('returns empty array for unknown task_id', () => {
    const rows = listRunsForTask(db, 'tk_nonexistent');
    expect(rows).toHaveLength(0);
  });
});

describe('listRunsForWorkflow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns all runs when no filter supplied', () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const r1 = newSubagentRunId();
    const r2 = newSubagentRunId();
    registerSubagentRun(db, { runId: r1, taskId, workflowId, depth: 0, taskText: 'a' });
    registerSubagentRun(db, { runId: r2, taskId, workflowId, depth: 0, taskText: 'b' });
    markRunStarted(db, r2);

    const rows = listRunsForWorkflow(db, workflowId);
    expect(rows).toHaveLength(2);
  });

  it('filters by a single status', () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const r1 = newSubagentRunId();
    const r2 = newSubagentRunId();
    registerSubagentRun(db, { runId: r1, taskId, workflowId, depth: 0, taskText: 'pending one' });
    registerSubagentRun(db, { runId: r2, taskId, workflowId, depth: 0, taskText: 'will run' });
    markRunStarted(db, r2);

    const pending = listRunsForWorkflow(db, workflowId, { status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].run_id).toBe(r1);
  });

  it('filters by an array of statuses', () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const r1 = newSubagentRunId();
    const r2 = newSubagentRunId();
    const r3 = newSubagentRunId();
    registerSubagentRun(db, { runId: r1, taskId, workflowId, depth: 0, taskText: 'p' });
    registerSubagentRun(db, { runId: r2, taskId, workflowId, depth: 0, taskText: 'r' });
    registerSubagentRun(db, { runId: r3, taskId, workflowId, depth: 0, taskText: 'c' });
    markRunStarted(db, r2);
    markRunStarted(db, r3);
    markRunComplete(db, r3, { status: 'ok' });

    const active = listRunsForWorkflow(db, workflowId, { status: ['pending', 'running'] });
    expect(active).toHaveLength(2);
    const activeIds = active.map(r => r.run_id);
    expect(activeIds).toContain(r1);
    expect(activeIds).toContain(r2);
  });
});

describe('countActiveRunsForTask', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('counts pending + running, ignores terminal statuses', () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const r1 = newSubagentRunId();
    const r2 = newSubagentRunId();
    const r3 = newSubagentRunId();

    registerSubagentRun(db, { runId: r1, taskId, workflowId, depth: 0, taskText: 'p' });
    registerSubagentRun(db, { runId: r2, taskId, workflowId, depth: 0, taskText: 'r' });
    registerSubagentRun(db, { runId: r3, taskId, workflowId, depth: 0, taskText: 'done' });

    markRunStarted(db, r2);
    markRunStarted(db, r3);
    markRunComplete(db, r3, { status: 'ok' });

    // r1 = pending, r2 = running, r3 = complete → active = 2
    expect(countActiveRunsForTask(db, taskId)).toBe(2);
  });

  it('returns 0 when all runs are terminal', () => {
    const { workflowId, taskId } = setupWorkflow(db);
    const runId = newSubagentRunId();
    registerSubagentRun(db, { runId, taskId, workflowId, depth: 0, taskText: 't' });
    markRunStarted(db, runId);
    markRunComplete(db, runId, { status: 'ok' });

    expect(countActiveRunsForTask(db, taskId)).toBe(0);
  });
});

describe('countActiveDescendants', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('recursive tree: A → B → C; countActiveDescendants(A)=2, (B)=1, (C)=0', () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const runA = newSubagentRunId();
    const runB = newSubagentRunId();
    const runC = newSubagentRunId();

    // A is the root (no parent)
    registerSubagentRun(db, {
      runId: runA,
      taskId,
      workflowId,
      depth: 0,
      taskText: 'parent A',
    });

    // B is a child of A
    registerSubagentRun(db, {
      runId: runB,
      taskId,
      workflowId,
      parentRunId: runA,
      depth: 1,
      taskText: 'child B',
    });

    // C is a grandchild (child of B)
    registerSubagentRun(db, {
      runId: runC,
      taskId,
      workflowId,
      parentRunId: runB,
      depth: 2,
      taskText: 'grandchild C',
    });

    // All three are in 'pending' state
    expect(countActiveDescendants(db, runA)).toBe(2); // B + C
    expect(countActiveDescendants(db, runB)).toBe(1); // C only
    expect(countActiveDescendants(db, runC)).toBe(0); // no children
  });

  it('does not count terminal descendants', () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const runA = newSubagentRunId();
    const runB = newSubagentRunId();

    registerSubagentRun(db, { runId: runA, taskId, workflowId, depth: 0, taskText: 'A' });
    registerSubagentRun(db, { runId: runB, taskId, workflowId, parentRunId: runA, depth: 1, taskText: 'B' });

    markRunStarted(db, runB);
    markRunComplete(db, runB, { status: 'ok' });

    // B is complete → not counted
    expect(countActiveDescendants(db, runA)).toBe(0);
  });
});
