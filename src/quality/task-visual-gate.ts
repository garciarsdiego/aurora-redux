/**
 * FASE C (Visual Reviewer) item 4 — per-task dispatch for reviewer_profile
 * === 'visual'.
 *
 * Design decision (see docs/VISUAL-REVIEWER-FASE-C-FOLLOWUP.md for the full
 * investigation): this module is a small, isolated pre-check that plugs in
 * BEFORE the existing hardened `enforceLightTaskQualityReview` path in
 * quality-gate.ts. It never replaces or rewrites that path — it only
 * short-circuits it early, and only when ALL of the following hold:
 *   - the task declares reviewer_profile === 'visual'
 *   - the task (or workflow) declares at least one canvasRegionChecks /
 *     interactionChecks entry
 *   - the workflow has an architecture contract with a resolvable
 *     projectRoot (the harness needs somewhere to spawn a dev server)
 *
 * When any of those is not true, `attemptTaskVisualGate` returns `null` and
 * the caller falls through to the existing LLM-backed light task review
 * completely unchanged — this is the fail-open default so the feature can
 * never break a workflow that doesn't opt in.
 *
 * When the deterministic checks run and FAIL, this produces a rejected
 * QualityReviewRow citing the specific failing check(s) — zero LLM calls
 * spent. When they PASS, this returns `null` too (fail-open) so the
 * existing LLM review still runs as an additional layer; only the failure
 * path short-circuits the LLM, matching "determinism decides before any
 * LLM spend" without silently skipping review entirely on success.
 */
import type Database from 'better-sqlite3';
import { insertEvent } from '../db/persist.js';
import type { Task } from '../types/index.js';
import type { QualityReviewRow } from './types.js';
import { saveQualityReview } from './store.js';
import { loadArchitectureContractForWorkflow } from './final-evidence.js';
import { isCanvasRegionCheckArray, isInteractionCheckArray } from './visual-check-guards.js';
import { safeParseJson } from './internal-utils.js';
import {
  runPlaywrightProductHarness,
  type CanvasRegionCheck,
  type InteractionCheck,
  type PlaywrightHarnessInput,
  type PlaywrightHarnessResult,
} from './playwright-product-harness.js';

export type TaskVisualHarnessRunner = (
  input: PlaywrightHarnessInput,
) => Promise<PlaywrightHarnessResult>;

// Fixed low score for a deterministic visual-gate rejection — it reflects a
// definite check failure, NOT model confidence (no LLM produced it).
const DETERMINISTIC_FAIL_SCORE = 0.1;

export interface AttemptTaskVisualGateInput {
  workflowId: string;
  task: Task;
  objective: string;
  /** Injectable for unit tests — production callers leave this undefined. */
  harnessRunner?: TaskVisualHarnessRunner;
}

/**
 * Reads reviewer_profile + the two check arrays off the task, preferring
 * the in-memory Task field (materialised at DAG->Task time in
 * orchestrate.ts within the same process) and falling back to input_json
 * (covers the reload-from-DB path, since reviewer_profile/checks have no
 * dedicated tasks-table columns).
 */
function readTaskVisualConfig(task: Task): {
  reviewerProfile: string | undefined;
  canvasRegionChecks: CanvasRegionCheck[];
  interactionChecks: InteractionCheck[];
} {
  const input = safeParseJson(task.input_json);
  const reviewerProfile = task.reviewer_profile ?? (typeof input['reviewer_profile'] === 'string' ? input['reviewer_profile'] : undefined);

  const canvasCandidate = input['canvasRegionChecks'];
  const canvasRegionChecks = isCanvasRegionCheckArray(canvasCandidate) ? canvasCandidate : [];

  const interactionCandidate = input['interactionChecks'];
  const interactionChecks = isInteractionCheckArray(interactionCandidate) ? interactionCandidate : [];

  return { reviewerProfile, canvasRegionChecks, interactionChecks };
}

/**
 * Attempts the deterministic visual gate for a single task. Returns `null`
 * when the gate does not apply (not a 'visual' task, no checks configured,
 * no resolvable projectRoot, or the harness itself skipped) — callers must
 * treat `null` as "fall through to the normal review path unchanged".
 *
 * Returns a rejected QualityReviewRow (never throws) when a deterministic
 * check fails — the caller decides whether/how to enforce it, mirroring
 * the existing enforceLightTaskQualityReview contract.
 */
