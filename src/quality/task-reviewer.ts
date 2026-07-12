import type Database from 'better-sqlite3';
import { insertEvent, setTaskFailed } from '../db/persist.js';
import {
  getTaskQualityReviewerModel,
  type QualityGateMode,
} from '../utils/config.js';
import type {
  QualityEvidenceRef,
  QualityIssue,
  QualityReviewRow,
  TaskQualityEvidenceBundle,
} from './types.js';
import { buildTaskQualityEvidenceBundle } from './evidence.js';
import { saveQualityReview } from './store.js';
import {
  defaultReviewerInvoker,
  extractJsonObject,
  normalizeIssues,
  normalizeOutcome,
  normalizeScore,
} from './reviewer-parsing.js';

export interface LightTaskQualityReviewInvokerInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}

export type LightTaskQualityReviewInvoker = (
  input: LightTaskQualityReviewInvokerInput,
) => Promise<string>;

export interface RunLightTaskQualityReviewInput {
  workflowId: string;
  taskId: string;
  mode: QualityGateMode;
  model?: string;
  invoker?: LightTaskQualityReviewInvoker;
}

export class QualityGateFailedError extends Error {
  constructor(
    message: string,
    public readonly review: QualityReviewRow,
  ) {
    super(message);
    this.name = 'QualityGateFailedError';
  }
}

const SYSTEM_PROMPT = [
  'You are the light quality reviewer for a single Omniforge workflow task.',
  'Judge whether the task output is plausibly usable, concrete, and aligned with its acceptance criteria.',
  'Prefer actionable issues over generic criticism.',
  'Return strict JSON only with this shape:',
  '{"outcome":"passed|needs_fixes|blocked","score":0-1,"issues":[{"severity":"info|warning|error|blocking","code":"snake_case","origin":"task_output|filesystem|runtime|browser|reviewer","message":"short concrete issue","suggestedAction":"operator action","safeContext":{}}]}',
  'Never include secrets. Do not invent files that are not in the evidence bundle.',
].join('\n');

// Defaults applied by the shared reviewer-parsing helpers when the light
// reviewer omits/garbles a field in its strict-JSON response.
const ISSUE_DEFAULTS = {
  codePrefix: 'quality_issue',
  origin: 'reviewer',
  message: 'Reviewer flagged this task without a specific message.',
  suggestedAction: 'Inspect the evidence bundle and retry or create a targeted fix task.',
};
const SCORE_FALLBACKS = { passed: 0.8, needsFixes: 0.4 };

function evidenceRefsFromBundle(bundle: TaskQualityEvidenceBundle): QualityEvidenceRef[] {
  return [
    {
      kind: 'task_output',
      label: 'Task output preview',
      summary: `${bundle.output.chars} chars`,
      metadata: { preview: bundle.output.preview },
    },
    {
      kind: 'filesystem',
      label: 'Acceptance filesystem check',
      summary: bundle.filesystem.feedback || bundle.filesystem.verdict,
      metadata: bundle.filesystem.summary,
    },
    ...bundle.artifacts,
    {
      kind: 'context',
      label: 'Workflow context tails',
      summary: [
        `events=${bundle.eventsTail.length}`,
        `runtime_events=${bundle.runtimeEventsTail.length}`,
        `context_packets=${bundle.contextPacketsTail.length}`,
        `handoffs=${bundle.handoffsTail.length}`,
      ].join(' '),
    },
  ];
}

function issueFromFilesystem(bundle: TaskQualityEvidenceBundle): QualityIssue {
  return {
    severity: 'blocking',
    code: 'filesystem_acceptance_failed',
    origin: 'filesystem',
    message: bundle.filesystem.feedback || 'Required filesystem evidence did not pass.',
    suggestedAction: 'Open the task worktree/output folder, inspect expected files, then retry or create a targeted fix task.',
    safeContext: {
      workspaceDir: bundle.executionContext.workspaceDir,
      summary: bundle.filesystem.summary,
      evidence: bundle.filesystem.evidence,
    },
  };
}

