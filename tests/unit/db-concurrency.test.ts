/**
 * Tier 0 — Wave 2 DB-A: SQLite concurrency + atomicity hardening.
 *
 * Three concerns covered:
 *   1. busy_timeout pragma is set to 5000 ms after initDb.
 *   2. withSqliteRetrySync survives a transient SQLITE_BUSY by retrying
 *      on the bounded backoff schedule before re-throwing.
 *   3. executeWorkflow's workflow + tasks insert is atomic — a crash
 *      mid-loop must not leave a workflow row without all its tasks.
 */

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { isSqliteBusy, withSqliteRetrySync } from '../../src/db/sqlite-retry.js';
import {
  newWorkflowId,
  newTaskId,
  insertWorkflow,
  insertTask,
  insertEvent,
  setTaskCompleted,
  loadWorkflowById,
  loadWorkflowTasks,
} from '../../src/db/persist.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import type { Workflow, Task, Dag } from '../../src/types/index.js';

function makeWorkflow(id: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'concurrency test',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(id: string, wfId: string): Task {
  return {
    id,
    workflow_id: wfId,
    name: `task-${id}`,
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

describe('db client — busy_timeout pragma', () => {
  it('sets busy_timeout to 5000 after initDb', () => {
    const db = initDb(':memory:');
    try {
      const row = db.pragma('busy_timeout', { simple: true });
      expect(row).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('also keeps WAL and foreign_keys enabled', () => {
    const db = initDb(':memory:');
    try {
      // :memory: dbs always report 'memory' for journal_mode regardless
      // of the pragma; for a real file path WAL would surface here. We
      // assert foreign_keys to confirm the pragma block ran in order.
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('sqlite-retry — isSqliteBusy classifier', () => {
  it('matches SQLITE_BUSY error code', () => {
    const err = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(isSqliteBusy(err)).toBe(true);
  });

  it('matches SQLITE_LOCKED error code', () => {
    const err = Object.assign(new Error('table locked'), { code: 'SQLITE_LOCKED' });
    expect(isSqliteBusy(err)).toBe(true);
  });

  it('matches "database is locked" message even without code', () => {
    const err = new Error('database is locked');
    expect(isSqliteBusy(err)).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isSqliteBusy(new Error('UNIQUE constraint failed'))).toBe(false);
    expect(isSqliteBusy(null)).toBe(false);
    expect(isSqliteBusy(undefined)).toBe(false);
    expect(isSqliteBusy('not an error')).toBe(false);
  });
});

describe('withSqliteRetrySync — backoff behaviour', () => {
  it('returns the value when fn succeeds on the first attempt', () => {
    const db = initDb(':memory:');
    try {
      const fn = vi.fn(() => 42);
      const result = withSqliteRetrySync(fn);
      expect(result).toBe(42);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('retries on SQLITE_BUSY then succeeds', () => {
    const db = initDb(':memory:');
    try {
      const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      let attempts = 0;
      const fn = vi.fn(() => {
        attempts += 1;
        if (attempts < 3) throw busyErr;
        return 'ok';
      });
      const result = withSqliteRetrySync(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      db.close();
    }
  });

  it('rethrows non-busy errors immediately without retrying', () => {
    const db = initDb(':memory:');
    try {
      const otherErr = new Error('UNIQUE constraint failed');
      const fn = vi.fn(() => { throw otherErr; });
      expect(() => withSqliteRetrySync(fn)).toThrow('UNIQUE constraint failed');
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it('rethrows the original busy error after exhausting retries', () => {
    const db = initDb(':memory:');
    try {
      const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      const fn = vi.fn(() => { throw busyErr; });
      // Initial attempt + 4 retries = 5 calls.
      expect(() => withSqliteRetrySync(fn)).toThrow('database is locked');
      expect(fn).toHaveBeenCalledTimes(5);
    } finally {
      db.close();
    }
  });
});

describe('persist — wrapped writes survive simulated SQLITE_BUSY', () => {
  it('setTaskCompleted retries through a transient busy error and succeeds', () => {
    const db = initDb(':memory:');
    try {
      const wfId = newWorkflowId();
      const taskId = newTaskId();
      insertWorkflow(db, makeWorkflow(wfId));
      insertTask(db, { ...makeTask(taskId, wfId), workflow_id: wfId });

      // Monkey-patch db.prepare exactly once so the FIRST call to
      // setTaskCompleted's prepared statement returns a stub that throws
      // SQLITE_BUSY on its first .run() invocation, then forwards to the
      // real statement on the retry. The retry helper should swallow the
      // first failure and the row should land normally.
      const realPrepare = db.prepare.bind(db);
      let busyThrown = false;
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const realStmt = realPrepare(sql);
        if (sql.includes("UPDATE tasks SET status = 'completed'")) {
          // Wrap stmt so the first .run errors but subsequent succeed.
          const wrapped = Object.create(realStmt) as typeof realStmt;
          (wrapped as { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
            if (!busyThrown) {
              busyThrown = true;
              throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
            }
            return (realStmt.run as (...a: unknown[]) => unknown)(...args);
          };
          return wrapped;
        }
        return realStmt;
      });

      try {
        setTaskCompleted(db, taskId, '{"result": "ok"}');
      } finally {
        prepareSpy.mockRestore();
      }

      expect(busyThrown).toBe(true);
      const tasks = loadWorkflowTasks(db, wfId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('completed');
      expect(tasks[0]!.output_json).toBe('{"result": "ok"}');
    } finally {
      db.close();
    }
  });

  it('insertEvent retries through a transient busy error and surfaces the row', () => {
    const db = initDb(':memory:');
    try {
      const wfId = newWorkflowId();
      insertWorkflow(db, makeWorkflow(wfId));

      const realPrepare = db.prepare.bind(db);
      let busyThrown = false;
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const realStmt = realPrepare(sql);
        if (sql.includes('INSERT INTO events')) {
          const wrapped = Object.create(realStmt) as typeof realStmt;
          (wrapped as { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
            if (!busyThrown) {
              busyThrown = true;
              throw Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
            }
            return (realStmt.run as (...a: unknown[]) => unknown)(...args);
          };
          return wrapped;
        }
        return realStmt;
      });

      try {
        // insertEvent is wrapped inside persist.ts; the retry should
        // succeed and the row land.
        insertEvent(db, { workflow_id: wfId, type: 'concurrency_probe' });
      } finally {
        prepareSpy.mockRestore();
      }

      expect(busyThrown).toBe(true);
      const evs = db.prepare('SELECT type FROM events WHERE workflow_id = ?').all(wfId) as { type: string }[];
      expect(evs.map((e) => e.type)).toContain('concurrency_probe');
    } finally {
      db.close();
    }
  });
});

describe('executeWorkflow — atomic workflow + tasks insertion', () => {
  it('rolls back the workflow row when a mid-loop insertTask throws', async () => {
    const db = initDb(':memory:');
    try {
      // Simulate a crash mid-task-insert by patching insertTask to throw on
      // the second invocation. Because executeWorkflow now wraps the
      // workflow + tasks loop in db.transaction, the first task insert
      // (and the workflow row insert that preceded it) MUST roll back so
      // that no orphan rows are visible after the throw.
      const dag: Dag = {
        tasks: [
          { id: 't1', name: 'task one', kind: 'llm_call', depends_on: [] },
          { id: 't2', name: 'task two', kind: 'llm_call', depends_on: ['t1'] },
          { id: 't3', name: 'task three', kind: 'llm_call', depends_on: ['t2'] },
        ],
      };

      const realPrepare = db.prepare.bind(db);
      let taskInsertCount = 0;
      const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
        const realStmt = realPrepare(sql);
        if (sql.includes('INSERT INTO tasks')) {
          const wrapped = Object.create(realStmt) as typeof realStmt;
          (wrapped as { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
            taskInsertCount += 1;
            if (taskInsertCount === 2) {
              throw new Error('SIMULATED_CRASH_MID_TASK_LOOP');
            }
            return (realStmt.run as (...a: unknown[]) => unknown)(...args);
          };
          return wrapped;
        }
        return realStmt;
      });

      // Snapshot existing workflow IDs so we can detect the absence of any
      // newly-inserted rows after the rollback.
      const existingWfIds = new Set(
        (db.prepare('SELECT id FROM workflows').all() as { id: string }[]).map((r) => r.id),
      );

      let thrown: unknown;
      try {
        await executeWorkflow(db, dag, 'internal', 'atomicity test');
      } catch (err) {
        thrown = err;
      } finally {
        prepareSpy.mockRestore();
      }

      expect(thrown).toBeDefined();
      expect((thrown as Error).message).toContain('SIMULATED_CRASH_MID_TASK_LOOP');

      // After rollback no NEW workflow row should be visible; any tasks
      // that did get prepared must also be absent.
      const newWorkflows = (db.prepare('SELECT id FROM workflows').all() as { id: string }[]).filter(
        (r) => !existingWfIds.has(r.id),
      );
      expect(newWorkflows).toHaveLength(0);

      const orphanTasks = db.prepare('SELECT id FROM tasks').all() as { id: string }[];
      expect(orphanTasks).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('commits both workflow and tasks together when the loop completes', async () => {
    const db = initDb(':memory:');
    try {
      const dag: Dag = {
        tasks: [
          { id: 't1', name: 'first', kind: 'llm_call', depends_on: [] },
          { id: 't2', name: 'second', kind: 'llm_call', depends_on: ['t1'] },
        ],
      };

      // Stub executeTaskFn so we don't hit any LLM provider — the only
      // thing we care about here is that BOTH the workflow row and BOTH
      // task rows committed atomically before runTaskLoop fired.
      let visibleAtFirstTask: { wf: boolean; tasks: number } | null = null;
      const seenIds = new Set<string>();
      const stubExecute = async (task: Task): Promise<string> => {
        if (visibleAtFirstTask === null) {
          const wf = loadWorkflowById(db, task.workflow_id);
          const tasks = loadWorkflowTasks(db, task.workflow_id);
          visibleAtFirstTask = { wf: wf !== null, tasks: tasks.length };
        }
        seenIds.add(task.id);
        return `out-${task.name}`;
      };

      const result = await executeWorkflow(db, dag, 'internal', 'atomicity success', {
        executeTaskFn: stubExecute,
        consolidateFn: async () => 'consolidated',
      });

      expect(result.status).toBe('completed');
      expect(visibleAtFirstTask).not.toBeNull();
      // By the time the first task starts executing, BOTH task rows must
      // already be visible (transactional commit) and the workflow row
      // must exist.
      expect(visibleAtFirstTask!.wf).toBe(true);
      expect(visibleAtFirstTask!.tasks).toBe(2);
      expect(seenIds.size).toBe(2);
    } finally {
      db.close();
    }
  });
});
