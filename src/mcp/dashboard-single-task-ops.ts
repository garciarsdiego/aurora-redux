// Sprint F4 (D-H2.066): Plan / Build / Discuss modes — single-task runner.
//
// The dashboard's Composer in apps/dashboard-v2 exposes a three-pill
// segmented control: Plan / Build / Discuss. Plan keeps using the
// existing planRunPreview → commitRun loop. Build and Discuss bypass
// the decomposer entirely — the operator already knows what they want
// to do, the gate review would be vacuous. This module owns the
// equivalent endpoint:
//
//   POST /api/runs/single-task
//
// and creates a workflow with EXACTLY one task whose kind is derived
// from the mode:
//
//   build   → cli_spawn (executor_hint=cli:claude-code by default)
//   discuss → llm_call  (model from operator pick or TASK_MODEL env)
//
// Behaviour mirrors a one-task DAG passed through runDashboardDag —
// pre-decomposition injection scan, idempotency check, background
// execution via runWorkflowTool — except the DAG is constructed
// programmatically here rather than coming from the decomposer.
//
// The objective + attachment metadata flows to the executing model via
// the single task's prompt context. We DO NOT add a t0 plan gate
// because the whole point of build/discuss is to skip preview — the
// schema already requires t0 with hitl=true for the standard flow,
// but for a one-task workflow we mark the task itself as the entry
// (no plan gate needed).
//
// Why a separate file (vs extending dashboard-run-ops.ts):
//   - dashboard-run-ops.ts owns workflow patches/alerts (no DAG building).
//   - Single-task synthesis is a separate concern: we can extend it
//     later to support more modes (Test / Review / etc) without
//     bloating the existing module.

import { z } from 'zod';
import type { Dag } from '../types/index.js';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';
import { runDashboardDag } from './routes/_dashboard-dag-helpers.js';
import {
  DashboardAttachmentsListSchema,
  formatAttachmentsForPrompt,
  type DashboardAttachment,
} from './dashboard-attachments.js';

export const SingleTaskModeSchema = z.enum(['build', 'discuss']);
export type SingleTaskMode = z.infer<typeof SingleTaskModeSchema>;

// D-H2.078: cap raised from 20K → 200K (see dashboard-plan-ops.ts header for
// rationale). Build/Discuss modes deliver the objective straight to the
// executing model, which itself bounds the prompt at the model's context
// window — no decomposer truncation between schema and LLM here, so the upper
// bound IS the operative ceiling for these modes.
export const RunSingleTaskSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE).optional(),
  objective: z.string()
    .min(1)
    .max(200_000, {
      message:
        'Objective exceeds 200,000 characters. Save the plan as a .md file and attach it instead, or split the objective into sub-objectives.',
    }),
  mode: SingleTaskModeSchema,
  // Operator-selected model. We use the dashboard's "task_model" / "auto"
  // contract: undefined / "auto" → fall back to the executor's defaults.
  taskModel: z.string().min(1).max(200).optional(),
  attachments: DashboardAttachmentsListSchema.optional(),
  cli_permission_mode: z.enum(['safe', 'autonomous']).optional(),
});

export type RunSingleTaskInput = z.infer<typeof RunSingleTaskSchema>;

export interface RunSingleTaskResult {
  workflow_id: string;
  status: string;
  task_count: number;
  mode: SingleTaskMode;
}

