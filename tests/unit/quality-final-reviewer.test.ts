import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  insertTask,
  insertWorkflow,
  loadWorkflowTasks,
  newTaskId,
  newWorkflowId,
} from '../../src/db/persist.js';
import {
  enforceFinalQualityReview,
  FinalQualityGateFailedError,
  type FinalQualityReviewInvoker,
} from '../../src/quality/final-reviewer.js';
import { listQualityReviewsForWorkflow } from '../../src/quality/store.js';
import type Database from 'better-sqlite3';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(objective: string): Workflow {
  const now = Date.now();
  return {
    id: newWorkflowId(),
    workspace: 'internal',
    objective,
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: 'quality-final-reviewer-test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(workflowId: string, root: string, name: string): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: workflowId,
    name,
    kind: 'cli_spawn',
    input_json: JSON.stringify({ execution_context: { worktree_root: root } }),
    output_json: `${name} delivered files under ${root}.`,
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
    acceptance_criteria: 'The delivered web app behavior must match the visible UI instructions.',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function writeGoodMiniApp(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'App.tsx'),
    [
      'export function App() {',
      '  return <main><h1>Mini blocks</h1><p>Press Enter to start. Move with ArrowLeft and ArrowRight.</p></main>;',
      '}',
      'window.addEventListener("keydown", (event) => {',
      '  if (event.key === "Enter") console.log("start");',
      '  if (event.key === "ArrowLeft") console.log("left");',
      '  if (event.key === "ArrowRight") console.log("right");',
      '});',
    ].join('\n'),
  );
}

function writeBadMiniApp(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'App.tsx'),
    [
      'export function App() {',
      '  return <main><h1>Mini blocks</h1><p>Press Enter to start. Move with A/D. Hold with C.</p></main>;',
      '}',
      'window.addEventListener("keydown", (event) => {',
      '  if (event.key === "ArrowLeft") console.log("left");',
      '  if (event.key === "ArrowRight") console.log("right");',
      '});',
    ].join('\n'),
  );
}

describe('enforceFinalQualityReview', () => {
  let db: Database.Database;
  let tempRoot: string;
  const previousModeEnv = process.env.OMNIFORGE_FINAL_QUALITY_REVIEW;

  beforeEach(() => {
    db = initDb(':memory:');
    tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-final-reviewer-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
    if (previousModeEnv === undefined) delete process.env.OMNIFORGE_FINAL_QUALITY_REVIEW;
    else process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = previousModeEnv;
  });

  it('returns null and writes no review when mode is "off"', async () => {
    process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = 'off';
    const workflow = makeWorkflow('off mode should skip entirely');
    insertWorkflow(db, workflow);
    insertTask(db, makeTask(workflow.id, tempRoot, 'no-op task'));

    // Invoker that fails loudly if the LLM path is touched in off mode.
    const invoker: FinalQualityReviewInvoker = async () => {
      throw new Error('invoker must not be called when mode=off');
    };

    const result = await enforceFinalQualityReview(db, {
      workflowId: workflow.id,
      mode: 'off',
      invoker,
    });

    expect(result).toBeNull();
    expect(listQualityReviewsForWorkflow(db, workflow.id)).toHaveLength(0);
  });

  it('persists a passed dry-run review when evidence is clean', async () => {
    process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = 'dry-run';
    writeGoodMiniApp(tempRoot);
    const workflow = makeWorkflow('Build a small playable web app with accurate controls');
    insertWorkflow(db, workflow);
    insertTask(db, makeTask(workflow.id, tempRoot, 'Build good mini app'));

    // Harness should pass on the good app, so the function falls through to
    // the LLM invoker path. Stub the invoker with a strict-passing JSON
    // response so we never hit Omniroute in the unit test.
    const invoker: FinalQualityReviewInvoker = async () =>
      JSON.stringify({
        outcome: 'passed',
        score: 0.92,
        issues: [],
        fixTasks: [],
      });

    const review = await enforceFinalQualityReview(db, {
      workflowId: workflow.id,
      mode: 'dry-run',
      model: 'test/stub-model',
      invoker,
    });

    expect(review).not.toBeNull();
    expect(review!.outcome).toBe('passed');
    expect(review!.scope).toBe('workflow_final');
    expect(review!.run_mode).toBe('dry-run');
    expect(review!.reviewer_kind).toBe('robust_ai');
    expect(review!.reviewer_model).toBe('test/stub-model');
    expect(review!.score).toBeCloseTo(0.92, 5);

    // Dry-run + passed must not create fix tasks: only the seed task remains.
    const remainingTasks = loadWorkflowTasks(db, workflow.id);
    expect(remainingTasks).toHaveLength(1);
    expect(remainingTasks.every((task) => task.status !== 'pending')).toBe(true);
  });

  it('blocks the workflow and creates fix tasks when enforced mode hits harness issues', async () => {
    // Enforced mode is the only mode that creates fix tasks + raises
    // FinalQualityGateFailedError. Dry-run with bad evidence still records
    // the review but does NOT create fix tasks (see final-reviewer.ts L289).
    process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = 'enforced';
    writeBadMiniApp(tempRoot);
    const workflow = makeWorkflow('Build a small playable web app with mismatched controls');
    insertWorkflow(db, workflow);
    insertTask(db, makeTask(workflow.id, tempRoot, 'Build bad mini app'));

    // Invoker should never be called: harness produces issues first and
    // short-circuits the LLM path (see final-reviewer.ts L188-220).
    const invoker: FinalQualityReviewInvoker = async () => {
      throw new Error('invoker must not be called when harness already failed');
    };

    let caught: unknown = null;
    try {
      await enforceFinalQualityReview(db, {
        workflowId: workflow.id,
        mode: 'enforced',
        invoker,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(FinalQualityGateFailedError);
    const reviews = listQualityReviewsForWorkflow(db, workflow.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.outcome).toBe('needs_fixes');
    expect(reviews[0]!.run_mode).toBe('approved-run');
    expect(reviews[0]!.reviewer_kind).toBe('browser_harness');

    // At least one fix task draft should be persisted as a pending task.
    const pendingFixTasks = loadWorkflowTasks(db, workflow.id).filter(
      (task) => task.status === 'pending',
    );
    expect(pendingFixTasks.length).toBeGreaterThan(0);
  });
});
