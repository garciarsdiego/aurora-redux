import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  newWorkflowId,
} from '../../src/db/persist.js';
import { createQualityFixTasks } from '../../src/quality/fix-tasks.js';
import { saveQualityReview } from '../../src/quality/store.js';
import type { QualityFixTaskDraft, QualityReviewRow } from '../../src/quality/types.js';
import type { Workflow } from '../../src/types/index.js';

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'quality fix-tasks unit test',
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

function seedReview(
  db: Database.Database,
  workflowId: string,
  fixTasks: QualityFixTaskDraft[],
): QualityReviewRow {
  return saveQualityReview(db, {
    workflowId,
    scope: 'workflow_final',
    reviewerKind: 'robust_ai',
    outcome: 'needs_fixes',
    score: 0.4,
    fixTasks,
  });
}

describe('createQualityFixTasks', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('drafts a fix-task from a review draft and links it to the source review', () => {
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);
    const review = seedReview(db, workflow.id, [
      {
        title: 'Repair Tetris controls',
        kind: 'cli_spawn',
        objective: 'Align UI copy with implemented keyboard handlers.',
        acceptanceCriteria: 'Browser smoke confirms Enter starts the game.',
        metadata: { ticket: 'F0-4' },
      },
    ]);

    const result = createQualityFixTasks(db, review);

    expect(result.existing).toHaveLength(0);
    expect(result.created).toHaveLength(1);
    const task = result.created[0]!;
    expect(task.workflow_id).toBe(workflow.id);
    expect(task.name).toBe('Repair Tetris controls');
    expect(task.kind).toBe('cli_spawn');
    expect(task.executor_hint).toBe('cli:codex');
    expect(task.status).toBe('pending');
    expect(task.acceptance_criteria).toBe(
      'Browser smoke confirms Enter starts the game.',
    );

    const parsed = JSON.parse(task.input_json ?? 'null') as {
      objective: string;
      quality_fix: {
        source: string;
        source_review_id: string;
        source_issue_index: number;
        review_outcome: string;
        metadata: Record<string, unknown>;
      };
    };
    expect(parsed.objective).toBe(
      'Align UI copy with implemented keyboard handlers.',
    );
    expect(parsed.quality_fix.source).toBe('final_quality_reviewer');
    expect(parsed.quality_fix.source_review_id).toBe(review.id);
    expect(parsed.quality_fix.source_issue_index).toBe(0);
    expect(parsed.quality_fix.review_outcome).toBe('needs_fixes');
    expect(parsed.quality_fix.metadata).toEqual({ ticket: 'F0-4' });

    const events = db
      .prepare(
        `SELECT type, payload_json FROM events WHERE workflow_id = ? AND type = ?`,
      )
      .all(workflow.id, 'workflow_quality_fix_tasks_created') as Array<{
      type: string;
      payload_json: string;
    }>;
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload_json) as {
      review_id: string;
      task_ids: string[];
      task_count: number;
    };
    expect(payload.review_id).toBe(review.id);
    expect(payload.task_count).toBe(1);
    expect(payload.task_ids).toEqual([task.id]);
  });

  it('redacts secrets that came in via fix-task drafts before persisting tasks', () => {
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);
    const review = seedReview(db, workflow.id, [
      {
        title: 'Rotate leaked credential',
        kind: 'cli_spawn',
        objective:
          'The .env contained OPENAI_API_KEY=sk-secret123456789abcdef and a Bearer abc.def.ghi token; rotate them.',
        acceptanceCriteria: 'Secrets removed from history and rotated.',
        metadata: { password: 'do-not-store-me' },
      },
    ]);

    // The store layer redacts at save-time, so reading the row back should
    // already show masked values; createQualityFixTasks must NEVER re-introduce
    // the raw secret into the task input_json it persists.
    expect(review.fix_tasks_json).not.toContain('sk-secret');
    expect(review.fix_tasks_json).not.toContain('abc.def.ghi');
    expect(review.fix_tasks_json).not.toContain('do-not-store-me');

    const result = createQualityFixTasks(db, review);
    expect(result.created).toHaveLength(1);

    const task = result.created[0]!;
    const inputJson = task.input_json ?? '';
    expect(inputJson).not.toContain('sk-secret');
    expect(inputJson).not.toContain('abc.def.ghi');
    expect(inputJson).not.toContain('do-not-store-me');

    // Sanity: the redacted objective is still threaded into the task input.
    // Multiple redaction patterns can match the same secret; what matters is
    // that the raw value is gone and a masked form (`***`) takes its place.
    const parsed = JSON.parse(inputJson) as { objective: string };
    expect(parsed.objective).toContain('OPENAI_API_KEY=***');
    expect(parsed.objective).toContain('Bearer ***');
  });

  it('is idempotent: a second call returns the existing fix-tasks instead of creating duplicates', () => {
    const workflow = makeWorkflow();
    insertWorkflow(db, workflow);
    const review = seedReview(db, workflow.id, [
      {
        title: 'Add missing test coverage',
        kind: 'cli_spawn',
        objective: 'Cover quality/fix-tasks.ts with unit tests.',
        acceptanceCriteria: 'tests/unit/quality-fix-tasks.test.ts exists and passes.',
      },
    ]);

    const first = createQualityFixTasks(db, review);
    expect(first.created).toHaveLength(1);
    expect(first.existing).toHaveLength(0);

    const second = createQualityFixTasks(db, review);
    expect(second.created).toHaveLength(0);
    expect(second.existing).toHaveLength(1);
    expect(second.existing[0]!.id).toBe(first.created[0]!.id);

    // Only one creation event should have fired across both calls.
    const events = db
      .prepare(
        `SELECT id FROM events WHERE workflow_id = ? AND type = ?`,
      )
      .all(workflow.id, 'workflow_quality_fix_tasks_created') as Array<{
      id: number;
    }>;
    expect(events).toHaveLength(1);
  });
});
