import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { executeWorkflow } from '../../src/brain/executor.js';
import { reviewAndRefine } from '../../src/brain/executor/refine.js';
import { initDb } from '../../src/db/client.js';
import { insertTask, insertWorkflow } from '../../src/db/persist.js';
import type { Dag, Task, ReviewResult, Workflow } from '../../src/types/index.js';

// D34.5 Bug A regression — reviewer hang must not block workflow completion.

function setupDb(): Database.Database {
  return initDb(':memory:');
}

describe('reviewAndRefine timeout (Bug A)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Very short timeouts so the test runs fast
    process.env.MAX_REVIEW_TIME_MS = '150';
    process.env.MAX_CONSOLIDATE_TIME_MS = '150';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('emits task_review_timeout when reviewer hangs, aborts workflow', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'generate something',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          acceptance_criteria: 'must be useful',
          model: null,
        },
      ],
    };

    // Reviewer hangs forever
    const hangingReviewer = vi.fn(
      () => new Promise<ReviewResult>(() => {}), // never resolves
    );

    const stubExecute = async (_task: Task): Promise<string> => 'some output';
    const stubConsolidate = async (_wf: Workflow, _tasks: Task[]) => 'consolidated';

    let thrownError;
    try {
      await executeWorkflow(db, dag, '__test__', 'test objective', {
        executeTaskFn: stubExecute,
        reviewFn: hangingReviewer,
        consolidateFn: stubConsolidate,
        autoApprove: true,
      });
    } catch (e) {
      thrownError = e;
    }
    expect(thrownError).toBeDefined();

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    expect(wfRow.status).toBe('failed');

    const events = db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY timestamp')
      .all(wfRow.id) as Array<{ type: string }>;
    const types = events.map((e) => e.type);

    expect(types).toContain('task_review_timeout');

    db.close();
  });

  it('emits workflow_consolidation_timeout when consolidator hangs, still closes workflow', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'do something',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          acceptance_criteria: null, // no reviewer
          model: null,
        },
      ],
    };

    const stubExecute = async (_task: Task): Promise<string> => 'output';
    const hangingConsolidator = vi.fn(
      () => new Promise<string>(() => {}), // never resolves
    );

    const wf = await executeWorkflow(db, dag, '__test__', 'test', {
      executeTaskFn: stubExecute,
      consolidateFn: hangingConsolidator,
      autoApprove: true,
    });

    expect(wf.status).toBe('completed'); // still closes despite consolidator hang

    const events = db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY timestamp')
      .all(wf.id) as Array<{ type: string }>;
    const types = events.map((e) => e.type);

    expect(types).toContain('workflow_consolidation_timeout');
    expect(types).toContain('workflow_completed');

    db.close();
  });

  it('fast reviewer still works normally (no timeout triggered)', async () => {
    const db = setupDb();
    process.env.MAX_REVIEW_TIME_MS = '5000';

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'produce thing',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          acceptance_criteria: 'short criteria',
          model: null,
        },
      ],
    };

    const stubExecute = async (): Promise<string> => 'output';
    const passingReviewer = async (): Promise<ReviewResult> => ({
      score: 0.9,
      feedback: 'looks good',
      passed: true,
    });
    const stubConsolidate = async () => 'done';

    const wf = await executeWorkflow(db, dag, '__test__', 'test', {
      executeTaskFn: stubExecute,
      reviewFn: passingReviewer,
      consolidateFn: stubConsolidate,
      autoApprove: true,
    });

    const events = db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY timestamp')
      .all(wf.id) as Array<{ type: string }>;
    const types = events.map((e) => e.type);

    expect(types).toContain('task_reviewed');
    expect(types).not.toContain('task_review_timeout');
    expect(types).toContain('workflow_completed');

    db.close();
  });

  it('does not fail a cli task when reviewer times out but filesystem evidence verifies the artifact', async () => {
    const db = setupDb();
    process.env.MAX_REVIEW_TIME_MS = '80';
    const ws = mkdtempSync(path.join(tmpdir(), 'omniforge-review-timeout-fs-'));

    try {
      const wf: Workflow = {
        id: 'wf_fs_timeout',
        workspace: '__test__',
        objective: 'review timeout with verified artifact',
        pattern_id: null,
        status: 'executing',
        started_at: Date.now(),
        completed_at: null,
        created_at: Date.now(),
        created_by: null,
        estimated_cost_usd: null,
        actual_cost_usd: null,
        max_total_cost_usd: null,
        max_duration_seconds: null,
        metadata: null,
      };
      insertWorkflow(db, wf);

      const target = path.join(ws, 'src/data/mock.ts');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(
        target,
        [
          'export const mockWorkspace = { id: "ws_1" };',
          'export const mockProjects = [{ id: "prj_1" }];',
          'export const mockTasks = [{ id: "task_1" }];',
          'export const mockUsers = [{ id: "user_1" }];',
          'export const mockComments = [{ id: "comment_1" }];',
          'export const mockTimeEntries = [{ id: "time_1" }];',
        ].join('\n'),
        'utf-8',
      );

      const task: Task = {
        id: 'tk_fs_timeout',
        workflow_id: wf.id,
        name: 'Create mock data',
        kind: 'cli_spawn',
        input_json: null,
        output_json: 'worker output',
        status: 'completed',
        depends_on: [],
        executor_hint: 'cli:claude-code',
        timeout_seconds: 300,
        max_retries: 3,
        retry_count: 0,
        retry_policy: 'exponential',
        started_at: Date.now(),
        completed_at: Date.now(),
        created_at: Date.now(),
        acceptance_criteria: 'src/data/mock.ts exports mockWorkspace, mockProjects, mockTasks, mockUsers',
        refine_count: 0,
        max_refine: 2,
        refine_feedback: null,
        model: 'cx/gpt-5.4',
        hitl: false,
        workspace: '__test__',
      };
      insertTask(db, task);

      const hangingReviewer = vi.fn(() => new Promise<ReviewResult>(() => {}));
      await expect(
        reviewAndRefine(
          db,
          task,
          wf.id,
          'Implemented comprehensive mock data in src/data/mock.ts',
          async () => 'unused',
          hangingReviewer,
          0,
          1000,
          { workflowId: wf.id, taskId: task.id, workspaceDir: ws },
        ),
      ).resolves.toBeUndefined();

      const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
      expect(taskRow.status).toBe('completed');
      const events = db
        .prepare('SELECT type, payload_json FROM events WHERE task_id = ? ORDER BY id')
        .all(task.id) as Array<{ type: string; payload_json: string | null }>;
      expect(events.map((e) => e.type)).toContain('task_review_timeout');
      const outcome = events.find((e) => e.type === 'task_review_outcome');
      expect(outcome?.payload_json).toContain('soft_success');
      expect(outcome?.payload_json).toContain('reviewer_timeout_filesystem_verified');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      db.close();
    }
  });

});