/**
 * Build a one-task DAG for the given mode + objective.
 *
 * Build mode:
 *   - kind=cli_spawn so the executing CLI handles file writes / code
 *   - executor_hint defaults to cli:claude-code unless the operator's
 *     model pick is itself a cli:* hint (e.g. "cli:codex"), in which
 *     case we honour that as the executor
 *   - acceptance_criteria is intentionally generic ("Task completes
 *     successfully and produces requested artifact") because the
 *     operator's objective already carries the spec; the executor
 *     reads the objective for the actual contract.
 *
 * Discuss mode:
 *   - kind=llm_call so we get streaming text back
 *   - model: operator's pick OR null (env fallback). PAL tasks would
 *     also fit here in theory, but Discuss is conversational by
 *     design — we keep it simple and let the operator flip to Plan
 *     mode if they want PAL consensus.
 *   - acceptance_criteria reflects the conversational nature: the
 *     reviewer should accept any non-empty answer that addresses the
 *     question. We write that explicitly so the post-task reviewer
 *     doesn't penalize a chat-style response.
 *
 * Both modes:
 *   - Single task with id="t0" and depends_on=[]. No HITL gate — the
 *     point of single-task is to run immediately.
 *   - timeout_seconds: 600 (build) or 300 (discuss) — generous enough
 *     for non-trivial work without being open-ended.
 */
// Example smoke test 2026-04-30 round 8: when the operator picks an LLM-only
// model (minimax/*, openai-direct/*, etc.) and submits in Build mode, the
// previous logic emitted `executor_hint=cli:claude-code` AND `model=<that
// LLM>`. The cli_spawn dispatched to Claude Code which did not recognize
// the model, blowing up at runtime. Mirror the decomposer's
// `providerToCliId` coherence rule here so Build mode never passes an
// incompatible model to a CLI.
//
// Mapping rules (must stay in sync with decomposer.ts):
//   cc/*          → cli:claude-code
//   cx/* / codex  → cli:codex
//   gemini-cli/*  → cli:gemini
//   kimi/* / kmc/*→ cli:kimi
//   anything else → null (LLM has no CLI counterpart; fall back to
//                   cli:claude-code with model=null so the CLI uses its
//                   native default model)
function providerToCliId(model: string): string | null {
  const provider = (model.includes('/') ? model.split('/')[0] : '').toLowerCase();
  switch (provider) {
    case 'cc':
    case 'claude':
      return 'cli:claude-code';
    case 'cx':
    case 'codex':
      return 'cli:codex';
    case 'gemini-cli':
      return 'cli:gemini';
    case 'kimi':
    case 'kmc':
    case 'kmca':
    case 'kimi-coding':
      return 'cli:kimi';
    default:
      return null;
  }
}

interface BuildModeRouting {
  executorHint: string;
  model: string | null;
}

function routeBuildMode(taskModel: string | undefined): BuildModeRouting {
  // Operator hadn't picked anything: use the universal default (Claude Code
  // with its native model).
  if (!taskModel) {
    return { executorHint: 'cli:claude-code', model: null };
  }
  // Operator picked a CLI directly: honor that CLI, leave model unset so
  // the CLI uses its own default.
  if (taskModel.startsWith('cli:')) {
    return { executorHint: taskModel, model: null };
  }
  // Operator picked an LLM with a matching CLI in the same provider family:
  // route through the matching CLI AND pass the model so the CLI uses it.
  const matchedCli = providerToCliId(taskModel);
  if (matchedCli) {
    return { executorHint: matchedCli, model: taskModel };
  }
  // Operator picked an LLM-only model with no CLI counterpart: fall back to
  // cli:claude-code with model=null so the CLI uses its native default. The
  // operator's pick is silently dropped for this Build-mode task because
  // the alternative is a guaranteed runtime failure. Discuss mode (below)
  // honors the LLM pick fully.
  return { executorHint: 'cli:claude-code', model: null };
}

function buildSingleTaskDag(
  objective: string,
  mode: SingleTaskMode,
  taskModel: string | undefined,
): Dag {
  if (mode === 'build') {
    const routing = routeBuildMode(taskModel);
    return {
      tasks: [
        {
          id: 't0',
          name: truncateForName(objective),
          kind: 'cli_spawn',
          depends_on: [],
          executor_hint: routing.executorHint,
          model: routing.model,
          acceptance_criteria:
            'Task completes successfully and produces the artifact described in the objective. Exit cleanly without errors.',
          timeout_seconds: 600,
          hitl: false,
        },
      ],
    };
  }

  // Discuss mode — kind=llm_call. Any LLM model is fair game (no CLI
  // boundary). A cli:* hint would be incoherent here, so we drop it.
  const isCliHint = taskModel?.startsWith('cli:');
  return {
    tasks: [
      {
        id: 't0',
        name: truncateForName(objective),
        kind: 'llm_call',
        depends_on: [],
        executor_hint: null,
        model: isCliHint || !taskModel ? null : taskModel,
        acceptance_criteria:
          'Provides a substantive answer to the operator\'s question. Output is non-empty and directly addresses the objective.',
        timeout_seconds: 300,
        hitl: false,
      },
    ],
  };
}