export async function attemptTaskVisualGate(
  db: Database.Database,
  input: AttemptTaskVisualGateInput,
): Promise<QualityReviewRow | null> {
  const { reviewerProfile, canvasRegionChecks, interactionChecks } = readTaskVisualConfig(input.task);
  if (reviewerProfile !== 'visual') return null;
  if (canvasRegionChecks.length === 0 && interactionChecks.length === 0) return null;

  const contract = loadArchitectureContractForWorkflow(db, input.workflowId);
  if (!contract) return null;

  const run = input.harnessRunner ?? runPlaywrightProductHarness;
  let raw: PlaywrightHarnessResult;
  try {
    raw = await run({
      projectRoot: contract.projectRoot,
      objective: input.objective,
      expectedSelectors: contract.testSelectors,
      ...(canvasRegionChecks.length > 0 ? { canvasRegionChecks } : {}),
      ...(interactionChecks.length > 0 ? { interactionChecks } : {}),
    });
  } catch (err) {
    // Harness threw unexpectedly — fail open. A broken harness must never
    // block a task; the normal review path still runs as a fallback.
    insertEvent(db, {
      workflow_id: input.workflowId,
      task_id: input.task.id,
      type: 'task_visual_gate_harness_threw',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }

  if (raw.status === 'skipped') return null;

  const failedCanvasChecks = (raw.canvasRegionCheckResults ?? []).filter((r) => !r.pass);
  const failedInteractionChecks = (raw.interactionCheckResults ?? []).filter((r) => !r.pass);
  const selectorMismatches = raw.mismatches ?? [];

  const allChecksPassed = failedCanvasChecks.length === 0
    && failedInteractionChecks.length === 0
    && selectorMismatches.length === 0;

  insertEvent(db, {
    workflow_id: input.workflowId,
    task_id: input.task.id,
    type: 'task_visual_gate_ran',
    payload: {
      status: raw.status,
      canvas_checks: canvasRegionChecks.length,
      interaction_checks: interactionChecks.length,
      canvas_failures: failedCanvasChecks.length,
      interaction_failures: failedInteractionChecks.length,
      selector_mismatches: selectorMismatches.length,
    },
  });

  if (allChecksPassed) return null; // all checks passed — fall through to LLM review as an extra layer.

  const issues = [
    ...failedCanvasChecks.map((check) => ({
      severity: 'blocking' as const,
      code: 'visual_canvas_region_check_failed',
      origin: 'playwright_harness_task',
      message: `Canvas region check "${check.label}" failed${check.error ? `: ${check.error}` : ` (measured luminance=${check.measuredLuminance ?? 'n/a'}, hue=${check.measuredHue ?? 'n/a'})`}.`,
      suggestedAction: `Fix the rendering issue so "${check.label}" (selector ${check.selector}) matches the expected color/luminance.`,
      safeContext: { label: check.label, selector: check.selector, measuredLuminance: check.measuredLuminance, measuredHue: check.measuredHue, error: check.error },
    })),
    ...failedInteractionChecks.map((check) => ({
      severity: 'blocking' as const,
      code: 'visual_interaction_check_failed',
      origin: 'playwright_harness_task',
      message: `Interaction check "${check.label}" failed${check.reason ? `: ${check.reason}` : ''}${check.error ? `: ${check.error}` : ''}.`,
      suggestedAction: `Fix the interaction so "${check.label}" produces the expected before/after change.`,
      safeContext: { label: check.label, before: check.before, after: check.after, reason: check.reason, error: check.error },
    })),
    ...selectorMismatches.map((mismatch) => ({
      severity: 'blocking' as const,
      code: `visual_${mismatch.kind}`,
      origin: 'playwright_harness_task',
      message: mismatch.kind === 'selector_missing'
        ? `Expected selector "${mismatch.selector}" was not found on the page.`
        : `Selector "${mismatch.selector}" text did not include "${mismatch.expectedText}".`,
      suggestedAction: 'Inspect the rendered page and fix the missing element/text.',
      safeContext: { ...mismatch },
    })),
  ];

  const review = saveQualityReview(db, {
    workflowId: input.workflowId,
    taskId: input.task.id,
    scope: 'task',
    reviewerKind: 'browser_harness',
    reviewerModel: 'playwright_deterministic',
    outcome: 'needs_fixes',
    score: DETERMINISTIC_FAIL_SCORE,
    issues,
    evidence: [
      {
        kind: 'browser',
        label: 'Per-task Playwright visual harness',
        summary: raw.status,
        metadata: raw as unknown as Record<string, unknown>,
      },
    ],
    runMode: 'approved-run',
    auditStatus: 'recorded',
  });

  insertEvent(db, {
    workflow_id: input.workflowId,
    task_id: input.task.id,
    type: 'task_quality_reviewed',
    payload: {
      review_id: review.id,
      outcome: review.outcome,
      score: review.score,
      source: 'visual_harness_precheck',
      issue_count: issues.length,
    },
  });

  return review;
}
