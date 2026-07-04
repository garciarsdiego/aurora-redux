import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../../src/db/persist.js';
import {
  latestFinalQualityReview,
  listQualityReviewsForTask,
  listQualityReviewsForWorkflow,
  parseQualityEvidence,
  parseQualityFixTasks,
  parseQualityIssues,
  saveQualityReview,
} from '../../src/quality/store.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'quality review store test',
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

function makeTask(workflowId: string, id = newTaskId()): Task {
  const now = Date.now();
  return {
    id,
    workflow_id: workflowId,
    name: 'Create usable Tetris controls',
    kind: 'cli_spawn',
    input_json: null,
    output_json: null,
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
    acceptance_criteria: 'The playable app controls must match the UI copy.',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

describe('quality review store', () => {
  it('persists task quality reviews with redacted issues, evidence, and fix tasks', () => {
    const db = initDb(':memory:');
    const workflow = makeWorkflow();
    const task = makeTask(workflow.id);
    insertWorkflow(db, workflow);
    insertTask(db, task);

    const review = saveQualityReview(db, {
      workflowId: workflow.id,
      taskId: task.id,
      scope: 'task',
      reviewerKind: 'light_ai',
      reviewerModel: 'deepseek/deepseek-v4-flash',
      outcome: 'needs_fixes',
      score: 0.42,
      issues: [
        {
          severity: 'blocking',
          code: 'ui_controls_mismatch',
          origin: 'browser_harness',
          message: 'OPENAI_API_KEY=sk-secret123456789 appeared near a broken control report',
          suggestedAction: 'Align UI instructions with implemented keyboard handlers.',
          safeContext: { Authorization: 'Bearer abc.def.ghi' },
        },
      ],
      evidence: [
        {
          kind: 'browser',
          label: 'Headless gameplay smoke',
          path: 'data/worktrees/internal/tetris-headless.png',
          metadata: { token: 'mcp-secret123456' },
        },
      ],
      fixTasks: [
        {
          title: 'Fix Tetris controls',
          kind: 'cli_spawn',
          objective: 'Repair controls and copy',
          acceptanceCriteria: 'Browser smoke confirms Enter starts game.',
          metadata: { password: 'dont-store-me' },
        },
      ],
    });

    expect(review.id).toMatch(/^qr_/);
    expect(review.workflow_id).toBe(workflow.id);
    expect(review.task_id).toBe(task.id);
    expect(review.outcome).toBe('needs_fixes');
    expect(review.score).toBe(0.42);
    expect(review.issues_json).not.toContain('sk-secret');
    expect(review.issues_json).not.toContain('abc.def.ghi');
    expect(review.evidence_json).not.toContain('mcp-secret');
    expect(review.fix_tasks_json).not.toContain('dont-store-me');
    expect(parseQualityIssues(review)[0]?.safeContext?.Authorization).toBe('Bearer ***');
    expect(parseQualityEvidence(review)[0]?.kind).toBe('browser');
    expect(parseQualityFixTasks(review)[0]?.title).toBe('Fix Tetris controls');

    const taskReviews = listQualityReviewsForTask(db, task.id);
    expect(taskReviews).toHaveLength(1);
    expect(taskReviews[0]?.id).toBe(review.id);

    db.close();
  });

  it('lists workflow reviews and returns the latest final quality gate', () => {
    const db = initDb(':memory:');
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);

    saveQualityReview(db, {
      workflowId: workflow.id,
      scope: 'workflow_final',
      reviewerKind: 'robust_ai',
      outcome: 'needs_fixes',
      score: 0.3,
      createdAt: 100,
    });
    const latest = saveQualityReview(db, {
      workflowId: workflow.id,
      scope: 'workflow_final',
      reviewerKind: 'robust_ai',
      outcome: 'passed',
      score: 0.93,
      createdAt: 200,
    });

    const reviews = listQualityReviewsForWorkflow(db, workflow.id);
    expect(reviews.map((review) => review.created_at)).toEqual([100, 200]);
    expect(latestFinalQualityReview(db, workflow.id)?.id).toBe(latest.id);

    db.close();
  });

  it('normalizes invalid scores while preserving null for skipped reviews', () => {
    const db = initDb(':memory:');
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);

    const high = saveQualityReview(db, {
      workflowId: workflow.id,
      scope: 'task',
      reviewerKind: 'heuristic',
      outcome: 'passed',
      score: 2,
    });
    const skipped = saveQualityReview(db, {
      workflowId: workflow.id,
      scope: 'task',
      reviewerKind: 'light_ai',
      outcome: 'skipped',
      score: Number.NaN,
    });

    expect(high.score).toBe(1);
    expect(skipped.score).toBeNull();

    db.close();
  });
});
