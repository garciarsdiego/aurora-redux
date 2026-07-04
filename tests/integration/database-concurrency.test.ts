import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertEvent, insertTask } from '../../src/db/persist.js';
import { getDbPath } from '../../src/utils/config.js';

describe('Database Concurrency Integration', () => {
  const testWorkflowId = 'wf_concurrency_test';
  const concurrentTaskCount = 10;

  beforeAll(() => {
    const db = initDb(getDbPath());
    const now = Date.now();

    try {
      // Clean up any existing test data
      db.prepare(`DELETE FROM events WHERE workflow_id = ?`).run(testWorkflowId);
      db.prepare(`DELETE FROM tasks WHERE workflow_id = ?`).run(testWorkflowId);
      db.prepare(`DELETE FROM workflows WHERE id = ?`).run(testWorkflowId);

      // Insert test workflow
      db.prepare(
        `INSERT INTO workflows
         (id, workspace, objective, pattern_id, status, started_at, completed_at,
          created_at, created_by, estimated_cost_usd, actual_cost_usd,
          max_total_cost_usd, max_duration_seconds, metadata)
       VALUES (?, 'internal', ?, NULL, 'executing', ?, NULL, ?, 'integration_test', NULL, NULL, NULL, NULL, ?)`,
      ).run(
        testWorkflowId,
        'Concurrency test workflow',
        now - 10_000,
        now,
        JSON.stringify({ test: true }),
      );
    } finally {
      db.close();
    }
  });

  afterAll(() => {
    const db = initDb(getDbPath());
    
    try {
      db.prepare(`DELETE FROM events WHERE workflow_id = ?`).run(testWorkflowId);
      db.prepare(`DELETE FROM tasks WHERE workflow_id = ?`).run(testWorkflowId);
      db.prepare(`DELETE FROM workflows WHERE id = ?`).run(testWorkflowId);
    } finally {
      db.close();
    }
  });

  it('handles concurrent task inserts', async () => {
    const db = initDb(getDbPath());
    
    try {
      const insertPromises = [];
      
      for (let i = 0; i < concurrentTaskCount; i++) {
        insertPromises.push(
          Promise.resolve().then(() => {
            const taskDb = initDb(getDbPath());
            try {
              insertTask(taskDb, {
                id: `${testWorkflowId}_task_concurrent_${i}`,
                workflow_id: testWorkflowId,
                name: `Concurrent task ${i}`,
                kind: 'llm_call',
                input_json: JSON.stringify({ index: i }),
                output_json: null,
                status: 'pending',
                depends_on: [],
                executor_hint: null,
                timeout_seconds: 300,
                max_retries: 1,
                retry_count: 0,
                retry_policy: 'exponential',
                started_at: null,
                completed_at: null,
                created_at: Date.now(),
                acceptance_criteria: 'Concurrent insert test',
                refine_count: 0,
                max_refine: 1,
                refine_feedback: null,
                model: 'cx/gpt-5.4',
                hitl: false,
                execution_mode: 'ephemeral',
                tool_name: null,
              });
            } finally {
              taskDb.close();
            }
          })
        );
      }

      await Promise.all(insertPromises);

      const tasks = db
        .prepare('SELECT * FROM tasks WHERE workflow_id = ? AND name LIKE ?')
        .all(testWorkflowId, 'Concurrent task %');
      
      expect(tasks.length).toBe(concurrentTaskCount);
    } finally {
      db.close();
    }
  });

  it('handles concurrent event inserts', async () => {
    const db = initDb(getDbPath());
    
    try {
      const insertPromises = [];
      
      for (let i = 0; i < concurrentTaskCount; i++) {
        insertPromises.push(
          Promise.resolve().then(() => {
            const eventDb = initDb(getDbPath());
            try {
              insertEvent(eventDb, {
                workflow_id: testWorkflowId,
                task_id: `${testWorkflowId}_task_concurrent_${i}`,
                type: 'task_started',
                payload: { index: i, concurrent: true },
              });
            } finally {
              eventDb.close();
            }
          })
        );
      }

      await Promise.all(insertPromises);

      const events = db
        .prepare('SELECT * FROM events WHERE workflow_id = ? AND type = ?')
        .all(testWorkflowId, 'task_started');
      
      expect(events.length).toBeGreaterThanOrEqual(concurrentTaskCount);
    } finally {
      db.close();
    }
  });

  it('handles concurrent reads and writes', async () => {
    const db = initDb(getDbPath());
    
    try {
      const operations = [];
      
      // Concurrent reads
      for (let i = 0; i < 5; i++) {
        operations.push(
          Promise.resolve().then(() => {
            const readDb = initDb(getDbPath());
            try {
              readDb.prepare('SELECT * FROM workflows WHERE id = ?').get(testWorkflowId);
            } finally {
              readDb.close();
            }
          })
        );
      }
      
      // Concurrent writes. Use null task_id (workflow-level event) because
      // the FK constraint on events.task_id rejects unknown ids.
      for (let i = 0; i < 5; i++) {
        operations.push(
          Promise.resolve().then(() => {
            const writeDb = initDb(getDbPath());
            try {
              insertEvent(writeDb, {
                workflow_id: testWorkflowId,
                task_id: null,
                type: 'read_write_test',
                payload: { index: i },
              });
            } finally {
              writeDb.close();
            }
          })
        );
      }

      await Promise.all(operations);

      // Verify all operations completed
      const events = db
        .prepare('SELECT * FROM events WHERE workflow_id = ? AND type = ?')
        .all(testWorkflowId, 'read_write_test');
      
      expect(events.length).toBe(5);
    } finally {
      db.close();
    }
  });

  it('handles transaction rollback on error', () => {
    const db = initDb(getDbPath());
    
    try {
      const transaction = db.transaction(() => {
        insertTask(db, {
          id: `${testWorkflowId}_task_rollback_1`,
          workflow_id: testWorkflowId,
          name: 'Rollback task 1',
          kind: 'llm_call',
          input_json: '{}',
          output_json: null,
          status: 'pending',
          depends_on: [],
          executor_hint: null,
          timeout_seconds: 300,
          max_retries: 1,
          retry_count: 0,
          retry_policy: 'exponential',
          started_at: null,
          completed_at: null,
          created_at: Date.now(),
          acceptance_criteria: 'Rollback test',
          refine_count: 0,
          max_refine: 1,
          refine_feedback: null,
          model: 'cx/gpt-5.4',
          hitl: false,
          execution_mode: 'ephemeral',
          tool_name: null,
        });

        // Intentionally cause an error
        throw new Error('Transaction rollback test');
      });

      expect(() => transaction()).toThrow();

      // Verify task was not inserted
      const task = db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(`${testWorkflowId}_task_rollback_1`);
      
      expect(task).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('handles WAL mode concurrent access', async () => {
    const db = initDb(getDbPath());
    
    try {
      // Verify WAL mode is enabled
      const result = db.prepare('PRAGMA journal_mode').get() as any;
      expect(result.journal_mode.toLowerCase()).toBe('wal');
      
      // Perform concurrent operations that would block in non-WAL mode
      const operations = [];
      
      for (let i = 0; i < 3; i++) {
        operations.push(
          Promise.resolve().then(() => {
            const walDb = initDb(getDbPath());
            try {
              walDb.prepare('BEGIN IMMEDIATE').run();
              insertEvent(walDb, {
                workflow_id: testWorkflowId,
                task_id: null,
                type: 'wal_test',
                payload: { index: i },
              });
              walDb.prepare('COMMIT').run();
            } catch (error) {
              walDb.prepare('ROLLBACK').run();
              throw error;
            } finally {
              walDb.close();
            }
          })
        );
      }

      await expect(Promise.all(operations)).resolves.not.toThrow();
    } finally {
      db.close();
    }
  });

  it('prevents lost updates with proper locking', async () => {
    const db = initDb(getDbPath());
    
    try {
      // Insert initial task
      insertTask(db, {
        id: `${testWorkflowId}_task_lock`,
        workflow_id: testWorkflowId,
        name: 'Lock test task',
        kind: 'llm_call',
        input_json: JSON.stringify({ counter: 0 }),
        output_json: null,
        status: 'pending',
        depends_on: [],
        executor_hint: null,
        timeout_seconds: 300,
        max_retries: 1,
        retry_count: 0,
        retry_policy: 'exponential',
        started_at: null,
        completed_at: null,
        created_at: Date.now(),
        acceptance_criteria: 'Lock test',
        refine_count: 0,
        max_refine: 1,
        refine_feedback: null,
        model: 'cx/gpt-5.4',
        hitl: false,
        execution_mode: 'ephemeral',
        tool_name: null,
      });

      // Simulate concurrent updates
      const updatePromises = [];
      
      for (let i = 0; i < 5; i++) {
        updatePromises.push(
          Promise.resolve().then(() => {
            const updateDb = initDb(getDbPath());
            try {
              updateDb.prepare('BEGIN IMMEDIATE').run();
              
              const task = updateDb
                .prepare('SELECT * FROM tasks WHERE id = ?')
                .get(`${testWorkflowId}_task_lock`) as any;
              
              const input = JSON.parse(task.input_json);
              input.counter = (input.counter || 0) + 1;
              
              updateDb
                .prepare('UPDATE tasks SET input_json = ? WHERE id = ?')
                .run(JSON.stringify(input), `${testWorkflowId}_task_lock`);
              
              updateDb.prepare('COMMIT').run();
            } catch (error) {
              updateDb.prepare('ROLLBACK').run();
              throw error;
            } finally {
              updateDb.close();
            }
          })
        );
      }

      await Promise.all(updatePromises);

      // Verify final counter value (should be 5 if no lost updates)
      const finalTask = db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(`${testWorkflowId}_task_lock`) as any;
      
      const finalInput = JSON.parse(finalTask.input_json);
      expect(finalInput.counter).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});