/**
 * Truncate an objective into a task name (≤80 chars). The decomposer
 * normally writes punchy 4-8 word names; the operator's free-form
 * objective in Build/Discuss is rarely that short, so we ellipsis it.
 * Tasks with overly long names cause UI overflow on RunList cards.
 */
function truncateForName(objective: string): string {
  const trimmed = objective.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}…`;
}

/**
 * Bake the formatted attachments block into the executor's view of the
 * objective. Unlike Plan mode (where the decomposer LLM sees the
 * attachments and reasons about them), Build/Discuss have a single
 * task whose prompt IS the objective text. The cleanest way to expose
 * the attachments is to append the formatted block to the workflow's
 * objective — every executor reads `workflow.objective` as part of
 * its prompt build path.
 */
function objectiveWithAttachments(
  objective: string,
  attachments: readonly DashboardAttachment[] | undefined,
): string {
  if (!attachments || attachments.length === 0) return objective;
  return `${objective}${formatAttachmentsForPrompt(attachments)}`;
}

/**
 * Resolves the workspace to use when the operator didn't specify one.
 * Mirrors the dashboard's default workspace fallback chain so single-task
 * runs end up in the same place as plan-mode runs:
 *   1. operator-supplied workspace
 *   2. "internal" — Omniforge's default workspace name; safe fallback
 *      because it's pre-validated against VALID_WORKSPACE_RE and is
 *      created automatically on first daemon boot.
 */
function resolveWorkspace(input: RunSingleTaskInput): string {
  return input.workspace ?? 'internal';
}

/**
 * Top-level entry. Validates the input, synthesises a one-task DAG,
 * and forwards through `runDashboardDag` (the same path the regular
 * dashboard run endpoint uses). Returns the new workflow id + status
 * back to the dashboard.
 *
 * Errors propagate as Error throws — the HTTP handler catches and
 * surfaces as 4xx. The runDashboardDag → runWorkflowTool path mints
 * the workflow id; we just receive it back in the result.
 */
export async function runDashboardSingleTask(
  raw: unknown,
): Promise<RunSingleTaskResult> {
  const input = RunSingleTaskSchema.parse(raw);
  const workspace = resolveWorkspace(input);
  const dag = buildSingleTaskDag(input.objective, input.mode, input.taskModel);
  const objective = objectiveWithAttachments(input.objective, input.attachments);
  const cliPermissionMode = input.cli_permission_mode ?? (input.mode === 'build' ? 'autonomous' : 'safe');

  // Tag the run via the executor's pre-existing path. Note that
  // runDashboardDag re-validates the DAG via validateDashboardDag, so
  // any malformed task synthesised here would surface as a clean error
  // rather than a silent execution drift.
  const result = await runDashboardDag({
    workspace,
    objective,
    dag,
    auto_approve: false,
    cli_permission_mode: cliPermissionMode,
  });

  // A missing workflow_id means the run was never persisted — surface that
  // instead of fabricating an id the dashboard could never resolve.
  const workflowId = result['workflow_id'];
  if (typeof workflowId !== 'string' || workflowId.length === 0) {
    throw new Error('runDashboardDag returned no workflow_id');
  }
  const status = typeof result['status'] === 'string'
    ? result['status']
    : 'started';

  return {
    workflow_id: workflowId,
    status,
    task_count: dag.tasks.length,
    mode: input.mode,
  };
}
