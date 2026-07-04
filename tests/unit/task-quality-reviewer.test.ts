import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../../src/db/persist.js';
import {
  enforceLightTaskQualityReview,
  QualityGateFailedError,
  runLightTaskQualityReview,
} from '../../src/quality/task-reviewer.js';
import { parseQualityIssues } from '../../src/quality/store.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'review quality',
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

function makeTask(workflowId: string, worktreeRoot: string, acceptance: string, id = newTaskId()): Task {
  const now = Date.now();
  return {
    id,
    workflow_id: workflowId,
    name: 'Quality task',
    kind: 'cli_spawn',
    input_json: JSON.stringify({ execution_context: { worktree_root: worktreeRoot } }),
    output_json: 'Implemented the task.',
    status: 'completed',
    depends_on: [],
    executor_hint: 'cli:codex',
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: now,
    completed_at: now,
    created_at: now,
    acceptance_criteria: acceptance,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

describe('light task quality reviewer', () => {
  it('refuses to run when mode is off and never writes a quality row', async () => {
    const db = initDb(':memory:');
    const tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-reviewer-off-'));
    try {
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, tempRoot, 'src/App.tsx exists');
      insertWorkflow(db, workflow);
      insertTask(db, task);
      let invokerCalls = 0;

      // Direct call must throw — off mode is not a valid runtime state for runLightTaskQualityReview.
      await expect(
        runLightTaskQualityReview(db, {
          workflowId: workflow.id,
          taskId: task.id,
          mode: 'off',
          invoker: async () => {
            invokerCalls += 1;
            return '{"outcome":"passed","score":1,"issues":[]}';
          },
        }),
      ).rejects.toThrow(/disabled/i);

      // Enforce wrapper must short-circuit to null without invoking the model
      // and without persisting a quality_reviews row or any task_quality_* event.
      const enforced = await enforceLightTaskQualityReview(db, {
        workflowId: workflow.id,
        taskId: task.id,
        mode: 'off',
        invoker: async () => {
          invokerCalls += 1;
          return '{"outcome":"passed","score":1,"issues":[]}';
        },
      });

      expect(enforced).toBeNull();
      expect(invokerCalls).toBe(0);

      const reviewCount = db
        .prepare('SELECT COUNT(*) AS n FROM quality_reviews WHERE workflow_id = ?')
        .get(workflow.id) as { n: number };
      const eventCount = db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND type LIKE 'task_quality_%'")
        .get(workflow.id) as { n: number };
      const taskRow = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };

      expect(reviewCount.n).toBe(0);
      expect(eventCount.n).toBe(0);
      expect(taskRow.status).toBe('completed');
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails from filesystem evidence without spending an AI call', async () => {
    const db = initDb(':memory:');
    const tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-reviewer-'));
    try {
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, tempRoot, 'src/Missing.tsx exists');
      insertWorkflow(db, workflow);
      insertTask(db, task);
      let calls = 0;

      const review = await runLightTaskQualityReview(db, {
        workflowId: workflow.id,
        taskId: task.id,
        mode: 'dry-run',
        invoker: async () => {
          calls += 1;
          return '{"outcome":"passed","score":1,"issues":[]}';
        },
      });

      expect(calls).toBe(0);
      expect(review.outcome).toBe('needs_fixes');
      expect(parseQualityIssues(review)[0]?.code).toBe('filesystem_acceptance_failed');
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('stores AI reviewer output in dry-run mode without blocking the task', async () => {
    const db = initDb(':memory:');
    const tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-reviewer-ok-'));
    try {
      mkdirSync(join(tempRoot, 'src'), { recursive: true });
      writeFileSync(
        join(tempRoot, 'src', 'App.tsx'),
        ['export function App() {', '  return <main>OK</main>;', '}', 'export default App;', '// ok'].join('\n'),
      );
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, tempRoot, 'src/App.tsx exists with healthy content');
      insertWorkflow(db, workflow);
      insertTask(db, task);

      const review = await runLightTaskQualityReview(db, {
        workflowId: workflow.id,
        taskId: task.id,
        mode: 'dry-run',
        model: 'test/light-reviewer',
        invoker: async (input) => {
          expect(input.userPrompt).toContain('src/App.tsx');
          return JSON.stringify({
            outcome: 'passed',
            score: 0.91,
            issues: [],
          });
        },
      });

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
      expect(review.reviewer_model).toBe('test/light-reviewer');
      expect(review.outcome).toBe('passed');
      expect(review.score).toBe(0.91);
      expect(row.status).toBe('completed');
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('marks the task failed when enforced quality review blocks completion', async () => {
    const db = initDb(':memory:');
    const tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-quality-reviewer-block-'));
    try {
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, tempRoot, 'src/Missing.tsx exists');
      insertWorkflow(db, workflow);
      insertTask(db, task);

      await expect(enforceLightTaskQualityReview(db, {
        workflowId: workflow.id,
        taskId: task.id,
        mode: 'enforced',
      })).rejects.toBeInstanceOf(QualityGateFailedError);

      const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as { status: string };
      const blockedEvent = db
        .prepare("SELECT type FROM events WHERE workflow_id = ? AND task_id = ? AND type = 'task_quality_gate_blocked'")
        .get(workflow.id, task.id) as { type: string } | undefined;
      expect(row.status).toBe('failed');
      expect(blockedEvent?.type).toBe('task_quality_gate_blocked');
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
