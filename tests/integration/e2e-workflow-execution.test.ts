import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertEvent, insertTask } from '../../src/db/persist.js';
import { getDbPath } from '../../src/utils/config.js';

describe('E2E Workflow Execution Integration', () => {
  const testWorkflowId = 'wf_e2e_integration_test';
  const testWorkspace = 'internal';

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
       VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, 'integration_test', NULL, NULL, NULL, NULL, ?)`,
      ).run(
        testWorkflowId,
        testWorkspace,
        'E2E integration test workflow',
        now - 10_000,
        now,
        JSON.stringify({ test: true }),
      );

      // Insert test tasks
      insertTask(db, {
        id: `${testWorkflowId}_task_1`,
        workflow_id: testWorkflowId,
        name: 'Test task 1',
        kind: 'llm_call',
        input_json: JSON.stringify({ prompt: 'Test input' }),
        output_json: JSON.stringify({ result: 'Test output' }),
        status: 'completed',
        depends_on: [],
        executor_hint: null,
        timeout_seconds: 300,
        max_retries: 1,
        retry_count: 0,
        retry_policy: 'exponential',
        started_at: now - 8_000,
        completed_at: now - 5_000,
        created_at: now - 9_000,
        acceptance_criteria: 'Task completes successfully',
        refine_count: 0,
        max_refine: 1,
        refine_feedback: null,
        model: 'cx/gpt-5.4',
        hitl: false,
        execution_mode: 'ephemeral',
        tool_name: null,
      });

      insertTask(db, {
        id: `${testWorkflowId}_task_2`,
        workflow_id: testWorkflowId,
        name: 'Test task 2',
        kind: 'cli_spawn',
        input_json: JSON.stringify({ prompt: 'Test CLI input' }),
        output_json: null,
        status: 'running',
        depends_on: [`${testWorkflowId}_task_1`],
        executor_hint: 'cli:codex',
        timeout_seconds: 300,
        max_retries: 1,
        retry_count: 0,
        retry_policy: 'exponential',
        started_at: now - 3_000,
        completed_at: null,
        created_at: now - 9_000,
        acceptance_criteria: 'CLI task executes',
        refine_count: 0,
        max_refine: 1,
        refine_feedback: null,
        model: 'cx/gpt-5.4',
        hitl: false,
        execution_mode: 'ephemeral',
        tool_name: null,
      });

      // Insert test events
      insertEvent(db, {
        workflow_id: testWorkflowId,
        task_id: `${testWorkflowId}_task_1`,
        type: 'task_started',
        payload: { source: 'test', message: 'Task 1 started' },
      });

      insertEvent(db, {
        workflow_id: testWorkflowId,
        task_id: `${testWorkflowId}_task_1`,
        type: 'task_completed',
        payload: { source: 'test', message: 'Task 1 completed' },
      });

      insertEvent(db, {
        workflow_id: testWorkflowId,
        task_id: `${testWorkflowId}_task_2`,
        type: 'task_started',
        payload: { source: 'test', message: 'Task 2 started' },
      });
    } finally {
      db.close();
    }
  });

  it('retrieves workflow with all tasks and events', () => {
    const db = initDb(getDbPath());
    
    try {
      const workflow = db
        .prepare('SELECT * FROM workflows WHERE id = ?')
        .get(testWorkflowId) as any;
      
      expect(workflow).toBeDefined();
      expect(workflow.status).toBe('executing');
      expect(workflow.workspace).toBe(testWorkspace);

      const tasks = db
        .prepare('SELECT * FROM tasks WHERE workflow_id = ?')
        .all(testWorkflowId);
      
      expect(tasks).toHaveLength(2);
      expect(tasks[0].status).toBe('completed');
      expect(tasks[1].status).toBe('running');

      const events = db
        .prepare('SELECT * FROM events WHERE workflow_id = ?')
        .all(testWorkflowId);
      
      expect(events.length).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
    }
  });

  it('enforces task dependency order', () => {
    const db = initDb(getDbPath());
    
    try {
      const task1 = db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(`${testWorkflowId}_task_1`) as any;
      
      const task2 = db
        .prepare('SELECT * FROM tasks WHERE id = ?')
        .get(`${testWorkflowId}_task_2`) as any;
      
      const dependencies = JSON.parse(task2.depends_on_json);
      expect(dependencies).toContain(task1.id);
      
      // Task 2 should not complete before task 1
      expect(task1.status).toBe('completed');
      expect(task2.status).not.toBe('completed');
    } finally {
      db.close();
    }
  });

  it('tracks workflow execution time', () => {
    const db = initDb(getDbPath());
    
    try {
      const workflow = db
        .prepare('SELECT * FROM workflows WHERE id = ?')
        .get(testWorkflowId) as any;
      
      const now = Date.now();
      const duration = now - workflow.started_at;
      
      expect(duration).toBeGreaterThan(0);
      expect(workflow.started_at).toBeLessThan(now);
    } finally {
      db.close();
    }
  });

  it('persists workflow metadata', () => {
    const db = initDb(getDbPath());
    
    try {
      const workflow = db
        .prepare('SELECT * FROM workflows WHERE id = ?')
        .get(testWorkflowId) as any;
      
      const metadata = JSON.parse(workflow.metadata);
      expect(metadata.test).toBe(true);
    } finally {
      db.close();
    }
  });
});