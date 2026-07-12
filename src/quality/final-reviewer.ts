import type Database from 'better-sqlite3';
import { insertEvent, setWorkflowDone } from '../db/persist.js';
import {
  getFinalQualityReviewerModel,
  getFinalVisualQualityReviewerModel,
  type QualityGateMode,
} from '../utils/config.js';
import type { ReviewImageAttachment } from '../utils/image-attachment.js';
import type {
  FinalProductEvidenceBundle,
  PlaywrightHarnessEvidence,
  QualityFixTaskDraft,
  QualityIssue,
  QualityReviewRow,
} from './types.js';
import {
  buildFinalProductEvidenceBundle,
  buildPlaywrightHarnessEvidence,
  collectVisualChecksForWorkflow,
  isWebAppProject,
  loadArchitectureContractForWorkflow,
  playwrightHarnessIssues,
} from './final-evidence.js';
import { saveQualityReview } from './store.js';
import { createQualityFixTasks } from './fix-tasks.js';
import { qualityIssuesFromProductEvidence, safeParseJson } from './internal-utils.js';
import {
  defaultReviewerInvoker,
  extractJsonObject,
  normalizeIssues,
  normalizeOutcome,
  normalizeScore,
} from './reviewer-parsing.js';
import {
  runPlaywrightProductHarness,
  type PlaywrightHarnessInput,
  type PlaywrightHarnessResult,
} from './playwright-product-harness.js';
import { providerSupportsVision, resolveDirectProviderRoute } from '../utils/provider-routes.js';

export interface FinalQualityReviewInvokerInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  images?: ReviewImageAttachment[];
}

export type FinalQualityReviewInvoker = (
  input: FinalQualityReviewInvokerInput,
) => Promise<string>;

/**
 * F6-2: Injectable runner for the Playwright product harness. Tests
 * substitute a stub so vitest never spawns a dev server or launches
 * Chromium. Production callers leave this undefined; the default uses
 * `runPlaywrightProductHarness` from `./playwright-product-harness.js`.
 */
export type PlaywrightHarnessRunner = (
  input: PlaywrightHarnessInput,
) => Promise<PlaywrightHarnessResult>;

export interface EnforceFinalQualityReviewInput {
  workflowId: string;
  mode: QualityGateMode;
  model?: string;
  invoker?: FinalQualityReviewInvoker;
  /** F6-2: Optional override of the Playwright harness (used by unit tests). */
  playwrightRunner?: PlaywrightHarnessRunner;
}

export class FinalQualityGateFailedError extends Error {
  constructor(
    message: string,
    public readonly review: QualityReviewRow,
  ) {
    super(message);
    this.name = 'FinalQualityGateFailedError';
  }
}

const SYSTEM_PROMPT = [
  'You are the final product quality reviewer for an Omniforge workflow.',
  'Judge the delivered product from real evidence: tasks, quality reviews, product harness, structured errors, and terminal/debug tails.',
  'When screenshot images are attached, inspect the actual image content: orientation, layout, canvas regions, visual hierarchy, clipping, overlap, and whether the rendered scene matches the acceptance criteria.',
  'Do not treat screenshot file paths alone as visual proof; the attached images are the evidence.',
  'Do not accept a workflow merely because files exist. The result must satisfy the objective as a usable product.',
  'Return strict JSON only with this shape:',
  '{"outcome":"passed|needs_fixes|blocked","score":0-1,"issues":[{"severity":"info|warning|error|blocking","code":"snake_case","origin":"product_harness|workflow|task|runtime|reviewer","message":"concrete issue","suggestedAction":"operator action","safeContext":{}}],"fixTasks":[{"title":"short title","kind":"cli_spawn|llm_call","objective":"what to fix","dependsOn":["optional task ids"],"acceptanceCriteria":"testable criteria","metadata":{}}]}',
  'Never include secrets. Prefer specific fix tasks over vague advice.',
].join('\n');

// Defaults applied by the shared reviewer-parsing helpers when the final
// reviewer omits/garbles a field in its strict-JSON response.
const ISSUE_DEFAULTS = {
  codePrefix: 'final_quality_issue',
  origin: 'final_reviewer',
  message: 'Final reviewer found an unspecified quality issue.',
  suggestedAction: 'Inspect the final evidence bundle and add targeted fix tasks.',
};
const SCORE_FALLBACKS = { passed: 0.85, needsFixes: 0.35 };

