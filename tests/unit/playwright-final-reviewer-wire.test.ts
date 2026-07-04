/**
 * F6-2: Verifies that `enforceFinalQualityReview` invokes the Playwright
 * product harness via the injectable runner, surfaces its `skipped` status
 * on the final-evidence bundle, and continues without failing the workflow.
 *
 * The Playwright harness itself is mocked via `playwrightRunner` — vitest
 * never spawns a dev server, never launches Chromium, and never touches the
 * filesystem outside the per-test temp dir.
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
  enforceFinalQualityReview,
  type FinalQualityReviewInvoker,
  type PlaywrightHarnessRunner,
} from '../../src/quality/final-reviewer.js';
import {
  listQualityReviewsForWorkflow,
  parseQualityEvidence,
} from '../../src/quality/store.js';
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
    created_by: 'playwright-wire-test',
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

/**
 * Writes a tiny but harness-clean React mini app: the static web product
 * harness must NOT find control_copy_* mismatches, otherwise the static
 * short-circuit fires and we never exercise the LLM/Playwright paths.
 */
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
      '  return <main><h1>Hello</h1></main>;',
      '}',
    ].join('\n'),
  );
}

describe('enforceFinalQualityReview — Playwright harness wire', () => {
  let db: Database.Database;
  let tempRoot: string;
  const previousModeEnv = process.env.OMNIFORGE_FINAL_QUALITY_REVIEW;

  beforeEach(() => {
    db = initDb(':memory:');
    tempRoot = mkdtempSync(join(tmpdir(), 'omniforge-pw-wire-'));
  });

  afterEach(() => {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
    if (previousModeEnv === undefined) delete process.env.OMNIFORGE_FINAL_QUALITY_REVIEW;
    else process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = previousModeEnv;
  });

  it('persists a review with playwright_status="skipped" when the harness reports skipped', async () => {
    process.env.OMNIFORGE_FINAL_QUALITY_REVIEW = 'dry-run';
    writeCleanReactApp(tempRoot);

    const workflow = makeWorkflow('Render a mini React app');
    insertWorkflow(db, workflow);
    insertTask(db, makeTask(workflow.id, tempRoot, 'Render mini app'));

    // Architecture contract with a non-empty testSelectors list: this is the
    // gate that lets the runner be invoked at all. allowedFiles must cover
    // everything the static harness will inspect (package.json, src/**) so the
    // arch reviewer doesn't short-circuit on `arch.changed_files_outside_contract`.
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
        testSelectors: ['main h1'],
      },
    });

    let runnerInvocations = 0;
    const playwrightRunner: PlaywrightHarnessRunner = async (input) => {
      runnerInvocations += 1;
      // Sanity: the wire layer must forward the contract data unchanged.
      expect(input.projectRoot).toBe(tempRoot);
      expect(input.expectedSelectors).toEqual(['main h1']);
      expect(input.objective).toBe('Render a mini React app');
      return {
        status: 'skipped',
        reason: 'playwright not installed',
        mismatches: [],
        screenshotPaths: [],
      };
    };

    // The static harness has no copy mismatches on the clean app, so the
    // function falls through to the LLM invoker. Stub it to return passed.
    const invoker: FinalQualityReviewInvoker = async () =>
      JSON.stringify({ outcome: 'passed', score: 0.9, issues: [], fixTasks: [] });

    const review = await enforceFinalQualityReview(db, {
      workflowId: workflow.id,
      mode: 'dry-run',
      model: 'test/stub-model',
      invoker,
      playwrightRunner,
    });

    expect(runnerInvocations).toBe(1);
    expect(review).not.toBeNull();
    expect(review!.outcome).toBe('passed');

    // The skipped harness must surface in the persisted evidence so the
    // dashboard can show `playwright_harness_status='skipped'`.
    const evidence = parseQualityEvidence(review!);
    expect(evidence).toHaveLength(1);
    const debugEvidence = evidence[0]!;
    expect(debugEvidence.kind).toBe('debug_log');
    const bundle = debugEvidence.metadata as Record<string, unknown>;
    const playwrightHarness = bundle['playwrightHarness'] as
      | Record<string, unknown>
      | undefined;
    expect(playwrightHarness).toBeDefined();
    expect(playwrightHarness!['status']).toBe('skipped');
    expect(playwrightHarness!['reason']).toBe('playwright not installed');

    // The skipped status must NOT add issues or fail the review.
    const reviews = listQualityReviewsForWorkflow(db, workflow.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.outcome).toBe('passed');

    // The wire layer must emit playwright_harness_skipped when status='skipped'.
    const events = db.prepare(`SELECT type FROM events WHERE workflow_id = ?`).all(workflow.id) as Array<{ type: string }>;
    expect(events.map((row) => row.type)).toContain('playwright_harness_skipped');
  });
});
