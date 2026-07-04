import type Database from 'better-sqlite3';
import { insertEvent, setWorkflowDone } from '../db/persist.js';
import { callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import {
  getFinalQualityReviewerModel,
  type QualityGateMode,
} from '../utils/config.js';
import type {
  FinalProductEvidenceBundle,
  PlaywrightHarnessEvidence,
  ProductEvidenceIssue,
  QualityFixTaskDraft,
  QualityIssue,
  QualityReviewOutcome,
  QualityReviewRow,
} from './types.js';
import {
  buildFinalProductEvidenceBundle,
  buildPlaywrightHarnessEvidence,
  isWebAppProject,
  loadArchitectureContractForWorkflow,
  playwrightHarnessIssues,
} from './final-evidence.js';
import { saveQualityReview } from './store.js';
import { createQualityFixTasks } from './fix-tasks.js';
import {
  runPlaywrightProductHarness,
  type PlaywrightHarnessInput,
  type PlaywrightHarnessResult,
} from './playwright-product-harness.js';

export interface FinalQualityReviewInvokerInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
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
  'Do not accept a workflow merely because files exist. The result must satisfy the objective as a usable product.',
  'Return strict JSON only with this shape:',
  '{"outcome":"passed|needs_fixes|blocked","score":0-1,"issues":[{"severity":"info|warning|error|blocking","code":"snake_case","origin":"product_harness|workflow|task|runtime|reviewer","message":"concrete issue","suggestedAction":"operator action","safeContext":{}}],"fixTasks":[{"title":"short title","kind":"cli_spawn|llm_call","objective":"what to fix","dependsOn":["optional task ids"],"acceptanceCriteria":"testable criteria","metadata":{}}]}',
  'Never include secrets. Prefer specific fix tasks over vague advice.',
].join('\n');

function defaultInvoker(input: FinalQualityReviewInvokerInput): Promise<string> {
  return callOmnirouteWithUsage({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    model: input.model,
    temperature: 0,
  }).then((result) => result.content);
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return JSON.parse(trimmed) as Record<string, unknown>;
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1];
  if (fenced) return JSON.parse(fenced) as Record<string, unknown>;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  throw new Error('Final reviewer did not return a JSON object.');
}

function normalizeOutcome(value: unknown): QualityReviewOutcome {
  return value === 'passed' || value === 'needs_fixes' || value === 'blocked'
    ? value
    : 'needs_fixes';
}

function normalizeSeverity(value: unknown): QualityIssue['severity'] {
  return value === 'info' || value === 'warning' || value === 'error' || value === 'blocking'
    ? value
    : 'warning';
}

function normalizeIssues(raw: unknown): QualityIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const issue = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      severity: normalizeSeverity(issue['severity']),
      code: typeof issue['code'] === 'string' && issue['code'].trim()
        ? issue['code'].trim()
        : `final_quality_issue_${index + 1}`,
      origin: typeof issue['origin'] === 'string' && issue['origin'].trim()
        ? issue['origin'].trim()
        : 'final_reviewer',
      message: typeof issue['message'] === 'string' && issue['message'].trim()
        ? issue['message'].trim()
        : 'Final reviewer found an unspecified quality issue.',
      suggestedAction: typeof issue['suggestedAction'] === 'string' && issue['suggestedAction'].trim()
        ? issue['suggestedAction'].trim()
        : 'Inspect the final evidence bundle and add targeted fix tasks.',
      safeContext: issue['safeContext'] && typeof issue['safeContext'] === 'object'
        ? issue['safeContext'] as Record<string, unknown>
        : {},
    };
  });
}

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

function normalizeScore(value: unknown, outcome: QualityReviewOutcome): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }
  return outcome === 'passed' ? 0.85 : outcome === 'blocked' ? 0 : 0.35;
}

function issuesFromHarness(bundle: FinalProductEvidenceBundle): QualityIssue[] {
  return bundle.productHarness.issues.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    origin: 'product_harness',
    message: issue.message,
    suggestedAction: issue.suggestedAction,
    safeContext: issue.safeContext ?? {},
  }));
}

/**
 * F6-2: Translates ProductEvidenceIssue (used by harnesses) into the broader
 * QualityIssue shape with `origin = 'playwright_harness'`.
 */
function issuesFromPlaywright(
  productEvidence: ProductEvidenceIssue[],
): QualityIssue[] {
  return productEvidence.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    origin: 'playwright_harness',
    message: issue.message,
    suggestedAction: issue.suggestedAction,
    safeContext: issue.safeContext ?? {},
  }));
}

interface PlaywrightHarnessAttempt {
  evidence: PlaywrightHarnessEvidence;
  issues: QualityIssue[];
  skipped: boolean;
  reason?: string;
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
    return {
      evidence: { status: 'skipped', reason: 'no architecture contract', mismatches: [], screenshotPaths: [] },
      issues: [],
      skipped: true,
      reason: 'no_architecture_contract',
    };
  }
  if (!Array.isArray(contract.testSelectors) || contract.testSelectors.length === 0) {
    return {
      evidence: { status: 'skipped', reason: 'contract has no testSelectors', mismatches: [], screenshotPaths: [] },
      issues: [],
      skipped: true,
      reason: 'no_test_selectors',
    };
  }
  if (!isWebAppProject(contract.projectRoot)) {
    return {
      evidence: { status: 'skipped', reason: 'projectRoot is not a recognized web app', mismatches: [], screenshotPaths: [] },
      issues: [],
      skipped: true,
      reason: 'not_web_app',
    };
  }

  const run = runner ?? runPlaywrightProductHarness;
  let raw: PlaywrightHarnessResult;
  try {
    raw = await run({
      projectRoot: contract.projectRoot,
      objective: bundle.workflow.objective,
      expectedSelectors: contract.testSelectors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      evidence: { status: 'skipped', reason: `harness threw: ${message}`, mismatches: [], screenshotPaths: [] },
      issues: [],
      skipped: true,
      reason: 'harness_threw',
    };
  }

  const evidence = buildPlaywrightHarnessEvidence(raw);
  if (evidence.status === 'skipped') {
    return { evidence, issues: [], skipped: true, reason: evidence.reason ?? 'harness_skipped' };
  }
  const productIssues = playwrightHarnessIssues(evidence);
  return {
    evidence,
    issues: issuesFromPlaywright(productIssues),
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

function buildUserPrompt(bundle: FinalProductEvidenceBundle): string {
  return JSON.stringify({
    instruction: 'Review this final workflow/product evidence. Return strict JSON only.',
    bundle,
  });
}

export async function runFinalQualityReview(
  db: Database.Database,
  input: EnforceFinalQualityReviewInput,
): Promise<QualityReviewRow> {
  if (input.mode === 'off') throw new Error('Final quality review is disabled.');
  const model = input.model ?? getFinalQualityReviewerModel();
  const bundle = buildFinalProductEvidenceBundle(db, input.workflowId);
  const staticHarnessIssues = issuesFromHarness(bundle);

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
    const raw = await (input.invoker ?? defaultInvoker)({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(bundle),
      model,
    });
    parsed = extractJsonObject(raw);
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
  const issues = normalizeIssues(parsed['issues']);
  const review = saveQualityReview(db, {
    workflowId: input.workflowId,
    scope: 'workflow_final',
    reviewerKind: 'robust_ai',
    reviewerModel: model,
    outcome,
    score: parsed['score'] == null ? null : normalizeScore(parsed['score'], outcome),
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