function normalizeFixTasks(raw: unknown): QualityFixTaskDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const task = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const title = typeof task['title'] === 'string' && task['title'].trim()
      ? task['title'].trim()
      : `Fix quality issue ${index + 1}`;
    return {
      title,
      kind: typeof task['kind'] === 'string' && task['kind'].trim() ? task['kind'].trim() : 'cli_spawn',
      objective: typeof task['objective'] === 'string' && task['objective'].trim()
        ? task['objective'].trim()
        : title,
      dependsOn: Array.isArray(task['dependsOn'])
        ? task['dependsOn'].filter((value): value is string => typeof value === 'string')
        : [],
      acceptanceCriteria: typeof task['acceptanceCriteria'] === 'string' && task['acceptanceCriteria'].trim()
        ? task['acceptanceCriteria'].trim()
        : 'The final quality reviewer no longer reports this issue.',
      metadata: task['metadata'] && typeof task['metadata'] === 'object'
        ? task['metadata'] as Record<string, unknown>
        : {},
    };
  });
}

function workflowHasVisualReviewerProfile(db: Database.Database, workflowId: string): boolean {
  const rows = db
    .prepare(`SELECT input_json FROM tasks WHERE workflow_id = ?`)
    .all(workflowId) as Array<{ input_json: string | null }>;
  return rows.some((row) => safeParseJson(row.input_json)['reviewer_profile'] === 'visual');
}

