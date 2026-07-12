import { z } from "zod";
import type Database from "better-sqlite3";
import type { Task, ReviewResult } from "../../types/index.js";
import { callOmnirouteWithUsage } from "../../utils/omniroute-call.js";
import {
  REVIEWER_PERSONA,
  type ReviewerInput,
  type ReviewerOutput,
} from "../agents/personas/reviewer.js";
import { runAgent, type AgentInvoker } from "../agents/runner.js";
import type { AgentContext } from "../agents/types.js";
import {
  getActiveVersionedDefinition,
  recordVersionedDefinitionUsage,
} from "../governance/versioned-registry.js";
import { insertEvent } from "../../db/persist.js";
import { safeParseJson } from "../../utils/safe-parse-json.js";
import { getReviewerModel, getReviewPassThreshold } from "../../utils/config.js";

export const ReviewOutcomeTypeSchema = z.enum([
  "hard_success",
  "soft_success",
  "soft_failure",
  "hard_failure",
  "scope_conflict"
]);

export type ReviewOutcomeType = z.infer<typeof ReviewOutcomeTypeSchema>;

export const ReviewOutcomeSchema = z.object({
  outcome_type: ReviewOutcomeTypeSchema,
  confidence: z.number().min(0).max(1),
  feedback: z.string().optional(),
  caveats: z.array(z.string()).optional(),
  next_action: z.enum(["refine", "fallback_model", "abort", "escalate_human"]).optional(),
  refine_hint: z.string().optional()
});

export type ReviewOutcome = z.infer<typeof ReviewOutcomeSchema>;

export interface ReviewerRuntimeContext {
  workflowId?: string;
  taskId?: string;
  workspaceDir?: string;
  filesClaimedWritten?: string[];
  toolCallsTrace?: Array<{ name: string; args_summary?: string }>;
  /**
   * Wave 2.C: state_schema runtime-validation results for this task. The
   * caller (run-task.ts after setTaskCompleted) reads them via
   * getStateSchemaViolationsForTask and forwards them so the reviewer LLM
   * can incorporate shape-drift feedback when judging the worker.
   */
  stateSchemaViolations?: Array<{
    field: string;
    expected: string;
    actual: string;
    reason: 'missing' | 'wrong_type' | 'parse_error';
  }>;
  /**
   * Wave 1.1 (F1-2): existing-code workflow mode + architecture contract.
   * When workflowMode === 'existing_code_feature' and architectureContract is
   * present, the reviewer applies an integration-aware judgment overlay on
   * top of the standard process. Both fields are intentionally optional so
   * standard workflows are unaffected.
   */
  workflowMode?: 'standard' | 'existing_code_feature';
  architectureContract?: import('../../workflow-modes/existing-code-feature.js').ArchitectureContract | null;
}

const reviewerOmnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? '',
    model: args.model,
  });
  return result.content;
};

function buildReviewerAgentContext(input: ReviewerInput): AgentContext {
  return {
    workflowId: input.workflow_id,
    taskId: input.task_id,
    workspaceDir: input.workspace_dir,
    retryCount: 0,
    emit(event, payload) {
      console.log(`[reviewer-persona] ${event}`, payload);
    },
    warn(message, payload) {
      console.warn(`[reviewer-persona] ${message}`, payload);
    },
    log(level, message, payload) {
      const line = `[reviewer-persona] ${message}`;
      if (level === 'error') console.error(line, payload);
      else if (level === 'warn') console.warn(line, payload);
      else console.log(line, payload);
    },
  };
}

function parseMaybeJson(output: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}

function extractStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function extractToolCalls(value: unknown): Array<{ name: string; args_summary?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const obj = entry as Record<string, unknown>;
      if (typeof obj['name'] !== 'string' || obj['name'].trim().length === 0) return null;
      const argsSummary = obj['args_summary'];
      return {
        name: obj['name'],
        ...(typeof argsSummary === 'string' ? { args_summary: argsSummary } : {}),
      };
    })
    .filter((entry): entry is { name: string; args_summary?: string } => entry !== null);
  return calls.length > 0 ? calls : undefined;
}

