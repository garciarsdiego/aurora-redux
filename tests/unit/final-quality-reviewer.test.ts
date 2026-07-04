import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../../src/db/persist.js';
import { buildFinalProductEvidenceBundle } from '../../src/quality/final-evidence.js';
import {
  enforceFinalQualityReview,
  FinalQualityGateFailedError,
  runFinalQualityReview,
} from '../../src/quality/final-reviewer.js';
import { parseQualityFixTasks, parseQualityIssues } from '../../src/quality/store.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(id = newWorkflowId()): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'internal',
    objective: 'Build a polished playable Tetris web app',
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

function makeTask(workflowId: string, root: string): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: workflowId,
    name: 'Build Tetris UI',
    kind: 'cli_spawn',
    input_json: JSON.stringify({ execution_context: { worktree_root: root } }),
    output_json: 'Built a Tetris app.',
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
    acceptance_criteria: 'A playable Tetris app is delivered.',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function writeBadTetris(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'App.tsx'),
    [
      'export function App() {',
      '  return <p>Press Enter to start. Move with A/D. Hold with C.</p>;',
      '}',
      'window.addEventListener("keydown", (event) => {',
      '  if (event.key === "ArrowLeft") console.log("left");',
      '  if (event.key === "ArrowRight") console.log("right");',
      '});',
    ].join('\n'),
  );
}

describe('final product quality reviewer', () => {
  it('detects Tetris control-copy mismatches from real product files', () => {
    const db = initDb(':memory:');
    const root = mkdtempSync(join(tmpdir(), 'omniforge-final-quality-'));
    try {
      writeBadTetris(root);
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, root);
      insertWorkflow(db, workflow);
      insertTask(db, task);

      const bundle = buildFinalProductEvidenceBundle(db, workflow.id);
      expect(bundle.productHarness.status).toBe('failed');
      expect(bundle.productHarness.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'control_copy_enter_unimplemented',
          'control_copy_ad_unimplemented',
          'control_copy_hold_unimplemented',
        ]),
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stores fix task drafts when final harness finds product issues', async () => {
    const db = initDb(':memory:');
    const root = mkdtempSync(join(tmpdir(), 'omniforge-final-quality-review-'));
    try {
      writeBadTetris(root);
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, root);
      insertWorkflow(db, workflow);
      insertTask(db, task);

      const review = await runFinalQualityReview(db, {
        workflowId: workflow.id,
        mode: 'dry-run',
      });

      expect(review.outcome).toBe('needs_fixes');
      expect(parseQualityIssues(review).length).toBeGreaterThan(0);
      expect(parseQualityFixTasks(review).length).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks workflow completion in enforced mode before workflow_completed', async () => {
    const db = initDb(':memory:');
    const root = mkdtempSync(join(tmpdir(), 'omniforge-final-quality-block-'));
    try {
      writeBadTetris(root);
      const workflow = makeWorkflow();
      const task = makeTask(workflow.id, root);
      insertWorkflow(db, workflow);
      insertTask(db, task);

      await expect(enforceFinalQualityReview(db, {
        workflowId: workflow.id,
        mode: 'enforced',
      })).rejects.toBeInstanceOf(FinalQualityGateFailedError);

      const row = db.prepare('SELECT status FROM workflows WHERE id = ?').get(workflow.id) as { status: string };
      const events = db.prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id').all(workflow.id) as Array<{ type: string }>;
      const tasks = db.prepare('SELECT id, status, input_json FROM tasks WHERE workflow_id = ? ORDER BY created_at').all(workflow.id) as Array<{ id: string; status: string; input_json: string }>;
      expect(row.status).toBe('failed');
      expect(tasks).toHaveLength(4);
      expect(tasks.slice(1).every((pending) => pending.status === 'pending')).toBe(true);
      expect(tasks.slice(1).every((pending) => pending.input_json.includes('"source_review_id"'))).toBe(true);
      expect(events.map((event) => event.type)).toContain('workflow_quality_fix_tasks_created');
      expect(events.map((event) => event.type)).toContain('workflow_final_quality_gate_blocked');
      expect(events.map((event) => event.type)).not.toContain('workflow_completed');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