function modelSupportsImageInput(model: string): boolean {
  if (/^codex-cli\//i.test(model)) return true;
  const route = resolveDirectProviderRoute(model);
  return route ? providerSupportsVision(route) : false;
}

function selectFinalReviewerModel(baseModel: string, needsVision: boolean): string {
  if (!needsVision || modelSupportsImageInput(baseModel)) return baseModel;
  return getFinalVisualQualityReviewerModel();
}

function imagesFromPlaywrightEvidence(
  evidence: PlaywrightHarnessEvidence | undefined,
): ReviewImageAttachment[] {
  if (!evidence || evidence.screenshotPaths.length === 0) return [];
  return evidence.screenshotPaths.slice(0, 6).map((path, index) => ({
    path,
    label: `Playwright screenshot ${index + 1}`,
  }));
}

interface PlaywrightHarnessAttempt {
  evidence: PlaywrightHarnessEvidence;
  issues: QualityIssue[];
  skipped: boolean;
  reason?: string;
}

/** Non-fatal skip: empty evidence with a human reason + machine reason code. */
function skippedAttempt(evidenceReason: string, reason: string): PlaywrightHarnessAttempt {
  return {
    evidence: { status: 'skipped', reason: evidenceReason, mismatches: [], screenshotPaths: [] },
    issues: [],
    skipped: true,
    reason,
  };
}

/**
 * F6-2: Runs the Playwright harness when the workflow looks web-shaped.
 * Skipping is non-fatal: `skipped` is reported back to the caller, which
 * emits `playwright_harness_skipped` and continues without injecting
 * issues. Failures are translated into blocking QualityIssue entries.
 */
async function attemptPlaywrightHarness(
  db: Database.Database,
  workflowId: string,
  mode: QualityGateMode,
  bundle: FinalProductEvidenceBundle,
  runner: PlaywrightHarnessRunner | undefined,
): Promise<PlaywrightHarnessAttempt | null> {
  if (mode === 'off') return null;
  const contract = loadArchitectureContractForWorkflow(db, workflowId);
  if (!contract) {
    return skippedAttempt('no architecture contract', 'no_architecture_contract');
  }
  if (!Array.isArray(contract.testSelectors) || contract.testSelectors.length === 0) {
    return skippedAttempt('contract has no testSelectors', 'no_test_selectors');
  }
  if (!isWebAppProject(contract.projectRoot)) {
    return skippedAttempt('projectRoot is not a recognized web app', 'not_web_app');
  }

  const run = runner ?? runPlaywrightProductHarness;
  // FASE C (Visual Reviewer) item 3 — pass through any canvasRegionChecks /
  // interactionChecks declared on the workflow's tasks so the deterministic
  // checks run as part of the same harness invocation that already
  // captures the screenshot(s) and drives the page. Best-effort: an empty
  // result here just means no task declared visual checks (back-compat).
  const visualChecks = collectVisualChecksForWorkflow(db, workflowId);
  let raw: PlaywrightHarnessResult;
  try {
    raw = await run({
      projectRoot: contract.projectRoot,
      objective: bundle.workflow.objective,
      expectedSelectors: contract.testSelectors,
      ...(visualChecks.canvasRegionChecks.length > 0
        ? { canvasRegionChecks: visualChecks.canvasRegionChecks }
        : {}),
      ...(visualChecks.interactionChecks.length > 0
        ? { interactionChecks: visualChecks.interactionChecks }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return skippedAttempt(`harness threw: ${message}`, 'harness_threw');
  }

  const evidence = buildPlaywrightHarnessEvidence(raw);
  if (evidence.status === 'skipped') {
    return { evidence, issues: [], skipped: true, reason: evidence.reason ?? 'harness_skipped' };
  }
  const productIssues = playwrightHarnessIssues(evidence);
  return {
    evidence,
    // F6-2: ProductEvidenceIssue -> QualityIssue with origin 'playwright_harness'.
    issues: qualityIssuesFromProductEvidence(productIssues, 'playwright_harness'),
    skipped: false,
  };
}

function fixTasksFromIssues(issues: QualityIssue[]): QualityFixTaskDraft[] {
  return issues.map((issue) => ({
    title: `Fix ${issue.code.replace(/_/g, ' ')}`,
    kind: 'cli_spawn',
    objective: issue.suggestedAction,
    acceptanceCriteria: `Final quality harness no longer reports ${issue.code}.`,
    metadata: {
      source: 'final_quality_reviewer',
      issue_code: issue.code,
      issue_origin: issue.origin,
    },
  }));
}

function buildUserPrompt(bundle: FinalProductEvidenceBundle, hasAttachedImages: boolean): string {
  return JSON.stringify({
    instruction: hasAttachedImages
      ? 'Review this final workflow/product evidence. Attached Playwright screenshot images are available as real image inputs; inspect them directly for visual correctness, orientation, layout, canvas scene state, overlap/clipping, and acceptance-criteria fit. Return strict JSON only.'
      : 'Review this final workflow/product evidence. Return strict JSON only.',
    bundle,
  });
}

export async function runFinalQualityReview(
  db: Database.Database,
  input: EnforceFinalQualityReviewInput,
): Promise<QualityReviewRow> {
  if (input.mode === 'off') throw new Error('Final quality review is disabled.');
  const baseModel = input.model ?? getFinalQualityReviewerModel();
  const bundle = buildFinalProductEvidenceBundle(db, input.workflowId);
  const visualProfileRequested = workflowHasVisualReviewerProfile(db, input.workflowId);
  const staticHarnessIssues = qualityIssuesFromProductEvidence(bundle.productHarness.issues, 'product_harness');

  // F6-2: Run Playwright harness in parallel with the static harness logic.
  // It is gated on contract testSelectors and the web-app heuristic; if it
  // skips, we emit an event but never fail the review on that alone.
  const playwrightAttempt = await attemptPlaywrightHarness(
    db,
    input.workflowId,
    input.mode,
    bundle,
    input.playwrightRunner,
  );
  if (playwrightAttempt) {
    bundle.playwrightHarness = playwrightAttempt.evidence;
    if (playwrightAttempt.skipped) {
      insertEvent(db, {
        workflow_id: input.workflowId,
        type: 'playwright_harness_skipped',
        payload: {
          reason: playwrightAttempt.reason ?? 'unknown',
          mode: input.mode,
        },
      });
    }
  }
  const playwrightIssues = playwrightAttempt?.issues ?? [];
  const harnessIssues = [...staticHarnessIssues, ...playwrightIssues];
  const reviewerImages = imagesFromPlaywrightEvidence(bundle.playwrightHarness);
  const model = selectFinalReviewerModel(
    baseModel,
    visualProfileRequested || reviewerImages.length > 0,
  );

  if (harnessIssues.length > 0) {
    const evidence = [
      {
        kind: 'browser' as const,
        label: 'Static web product harness',
        summary: bundle.productHarness.status,
        metadata: bundle.productHarness as unknown as Record<string, unknown>,
      },
    ];
    if (bundle.playwrightHarness) {
      evidence.push({
        kind: 'browser' as const,
        label: 'Playwright product harness',
        summary: bundle.playwrightHarness.status,
        metadata: bundle.playwrightHarness as unknown as Record<string, unknown>,
      });
    }
    const review = saveQualityReview(db, {
      workflowId: input.workflowId,
      scope: 'workflow_final',
      reviewerKind: 'browser_harness',
      reviewerModel: playwrightIssues.length > 0
        ? 'static_web_contract+playwright'
        : 'static_web_contract',
      outcome: 'needs_fixes',
      score: 0.2,
      issues: harnessIssues,
      evidence,
      fixTasks: fixTasksFromIssues(harnessIssues),
      runMode: input.mode === 'enforced' ? 'approved-run' : 'dry-run',
    });
    insertEvent(db, {
      workflow_id: input.workflowId,
      type: 'workflow_final_quality_reviewed',
      payload: {
        review_id: review.id,
        mode: input.mode,
        outcome: review.outcome,
        score: review.score,
        source: 'product_harness',
        playwright_status: bundle.playwrightHarness?.status ?? 'not_run',
      },
    });
    return review;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = await (input.invoker ?? defaultReviewerInvoker)({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(bundle, reviewerImages.length > 0),
      model,
      ...(reviewerImages.length > 0 ? { images: reviewerImages } : {}),
    });
    parsed = extractJsonObject(raw, 'Final reviewer did not return a JSON object.');
  } catch (err) {
    parsed = {
      outcome: input.mode === 'enforced' ? 'blocked' : 'skipped',
      score: null,
      issues: [
        {
          severity: input.mode === 'enforced' ? 'blocking' : 'warning',
          code: 'final_quality_reviewer_unavailable',
          origin: 'final_quality_reviewer',
          message: err instanceof Error ? err.message : String(err),
          suggestedAction: 'Check Omniroute/model availability or rerun final quality review in dry-run mode.',
          safeContext: { model },
        },
      ],
      fixTasks: [],
    };
  }

  const outcome = normalizeOutcome(parsed['outcome']);
  const issues = normalizeIssues(parsed['issues'], ISSUE_DEFAULTS);
  const review = saveQualityReview(db, {
    workflowId: input.workflowId,
    scope: 'workflow_final',
    reviewerKind: 'robust_ai',
    reviewerModel: model,
    outcome,
    score: parsed['score'] == null ? null : normalizeScore(parsed['score'], outcome, SCORE_FALLBACKS),
    issues,
    evidence: [
      {
        kind: 'debug_log',
        label: 'Final product evidence bundle',
        summary: `tasks=${bundle.tasks.length} harness=${bundle.productHarness.status}`,
        metadata: bundle as unknown as Record<string, unknown>,
      },
    ],
    fixTasks: normalizeFixTasks(parsed['fixTasks']),
    runMode: input.mode === 'enforced' ? 'approved-run' : 'dry-run',
  });
  insertEvent(db, {
    workflow_id: input.workflowId,
    type: 'workflow_final_quality_reviewed',
    payload: {
      review_id: review.id,
      mode: input.mode,
      outcome: review.outcome,
      score: review.score,
      issue_count: issues.length,
      playwright_status: bundle.playwrightHarness?.status ?? 'not_run',
    },
  });
  return review;
}

export async function enforceFinalQualityReview(
  db: Database.Database,
  input: EnforceFinalQualityReviewInput,
): Promise<QualityReviewRow | null> {
  if (input.mode === 'off') return null;
  const review = await runFinalQualityReview(db, input);
  if (input.mode === 'enforced' && (review.outcome === 'needs_fixes' || review.outcome === 'blocked')) {
    const fixTasks = createQualityFixTasks(db, review);
    setWorkflowDone(db, input.workflowId, 'failed');
    insertEvent(db, {
      workflow_id: input.workflowId,
      type: 'workflow_final_quality_gate_blocked',
      payload: {
        review_id: review.id,
        outcome: review.outcome,
        score: review.score,
        fix_task_ids: [
          ...fixTasks.existing.map((task) => task.id),
          ...fixTasks.created.map((task) => task.id),
        ],
      },
    });
    throw new FinalQualityGateFailedError(
      `Final quality gate blocked workflow completion: ${review.outcome}`,
      review,
    );
  }
  return review;
}