// CORREÇÃO L4-002: Exportar para uso no executor
export function extractToolCallsFromCliEnvelope(output: string): Array<{ name: string; args_summary?: string }> | undefined {
  const headerMatch = /^\s*\[\[CLI_TOOL_CALLS\]\][^\n]*$/m.exec(output);
  if (!headerMatch || headerMatch.index === undefined) return undefined;

  const body = output.slice(headerMatch.index + headerMatch[0].length);
  const calls: Array<{ name: string; args_summary?: string }> = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('[[CLI_RESULT]]')) break;
    if (/no tool calls captured/i.test(line)) continue;

    const match = /^-\s*([A-Za-z0-9_.:-]+)(?:\s*\(([^)]*)\))?/.exec(line);
    if (!match) continue;
    const argsSummary = match[2]?.trim();
    calls.push({
      name: match[1],
      ...(argsSummary ? { args_summary: argsSummary } : {}),
    });
  }

  return calls.length > 0 ? calls : undefined;
}

const REVIEWABLE_OUTPUT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.scss',
  '.html',
  '.py',
  '.go',
  '.rs',
  '.sql',
]);

function decodePathMention(raw: string): string {
  const withoutFragment = raw.trim().replace(/^file:\/+/i, '').split(/[?#]/)[0] ?? '';
  let decoded = withoutFragment;
  try {
    decoded = decodeURI(withoutFragment);
  } catch {
    decoded = withoutFragment.replace(/%20/gi, ' ');
  }
  return decoded
    .replace(/^\/([A-Za-z]:[\\/])/, '$1')
    .replace(/:(\d+)(?::\d+)?$/, '');
}

function hasReviewableExtension(value: string): boolean {
  const normalized = value.replace(/:(\d+)(?::\d+)?$/, '');
  return /\.[A-Za-z0-9]+$/.test(normalized) &&
    REVIEWABLE_OUTPUT_EXTENSIONS.has(normalized.slice(normalized.lastIndexOf('.')).toLowerCase());
}

function extractFileMentionsFromText(output: string): string[] {
  const found = new Set<string>();
  for (const match of output.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const candidate = decodePathMention(match[1] ?? '');
    if (candidate && hasReviewableExtension(candidate)) found.add(candidate);
  }
  return [...found];
}

function outputObject(workerOutput: unknown): Record<string, unknown> | null {
  if (!workerOutput || typeof workerOutput !== 'object' || Array.isArray(workerOutput)) return null;
  return workerOutput as Record<string, unknown>;
}

export function buildReviewerInputFromTask(
  task: Task,
  output: string,
  ctx: ReviewerRuntimeContext = {},
): ReviewerInput {
  const workerOutput = parseMaybeJson(output);
  const obj = outputObject(workerOutput);
  const narrative = typeof workerOutput === 'string'
    ? workerOutput
    : typeof obj?.['result_text'] === 'string'
      ? obj['result_text']
      : output;
  const filesFromOutput =
    extractStringArray(obj?.['files_written']) ??
    extractStringArray(obj?.['files_claimed_written']) ??
    (typeof obj?.['file_path'] === 'string' ? [obj['file_path']] : undefined);
  const fileMentionsFromText = extractFileMentionsFromText(narrative);
  const filesClaimedWritten = Array.from(new Set([
    ...(filesFromOutput ?? []),
    ...fileMentionsFromText,
  ]));
  const toolCallsFromOutput =
    extractToolCalls(obj?.['tool_calls']) ??
    extractToolCalls(obj?.['tool_calls_trace']) ??
    extractToolCallsFromCliEnvelope(output);

  let outputKey: string | undefined;
  let sharedState: Record<string, unknown> | undefined;
  // Wave 2 M1-W2-E (gap-closure 2026-05-12): replace silent JSON.parse with
  // safeParseJson. buildReviewerInputFromTask runs in the reviewer pipeline
  // which does not have a db handle in this scope — workflowId is still
  // threaded through so a future db-aware refactor reuses the same site.
  // Behavior unchanged (malformed input_json → no output_key/shared_state).
  const taskCtx = safeParseJson<Record<string, unknown>>(task.input_json, {
    where: 'reviewer.outcome.buildReviewerInputFromTask',
    taskId: ctx.taskId ?? task.id,
    workflowId: ctx.workflowId ?? task.workflow_id,
  });
  if (taskCtx) {
    const ok = typeof taskCtx['output_key'] === 'string' ? taskCtx['output_key'].trim() : '';
    if (ok) outputKey = ok;
    const ss = taskCtx['shared_state'];
    if (ss && typeof ss === 'object' && !Array.isArray(ss)) sharedState = ss as Record<string, unknown>;
  }

  return {
    task_id: ctx.taskId ?? task.id,
    workflow_id: ctx.workflowId ?? task.workflow_id,
    task_kind: task.kind,
    acceptance_criteria: task.acceptance_criteria,
    worker_output: workerOutput,
    workspace_dir: ctx.workspaceDir ?? task.workspace ?? process.cwd(),
    files_claimed_written: ctx.filesClaimedWritten ?? (filesClaimedWritten.length > 0 ? filesClaimedWritten : undefined),
    tool_calls_trace: ctx.toolCallsTrace ?? toolCallsFromOutput,
    output_key: outputKey,
    shared_state: sharedState,
    state_schema_violations: ctx.stateSchemaViolations,
    workflow_mode: ctx.workflowMode,
    architecture_contract: ctx.architectureContract ?? null,
  };
}

function formatFilesystemSummary(summary: ReviewerOutput['filesystem_check_summary']): string {
  const parts: string[] = [];
  if (summary.files_verified.length > 0) parts.push(`verified=${summary.files_verified.join(', ')}`);
  if (summary.files_missing.length > 0) parts.push(`missing=${summary.files_missing.join(', ')}`);
  if (summary.files_too_short.length > 0) parts.push(`too_short=${summary.files_too_short.join(', ')}`);
  return parts.length > 0 ? `Filesystem: ${parts.join('; ')}` : 'Filesystem: no concrete file findings';
}

export function reviewerOutputToOutcome(output: ReviewerOutput): ReviewOutcome {
  const evidenceCaveats = output.evidence.map(
    (e) => `Evidence: ${e.status} - ${e.criterion}: ${e.proof}`,
  );
  const filesystemCaveat = formatFilesystemSummary(output.filesystem_check_summary);
  const caveats = [...evidenceCaveats, filesystemCaveat];
  const refineHint = [output.feedback, ...caveats].filter((s) => s.trim().length > 0).join('\n');

  if (output.verdict === 'pass') {
    return {
      outcome_type: 'hard_success',
      confidence: 1,
      feedback: output.feedback,
      caveats,
      refine_hint: refineHint,
    };
  }
  if (output.verdict === 'soft_fail') {
    return {
      outcome_type: 'soft_success',
      confidence: 0.8,
      feedback: output.feedback,
      caveats,
      refine_hint: refineHint,
    };
  }
  // Opt 2b — verdict 'refine' and a single reviewer verdict 'fail' map to the
  // SAME outcome: 'fail' is RECOVERABLE, so it becomes soft_failure + refine
  // and the worker gets refine retries rather than an instant workflow abort.
  // One cosmetic miss should trigger a refine loop, not a hard failure.
  // Genuine hard failures still fail AFTER refine exhaustion (handled in
  // refine.ts). hard_failure/abort is reserved for cases the reviewer
  // EXPLICITLY signals as non-recoverable; the current ReviewerOutput contract
  // carries no unrecoverable/abort flag, so verdict 'fail' alone never aborts
  // on its own.
  return {
    outcome_type: 'soft_failure',
    confidence: 0.6,
    feedback: output.feedback,
    caveats,
    next_action: 'refine',
    refine_hint: refineHint,
  };
}

export function reviewOutcomeToResult(outcome: ReviewOutcome): ReviewResult {
  if (outcome.outcome_type === 'hard_failure' || outcome.outcome_type === 'scope_conflict') {
    throw new Error(`Reviewer aborted with ${outcome.outcome_type}. Feedback: ${outcome.feedback}`);
  }

  let score = 0;
  if (outcome.outcome_type === 'hard_success') score = 1.0;
  else if (outcome.outcome_type === 'soft_success') score = 0.8;
  else if (outcome.outcome_type === 'soft_failure') score = 0.5;
  // OPS-04: pass/fail is now threshold-driven via REVIEW_PASS_THRESHOLD (default
  // 0.7) instead of a hardcoded per-type boolean. At the 0.7 default this exactly
  // reproduces the prior mapping (hard/soft_success pass, soft_failure fails) while
  // making the cushion tunable; hard_failure/scope_conflict already aborted above.
  const passed = score >= getReviewPassThreshold();

  const finalFeedback = (outcome.feedback ?? '') +
    (outcome.caveats?.length ? '\nCaveats: ' + outcome.caveats.join(', ') : '') +
    (outcome.refine_hint ? '\nHint: ' + outcome.refine_hint : '');

  return { score, feedback: finalFeedback, passed };
}

/**
 * Tier 0 Wave 3 (ITEM 0.7) — best-effort version-registry consumer for the
 * reviewer persona. Emits a versioned_definition_consumed event + records
 * usage when a workspace pin is active. The DB handle is optional so unit
 * tests that mock the reviewer keep working without a live database.
 */
export function consumePinnedReviewer(
  db: Database.Database | null | undefined,
  params: { workspace: string; workflowId: string; taskId?: string },
): void {
  if (!db || !params.workspace || !params.workflowId) return;
  try {
    const def = getActiveVersionedDefinition(db, {
      workspace: params.workspace,
      kind: 'agent',
      name: 'persona.reviewer',
    });
    if (!def) return;
    insertEvent(db, {
      workflow_id: params.workflowId,
      task_id: params.taskId ?? null,
      type: 'versioned_definition_consumed',
      payload: {
        kind: 'agent',
        name: 'persona.reviewer',
        version: def.version,
        definition_id: def.id,
        workspace: params.workspace,
        role: 'reviewer',
      },
    });
    try {
      recordVersionedDefinitionUsage(db, {
        workflowId: params.workflowId,
        ...(params.taskId ? { taskId: params.taskId } : {}),
        definitionId: def.id,
        role: 'reviewer',
      });
    } catch {
      // Usage row is best-effort.
    }
  } catch {
    // Registry lookup must not block reviewer execution.
  }
}

export async function reviewViaPersona(
  task: Task,
  output: string,
  ctx: ReviewerRuntimeContext = {},
  invoke: AgentInvoker = reviewerOmnirouteInvoker,
): Promise<ReviewResult> {
  const input = buildReviewerInputFromTask(task, output, ctx);
  // Persona Opt 1 — only pass modelOverride when REVIEWER_MODEL is EXPLICITLY
  // set. getReviewerModel() returns a placeholder default when unset, which is
  // NOT a valid catalog id; passing it would regress users who don't set .env.
  // When unset, leave modelOverride undefined so REVIEWER_PERSONA.defaultModel
  // (cc/claude-sonnet-4-6) remains the fallback.
  const envModel = process.env.REVIEWER_MODEL ? getReviewerModel() : undefined;
  const reviewerOutput = await runAgent(REVIEWER_PERSONA, input, buildReviewerAgentContext(input), {
    invoke,
    parseJson: true,
    ...(envModel ? { modelOverride: envModel } : {}),
  });
  return reviewOutcomeToResult(reviewerOutputToOutcome(reviewerOutput));
}
