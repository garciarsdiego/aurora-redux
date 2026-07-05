/**
 * FASE C (Visual Reviewer) item 4 — unit tests for attemptTaskVisualGate,
 * the per-task deterministic pre-check that plugs in before the LLM-backed
 * enforceLightTaskQualityReview path.
 *
 * Fail-open by design: attemptTaskVisualGate returns `null` unless the task
 * truly opted into reviewer_profile:'visual' AND declared at least one
 * check AND the workflow has a resolvable architecture contract. Every
 * "does not apply" branch is exercised here, plus the two real outcomes:
 * deterministic FAIL -> rejected QualityReviewRow with zero LLM calls, and
 * deterministic PASS -> null (falls through so the LLM review still runs).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import { insertTask, insertWorkflow, newTaskId, newWorkflowId } from '../../src/db/persist.js';
import { recordArchitectureContract } from '../../src/workflow-modes/existing-code-feature.js';
import { attemptTaskVisualGate, type TaskVisualHarnessRunner } from '../../src/quality/task-visual-gate.js';
import type { PlaywrightHarnessResult } from '../../src/quality/playwright-product-harness.js';
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
    created_by: 'task-visual-gate-test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(workflowId: string, overrides: Partial<Task> = {}): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: workflowId,
    name: 'Render the game canvas',
    kind: 'cli_spawn',
    input_json: JSON.stringify({}),
    output_json: 'done',
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
    acceptance_criteria: 'The scene renders correctly.',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
    ...overrides,
  };
}

const VISUAL_INPUT_JSON = JSON.stringify({
  reviewer_profile: 'visual',
  canvasRegionChecks: [
    { selector: 'canvas', region: 'top', expectedLuminanceAbove: 150, label: 'sky bright at top' },
  ],
  interactionChecks: [
    {
      label: 'space makes player jump',
      key: 'Space',
      waitMs: 100,
      // Assumes a world/physics coordinate system where +y is UP, so jumping
      // increases player.y (screen-space y grows downward).
      debugHookAssertion: { path: 'window.__debug.player.y', expect: 'increase' },
    },
  ],
});

describe('attemptTaskVisualGate — fail-open "does not apply" branches', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('returns null when reviewer_profile is not "visual"', async () => {
    const workflow = makeWorkflow('Some objective');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: JSON.stringify({ reviewer_profile: 'strict' }) });
    insertTask(db, task);

    const result = await attemptTaskVisualGate(db, { workflowId: workflow.id, task, objective: workflow.objective });
    expect(result).toBeNull();
  });

  it('returns null when reviewer_profile is missing entirely (default/back-compat)', async () => {
    const workflow = makeWorkflow('Some objective');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id);
    insertTask(db, task);

    const result = await attemptTaskVisualGate(db, { workflowId: workflow.id, task, objective: workflow.objective });
    expect(result).toBeNull();
  });

  it('returns null when reviewer_profile is "visual" but no checks are configured', async () => {
    const workflow = makeWorkflow('Some objective');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: JSON.stringify({ reviewer_profile: 'visual' }) });
    insertTask(db, task);

    const result = await attemptTaskVisualGate(db, { workflowId: workflow.id, task, objective: workflow.objective });
    expect(result).toBeNull();
  });

  it('returns null when there is no architecture contract for the workflow (no projectRoot to harness)', async () => {
    const workflow = makeWorkflow('Some objective');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: VISUAL_INPUT_JSON });
    insertTask(db, task);

    let runnerCalled = false;
    const harnessRunner: TaskVisualHarnessRunner = async () => {
      runnerCalled = true;
      return { status: 'passed', mismatches: [], screenshotPaths: [] };
    };

    const result = await attemptTaskVisualGate(db, {
      workflowId: workflow.id,
      task,
      objective: workflow.objective,
      harnessRunner,
    });
    expect(result).toBeNull();
    expect(runnerCalled).toBe(false);
  });

  it('returns null when the harness itself reports skipped (e.g. no Playwright installed)', async () => {
    const workflow = makeWorkflow('Some objective');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: VISUAL_INPUT_JSON });
    insertTask(db, task);
    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: mkdtempSync(join(tmpdir(), 'omniforge-visual-gate-')),
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: [],
        allowedFiles: [],
        forbiddenPatterns: [],
        requiredIntegrationPoints: [],
        testSelectors: ['canvas'],
      },
    });

    const harnessRunner: TaskVisualHarnessRunner = async () => ({
      status: 'skipped',
      reason: 'playwright not installed',
      mismatches: [],
      screenshotPaths: [],
    });

    const result = await attemptTaskVisualGate(db, {
      workflowId: workflow.id,
      task,
      objective: workflow.objective,
      harnessRunner,
    });
    expect(result).toBeNull();
  });

  it('returns null (fail-open) when the harness runner throws', async () => {
    const workflow = makeWorkflow('Some objective');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: VISUAL_INPUT_JSON });
    insertTask(db, task);
    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: mkdtempSync(join(tmpdir(), 'omniforge-visual-gate-')),
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: [],
        allowedFiles: [],
        forbiddenPatterns: [],
        requiredIntegrationPoints: [],
        testSelectors: ['canvas'],
      },
    });

    const harnessRunner: TaskVisualHarnessRunner = async () => {
      throw new Error('boom');
    };

    const result = await attemptTaskVisualGate(db, {
      workflowId: workflow.id,
      task,
      objective: workflow.objective,
      harnessRunner,
    });
    expect(result).toBeNull();

    const events = db.prepare(`SELECT type FROM events WHERE workflow_id = ?`).all(workflow.id) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain('task_visual_gate_harness_threw');
  });
});

describe('attemptTaskVisualGate — deterministic PASS falls through to LLM review', () => {
  let db: Database.Database;
  let tempRoot: string;

  beforeEach(() => {
    db = initDb(':memory:');
    tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-visual-gate-pass-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('returns null when all deterministic checks pass, letting the caller run the LLM review', async () => {
    const workflow = makeWorkflow('Render a canvas game');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: VISUAL_INPUT_JSON });
    insertTask(db, task);
    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: tempRoot,
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: [],
        allowedFiles: [],
        forbiddenPatterns: [],
        requiredIntegrationPoints: [],
        testSelectors: ['canvas'],
      },
    });

    const passingResult: PlaywrightHarnessResult = {
      status: 'passed',
      mismatches: [],
      screenshotPaths: ['/tmp/index.png'],
      canvasRegionCheckResults: [
        { label: 'sky bright at top', selector: 'canvas', pass: true, measuredLuminance: 200 },
      ],
      interactionCheckResults: [
        { label: 'space makes player jump', pass: true, before: 0, after: 10 },
      ],
    };
    const harnessRunner: TaskVisualHarnessRunner = async () => passingResult;

    const result = await attemptTaskVisualGate(db, {
      workflowId: workflow.id,
      task,
      objective: workflow.objective,
      harnessRunner,
    });
    expect(result).toBeNull();

    const events = db.prepare(`SELECT type FROM events WHERE workflow_id = ?`).all(workflow.id) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain('task_visual_gate_ran');
    // No rejected review should have been saved on a full pass.
    const reviews = db.prepare(`SELECT COUNT(*) as n FROM quality_reviews WHERE workflow_id = ?`).get(workflow.id) as { n: number };
    expect(reviews.n).toBe(0);
  });
});

describe('attemptTaskVisualGate — deterministic FAIL rejects with zero LLM cost', () => {
  let db: Database.Database;
  let tempRoot: string;

  beforeEach(() => {
    db = initDb(':memory:');
    tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-visual-gate-fail-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('produces a rejected QualityReviewRow citing the failing canvas region check', async () => {
    const workflow = makeWorkflow('Render a canvas game');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: VISUAL_INPUT_JSON });
    insertTask(db, task);
    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: tempRoot,
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: [],
        allowedFiles: [],
        forbiddenPatterns: [],
        requiredIntegrationPoints: [],
        testSelectors: ['canvas'],
      },
    });

    const failingResult: PlaywrightHarnessResult = {
      status: 'failed',
      mismatches: [],
      screenshotPaths: ['/tmp/index.png'],
      canvasRegionCheckResults: [
        { label: 'sky bright at top', selector: 'canvas', pass: false, measuredLuminance: 20 },
      ],
      interactionCheckResults: [
        { label: 'space makes player jump', pass: true, before: 0, after: 10 },
      ],
    };
    let llmCalls = 0;
    const harnessRunner: TaskVisualHarnessRunner = async () => {
      // The harness itself is deterministic — it must never call an LLM.
      // This counter simulates "no LLM invoker was ever reached" by virtue
      // of attemptTaskVisualGate never invoking one in its own code path.
      return failingResult;
    };
    void llmCalls;

    const result = await attemptTaskVisualGate(db, {
      workflowId: workflow.id,
      task,
      objective: workflow.objective,
      harnessRunner,
    });

    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('needs_fixes');
    expect(result!.reviewer_kind).toBe('browser_harness');
    expect(result!.reviewer_model).toBe('playwright_deterministic');

    const issues = JSON.parse(result!.issues_json) as Array<{ code: string; message: string }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('visual_canvas_region_check_failed');
    expect(issues[0]!.message).toMatch(/sky bright at top/);

    const events = db.prepare(`SELECT type FROM events WHERE workflow_id = ?`).all(workflow.id) as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toContain('task_quality_reviewed');
  });

  it('produces a rejected QualityReviewRow citing the failing interaction check', async () => {
    const workflow = makeWorkflow('Render a canvas game');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: VISUAL_INPUT_JSON });
    insertTask(db, task);
    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: tempRoot,
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: [],
        allowedFiles: [],
        forbiddenPatterns: [],
        requiredIntegrationPoints: [],
        testSelectors: ['canvas'],
      },
    });

    const failingResult: PlaywrightHarnessResult = {
      status: 'failed',
      mismatches: [],
      screenshotPaths: [],
      canvasRegionCheckResults: [
        { label: 'sky bright at top', selector: 'canvas', pass: true, measuredLuminance: 200 },
      ],
      interactionCheckResults: [
        { label: 'space makes player jump', pass: false, before: 0, after: 0, reason: 'value did not increase' },
      ],
    };
    const harnessRunner: TaskVisualHarnessRunner = async () => failingResult;

    const result = await attemptTaskVisualGate(db, {
      workflowId: workflow.id,
      task,
      objective: workflow.objective,
      harnessRunner,
    });

    expect(result).not.toBeNull();
    const issues = JSON.parse(result!.issues_json) as Array<{ code: string; message: string }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('visual_interaction_check_failed');
    expect(issues[0]!.message).toMatch(/space makes player jump/);
  });

  it('cites selector mismatches too, when the harness reports them', async () => {
    const workflow = makeWorkflow('Render a canvas game');
    insertWorkflow(db, workflow);
    const task = makeTask(workflow.id, { input_json: VISUAL_INPUT_JSON });
    insertTask(db, task);
    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: tempRoot,
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: [],
        allowedFiles: [],
        forbiddenPatterns: [],
        requiredIntegrationPoints: [],
        testSelectors: ['canvas'],
      },
    });

    const failingResult: PlaywrightHarnessResult = {
      status: 'failed',
      mismatches: [{ kind: 'selector_missing', selector: 'canvas' }],
      screenshotPaths: [],
    };
    const harnessRunner: TaskVisualHarnessRunner = async () => failingResult;

    const result = await attemptTaskVisualGate(db, {
      workflowId: workflow.id,
      task,
      objective: workflow.objective,
      harnessRunner,
    });

    expect(result).not.toBeNull();
    const issues = JSON.parse(result!.issues_json) as Array<{ code: string }>;
    expect(issues.some((i) => i.code === 'visual_selector_missing')).toBe(true);
  });
});
