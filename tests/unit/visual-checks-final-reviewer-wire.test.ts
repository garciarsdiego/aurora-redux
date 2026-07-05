/**
 * FASE C (Visual Reviewer) item 3 — verifies that canvasRegionChecks /
 * interactionChecks declared on a task's input_json flow through to the
 * PlaywrightHarnessInput at the final quality gate.
 *
 * Mirrors the structure of playwright-final-reviewer-wire.test.ts: the
 * Playwright harness itself is mocked via `playwrightRunner` — vitest never
 * spawns a dev server, never launches Chromium.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import {
  insertTask,
  insertWorkflow,
  newTaskId,
  newWorkflowId,
} from '../../src/db/persist.js';
import {
  collectVisualChecksForWorkflow,
} from '../../src/quality/final-evidence.js';
import {
  enforceFinalQualityReview,
  type FinalQualityReviewInvoker,
  type PlaywrightHarnessRunner,
} from '../../src/quality/final-reviewer.js';
import { recordArchitectureContract } from '../../src/workflow-modes/existing-code-feature.js';
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
    created_by: 'visual-checks-wire-test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeVisualTask(workflowId: string, root: string): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: workflowId,
    name: 'Render the game canvas',
    kind: 'cli_spawn',
    input_json: JSON.stringify({
      execution_context: { worktree_root: root },
      reviewer_profile: 'visual',
      canvasRegionChecks: [
        { selector: 'canvas', region: 'top', expectedLuminanceAbove: 150, label: 'sky bright at top' },
      ],
      interactionChecks: [
        {
          label: 'space makes player jump',
          key: 'Space',
          waitMs: 100,
          // Assumes a world/physics coordinate system where +y is UP, so
          // jumping increases player.y (screen-space y grows downward).
          debugHookAssertion: { path: 'window.__debug.player.y', expect: 'increase' },
        },
      ],
    }),
    output_json: 'Rendered the canvas scene under ' + root,
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
    acceptance_criteria: 'The scene renders sky-up, ground-down and the player jumps on Space.',
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: 'cx/gpt-5.4',
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function writeCleanReactApp(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'mini-app',
      version: '0.1.0',
      private: true,
      dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
      scripts: { dev: 'vite', build: 'vite build' },
    }, null, 2),
  );
  writeFileSync(
    join(root, 'src', 'App.tsx'),
    [
      'export function App() {',
      '  return <main><canvas /></main>;',
      '}',
    ].join('\n'),
  );
}

describe('collectVisualChecksForWorkflow — aggregation (unit)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty arrays when no task declares visual checks', () => {
    const workflow = makeWorkflow('Plain workflow');
    insertWorkflow(db, workflow);
    insertTask(db, {
      id: newTaskId(),
      workflow_id: workflow.id,
      name: 'Do a thing',
      kind: 'llm_call',
      input_json: JSON.stringify({ objective: 'do a thing' }),
      output_json: 'done',
      status: 'completed',
      depends_on: [],
      executor_hint: null,
      timeout_seconds: 300,
      max_retries: 0,
      retry_count: 0,
      retry_policy: 'none',
      started_at: Date.now(),
      completed_at: Date.now(),
      created_at: Date.now(),
      acceptance_criteria: null,
      refine_count: 0,
      max_refine: 0,
      refine_feedback: null,
      model: null,
      hitl: false,
    });

    const result = collectVisualChecksForWorkflow(db, workflow.id);
    expect(result.canvasRegionChecks).toEqual([]);
    expect(result.interactionChecks).toEqual([]);
  });

  it('aggregates canvasRegionChecks/interactionChecks from a visual task', () => {
    const workflow = makeWorkflow('Visual workflow');
    insertWorkflow(db, workflow);
    insertTask(db, makeVisualTask(workflow.id, mkdtempSync(join(tmpdir(), 'omniforge-visual-agg-'))));

    const result = collectVisualChecksForWorkflow(db, workflow.id);
    expect(result.canvasRegionChecks).toHaveLength(1);
    expect(result.canvasRegionChecks[0]!.label).toBe('sky bright at top');
    expect(result.interactionChecks).toHaveLength(1);
    expect(result.interactionChecks[0]!.label).toBe('space makes player jump');
  });
});

describe('enforceFinalQualityReview — visual checks flow into PlaywrightHarnessInput', () => {
  let db: Database.Database;
  let tempRoot: string;
  const previousModeEnv = process.env.OMNIFORGE_FINAL_QUALITY_REVIEW;
  const previousVisualModelEnv = process.env.OMNIFORGE_FINAL_VISUAL_QUALITY_REVIEWER_MODEL;

  beforeEach(() => {
    db = initDb(':memory:');
    tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-visual-wire-'));
    process.env.OMNIFORGE_FINAL_VISUAL_QUALITY_REVIEWER_MODEL = 'kimi/kimi-for-coding';
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
    if (previousModeEnv === undefined) delete process.env.OMNIFORGE_FINAL_QUALITY_REVIEW;
    else process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = previousModeEnv;
    if (previousVisualModelEnv === undefined) delete process.env.OMNIFORGE_FINAL_VISUAL_QUALITY_REVIEWER_MODEL;
    else process.env.OMNIFORGE_FINAL_VISUAL_QUALITY_REVIEWER_MODEL = previousVisualModelEnv;
  });

  it('passes the task-declared canvasRegionChecks/interactionChecks to the harness runner', async () => {
    process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = 'dry-run';
    writeCleanReactApp(tempRoot);

    const workflow = makeWorkflow('Render a canvas game');
    insertWorkflow(db, workflow);
    insertTask(db, makeVisualTask(workflow.id, tempRoot));

    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: tempRoot,
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: ['src/App.tsx'],
        allowedFiles: ['src/**', 'package.json'],
        forbiddenPatterns: [],
        requiredIntegrationPoints: ['src/App.tsx'],
        testSelectors: ['canvas'],
      },
    });

    let capturedCanvasChecks: unknown;
    let capturedInteractionChecks: unknown;
    const playwrightRunner: PlaywrightHarnessRunner = async (input) => {
      capturedCanvasChecks = input.canvasRegionChecks;
      capturedInteractionChecks = input.interactionChecks;
      return {
        status: 'passed',
        mismatches: [],
        screenshotPaths: [],
      };
    };

    const invoker: FinalQualityReviewInvoker = async () =>
      JSON.stringify({ outcome: 'passed', score: 0.9, issues: [], fixTasks: [] });

    await enforceFinalQualityReview(db, {
      workflowId: workflow.id,
      mode: 'dry-run',
      model: 'test/stub-model',
      invoker,
      playwrightRunner,
    });

    expect(capturedCanvasChecks).toHaveLength(1);
    expect((capturedCanvasChecks as Array<{ label: string }>)[0]!.label).toBe('sky bright at top');
    expect(capturedInteractionChecks).toHaveLength(1);
    expect((capturedInteractionChecks as Array<{ label: string }>)[0]!.label).toBe('space makes player jump');
  });

  it('omits canvasRegionChecks/interactionChecks from the input when no task declares them (back-compat)', async () => {
    process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = 'dry-run';
    writeCleanReactApp(tempRoot);

    const workflow = makeWorkflow('Plain react app');
    insertWorkflow(db, workflow);
    insertTask(db, {
      id: newTaskId(),
      workflow_id: workflow.id,
      name: 'Build the app',
      kind: 'cli_spawn',
      input_json: JSON.stringify({ execution_context: { worktree_root: tempRoot } }),
      output_json: `Built the app under ${tempRoot}.`,
      status: 'completed',
      depends_on: [],
      executor_hint: 'cli:codex',
      timeout_seconds: 300,
      max_retries: 0,
      retry_count: 0,
      retry_policy: 'none',
      started_at: Date.now(),
      completed_at: Date.now(),
      created_at: Date.now(),
      acceptance_criteria: 'The app renders.',
      refine_count: 0,
      max_refine: 0,
      refine_feedback: null,
      model: 'cx/gpt-5.4',
      hitl: false,
      execution_mode: 'ephemeral',
    });

    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: tempRoot,
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: ['src/App.tsx'],
        allowedFiles: ['src/**', 'package.json'],
        forbiddenPatterns: [],
        requiredIntegrationPoints: ['src/App.tsx'],
        testSelectors: ['canvas'],
      },
    });

    let sawCanvasKey = false;
    let sawInteractionKey = false;
    const playwrightRunner: PlaywrightHarnessRunner = async (input) => {
      sawCanvasKey = 'canvasRegionChecks' in input;
      sawInteractionKey = 'interactionChecks' in input;
      return { status: 'passed', mismatches: [], screenshotPaths: [] };
    };

    const invoker: FinalQualityReviewInvoker = async () =>
      JSON.stringify({ outcome: 'passed', score: 0.9, issues: [], fixTasks: [] });

    await enforceFinalQualityReview(db, {
      workflowId: workflow.id,
      mode: 'dry-run',
      model: 'test/stub-model',
      invoker,
      playwrightRunner,
    });

    expect(sawCanvasKey).toBe(false);
    expect(sawInteractionKey).toBe(false);
  });

  it('passes Playwright screenshots as image attachments and routes visual reviews to a vision model', async () => {
    process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = 'dry-run';
    writeCleanReactApp(tempRoot);

    const workflow = makeWorkflow('Render a canvas game with correct orientation');
    insertWorkflow(db, workflow);
    insertTask(db, makeVisualTask(workflow.id, tempRoot));

    recordArchitectureContract(db, {
      runId: workflow.id,
      contract: {
        runId: workflow.id,
        projectRoot: tempRoot,
        appType: 'react',
        existingStateStores: [],
        existingUiSurfaces: ['src/App.tsx'],
        allowedFiles: ['src/**', 'package.json'],
        forbiddenPatterns: [],
        requiredIntegrationPoints: ['src/App.tsx'],
        testSelectors: ['canvas'],
      },
    });

    const screenshotPath = join(tempRoot, 'playwright-final.png');
    const playwrightRunner: PlaywrightHarnessRunner = async () => ({
      status: 'passed',
      mismatches: [],
      screenshotPaths: [screenshotPath],
    });

    let capturedImages: unknown;
    let capturedModel: string | undefined;
    let capturedUserPrompt = '';
    const invoker: FinalQualityReviewInvoker = async (input) => {
      capturedImages = input.images;
      capturedModel = input.model;
      capturedUserPrompt = input.userPrompt;
      return JSON.stringify({ outcome: 'passed', score: 0.9, issues: [], fixTasks: [] });
    };

    await enforceFinalQualityReview(db, {
      workflowId: workflow.id,
      mode: 'dry-run',
      model: 'glm/glm-5.2',
      invoker,
      playwrightRunner,
    });

    expect(capturedModel).toBe('kimi/kimi-for-coding');
    expect(capturedImages).toEqual([
      { path: screenshotPath, label: 'Playwright screenshot 1' },
    ]);
    expect(capturedUserPrompt).toContain('Attached Playwright screenshot images are available');
  });
});
