import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertEvent, insertTask } from '../../src/db/persist.js';
import { getDbPath } from '../../src/utils/config.js';

describe('Performance: Workflow Execution', () => {
  const testWorkflowId = 'wf_perf_test';
  const taskCount = 100;
  const eventCount = 500;

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
       VALUES (?, 'internal', ?, NULL, 'executing', ?, NULL, ?, 'performance_test', NULL, NULL, NULL, NULL, ?)`,
      ).run(
        testWorkflowId,
        'Performance test workflow',
        now - 10_000,
        now,
        JSON.stringify({ test: true, performance: true }),
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

  it('inserts 100 tasks in under 1 second', () => {
    const db = initDb(getDbPath());
    
    try {
      const startTime = performance.now();
      
      for (let i = 0; i < taskCount; i++) {
        insertTask(db, {
          id: `${testWorkflowId}_task_perf_${i}`,
          workflow_id: testWorkflowId,
          name: `Performance task ${i}`,
          kind: 'llm_call',
          input_json: JSON.stringify({ index: i }),
          output_json: null,
          status: 'pending',
          depends_on: i > 0 ? [`${testWorkflowId}_task_perf_${i - 1}`] : [],
          executor_hint: null,
          timeout_seconds: 300,
          max_retries: 1,
          retry_count: 0,
          retry_policy: 'exponential',
          started_at: null,
          completed_at: null,
          created_at: Date.now(),
          acceptance_criteria: 'Performance test',
          refine_count: 0,
          max_refine: 1,
          refine_feedback: null,
          model: 'cx/gpt-5.4',
          hitl: false,
          execution_mode: 'ephemeral',
          tool_name: null,
        });
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(duration).toBeLessThan(1000); // Under 1 second
    } finally {
      db.close();
    }
  });

  it('inserts 500 events in under 1 second', () => {
    const db = initDb(getDbPath());
    
    try {
      const startTime = performance.now();
      
      for (let i = 0; i < eventCount; i++) {
        insertEvent(db, {
          workflow_id: testWorkflowId,
          task_id: `${testWorkflowId}_task_perf_${i % taskCount}`,
          type: 'task_streaming_chunk',
          payload: { index: i, chunk: `Performance test chunk ${i}` },
        });
      }
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(duration).toBeLessThan(1000); // Under 1 second
    } finally {
      db.close();
    }
  });

  it('queries 100 tasks in under 100ms', () => {
    const db = initDb(getDbPath());
    
    try {
      const startTime = performance.now();
      
      const tasks = db
        .prepare('SELECT * FROM tasks WHERE workflow_id = ?')
        .all(testWorkflowId);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(tasks.length).toBe(taskCount);
      expect(duration).toBeLessThan(100); // Under 100ms
    } finally {
      db.close();
    }
  });

  it('queries 500 events in under 200ms', () => {
    const db = initDb(getDbPath());
    
    try {
      const startTime = performance.now();
      
      const events = db
        .prepare('SELECT * FROM events WHERE workflow_id = ?')
        .all(testWorkflowId);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(events.length).toBeGreaterThanOrEqual(eventCount);
      expect(duration).toBeLessThan(200); // Under 200ms
    } finally {
      db.close();
    }
  });

  it('joins workflow, tasks, and events efficiently', () => {
    const db = initDb(getDbPath());
    
    try {
      const startTime = performance.now();
      
      const workflow = db
        .prepare('SELECT * FROM workflows WHERE id = ?')
        .get(testWorkflowId) as any;
      
      const tasks = db
        .prepare('SELECT * FROM tasks WHERE workflow_id = ?')
        .all(testWorkflowId);
      
      const events = db
        .prepare('SELECT * FROM events WHERE workflow_id = ? LIMIT 100')
        .all(testWorkflowId);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(workflow).toBeDefined();
      expect(tasks.length).toBe(taskCount);
      expect(events.length).toBe(100);
      expect(duration).toBeLessThan(300); // Under 300ms for joined query
    } finally {
      db.close();
    }
  });

  it('handles concurrent inserts efficiently', async () => {
    const db = initDb(getDbPath());
    
    try {
      const concurrentCount = 50;
      const startTime = performance.now();
      
      const insertPromises = [];
      
      for (let i = 0; i < concurrentCount; i++) {
        insertPromises.push(
          Promise.resolve().then(() => {
            const concurrentDb = initDb(getDbPath());
            try {
              insertEvent(concurrentDb, {
                workflow_id: testWorkflowId,
                task_id: `${testWorkflowId}_task_perf_${i % taskCount}`,
                type: 'concurrent_test',
                payload: { index: i },
              });
            } finally {
              concurrentDb.close();
            }
          })
        );
      }

      await Promise.all(insertPromises);
      
      const endTime = performance.now();
      const duration = endTime - startTime;
      
      expect(duration).toBeLessThan(2000); // Under 2 seconds for 50 concurrent inserts
    } finally {
      db.close();
    }
  });

  it('indexes improve query performance', () => {
    const db = initDb(getDbPath());
    
    try {
      // Query with index on workflow_id
      const startTime = performance.now();
      
      const tasks = db
        .prepare('SELECT * FROM tasks WHERE workflow_id = ?')
        .all(testWorkflowId);
      
      const endTime = performance.now();
      const indexedDuration = endTime - startTime;
      
      // Query without index (simulate by scanning all)
      const startTime2 = performance.now();
      
      const allTasks = db
        .prepare('SELECT * FROM tasks')
        .all();
      
      const filteredTasks = (allTasks as any[]).filter(t => t.workflow_id === testWorkflowId);
      
      const endTime2 = performance.now();
      const unindexedDuration = endTime2 - startTime2;
      
      expect(tasks.length).toBe(filteredTasks.length);
      expect(indexedDuration).toBeLessThan(unindexedDuration);
    } finally {
      db.close();
    }
  });

  it('bulk operations are faster than individual operations', () => {
    const db = initDb(getDbPath());
    
    try {
      // Individual inserts
      const startTime1 = performance.now();
      
      for (let i = 0; i < 10; i++) {
        insertEvent(db, {
          workflow_id: testWorkflowId,
          task_id: `${testWorkflowId}_task_perf_0`,
          type: 'individual_test',
          payload: { index: i },
        });
      }
      
      const endTime1 = performance.now();
      const individualDuration = endTime1 - startTime1;
      
      // Transaction-based bulk insert
      const startTime2 = performance.now();
      
      const transaction = db.transaction((count: number) => {
        for (let i = 0; i < count; i++) {
          insertEvent(db, {
            workflow_id: testWorkflowId,
            task_id: `${testWorkflowId}_task_perf_0`,
            type: 'bulk_test',
            payload: { index: i },
          });
        }
      });
      
      transaction(10);
      
      const endTime2 = performance.now();
      const bulkDuration = endTime2 - startTime2;
      
      expect(bulkDuration).toBeLessThan(individualDuration);
    } finally {
      db.close();
    }
  });
});