function buildUserPrompt(bundle: TaskQualityEvidenceBundle): string {
  return JSON.stringify({
    instruction: 'Review this single task evidence bundle. Return strict JSON only.',
    bundle,
  });
}

export async function runLightTaskQualityReview(
  db: Database.Database,
  input: RunLightTaskQualityReviewInput,
): Promise<QualityReviewRow> {
  if (input.mode === 'off') {
    throw new Error('Task quality review is disabled.');
  }
  const model = input.model ?? getTaskQualityReviewerModel();
  const bundle = buildTaskQualityEvidenceBundle(db, input.workflowId, input.taskId);
  const evidence = evidenceRefsFromBundle(bundle);

  if (bundle.filesystem.canDecide && bundle.filesystem.verdict === 'fail') {
    const review = saveQualityReview(db, {
      workflowId: input.workflowId,
      taskId: input.taskId,
      scope: 'task',
      reviewerKind: 'light_ai',
      reviewerModel: model,
      outcome: 'needs_fixes',
      score: 0.1,
      issues: [issueFromFilesystem(bundle)],
      evidence,
      runMode: input.mode === 'enforced' ? 'approved-run' : 'dry-run',
      auditStatus: 'recorded',
    });
    insertEvent(db, {
      workflow_id: input.workflowId,
      task_id: input.taskId,
      type: 'task_quality_reviewed',
      payload: {
        review_id: review.id,
        mode: input.mode,
        outcome: review.outcome,
        score: review.score,
        source: 'filesystem_precheck',
      },
    });
    return review;
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = await (input.invoker ?? defaultReviewerInvoker)({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(bundle),
      model,
    });
    parsed = extractJsonObject(raw, 'Reviewer did not return a JSON object.');
  } catch (err) {
    parsed = {
      outcome: input.mode === 'enforced' ? 'blocked' : 'skipped',
      score: null,
      issues: [
        {
          severity: input.mode === 'enforced' ? 'blocking' : 'warning',
          code: 'quality_reviewer_unavailable',
          origin: 'light_ai_reviewer',
          message: err instanceof Error ? err.message : String(err),
          suggestedAction: 'Check Omniroute/model availability or rerun in dry-run mode.',
          safeContext: { model },
        },
      ],
    };
  }

  const outcome = normalizeOutcome(parsed['outcome']);
  const issues = normalizeIssues(parsed['issues'], ISSUE_DEFAULTS);
  const review = saveQualityReview(db, {
    workflowId: input.workflowId,
    taskId: input.taskId,
    scope: 'task',
    reviewerKind: 'light_ai',
    reviewerModel: model,
    outcome,
    score: parsed['score'] == null ? null : normalizeScore(parsed['score'], outcome, SCORE_FALLBACKS),
    issues,
    evidence,
    runMode: input.mode === 'enforced' ? 'approved-run' : 'dry-run',
    auditStatus: 'recorded',
  });
  insertEvent(db, {
    workflow_id: input.workflowId,
    task_id: input.taskId,
    type: 'task_quality_reviewed',
    payload: {
      review_id: review.id,
      mode: input.mode,
      outcome: review.outcome,
      score: review.score,
      issue_count: issues.length,
    },
  });
  return review;
}

export async function enforceLightTaskQualityReview(
  db: Database.Database,
  input: RunLightTaskQualityReviewInput,
): Promise<QualityReviewRow | null> {
  if (input.mode === 'off') return null;
  const review = await runLightTaskQualityReview(db, input);
  if (input.mode === 'enforced' && (review.outcome === 'needs_fixes' || review.outcome === 'blocked')) {
    setTaskFailed(db, input.taskId);
    insertEvent(db, {
      workflow_id: input.workflowId,
      task_id: input.taskId,
      type: 'task_quality_gate_blocked',
      payload: {
        review_id: review.id,
        outcome: review.outcome,
        score: review.score,
      },
    });
    throw new QualityGateFailedError(
      `Task quality gate blocked completion: ${review.outcome}`,
      review,
    );
  }
  return review;
}
