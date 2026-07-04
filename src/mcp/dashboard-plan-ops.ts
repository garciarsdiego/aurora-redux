import { z } from 'zod';
import type { Dag } from '../types/index.js';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';
import { planWorkflowTool } from './tools/plan_workflow.js';
import { validateDashboardDag } from './dashboard-dag-ops.js';
import {
  DashboardAttachmentsListSchema,
  formatAttachmentsForPrompt,
  type DashboardAttachment,
} from './dashboard-attachments.js';

// Sprint F4 (model picker): planner now accepts an optional `task_model` hint
// from the dashboard. The hint is forwarded as-is to planWorkflowTool, which
// in turn passes it to decompose() via DecomposeOptions.taskModelHint. The
// dashboard planner type widens to allow the optional field.
export type DashboardPlanner = (raw: {
  workspace: string;
  objective: string;
  workflow_mode?: 'standard' | 'existing_code_feature';
  task_model?: string;
  max_total_cost_usd?: number | null;
}) => Promise<string>;

// Onda 1 follow-up (D-H2.078): caps raised so operators can paste large
// production-grade plans (the 2026-05-04 multi-chat spec was ~30K chars and
// hit the old 20K cap). 200K matches `input_json` upper bound and the SQLite
// page-size guidance, while still defending against buffer-bomb DoS upstream
// of the 8 MB body cap in readLargeJsonBody. Decomposer.preHook truncates to
// 20K before sending to the LLM, so oversize objectives go through the same
// safe path as before — the operator just no longer hits a wall on import.
export const PlanDashboardDagSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  objective: z.string()
    .min(1)
    .max(200_000, {
      message:
        'Objective exceeds 200,000 characters. Save the plan as a .md file and attach it instead, or split the objective into sub-objectives.',
    }),
  feedback: z.string().max(80_000).optional(),
  current_dag: z.unknown().optional(),
  workflow_mode: z.enum(['standard', 'existing_code_feature']).optional().default('standard'),
  task_model: z.string().min(1).max(200).optional(),
  /** Optional per-run USD cap; echoed in planner JSON and applied when the DAG is executed. */
  max_total_cost_usd: z.number().nonnegative().nullable().optional(),
  // Sprint F4 (file upload): operator-attached files. The contents are
  // appended to the decomposer's user prompt via
  // formatAttachmentsForPrompt; text-like files are inlined, binary
  // files surface as filename + size metadata only.
  attachments: DashboardAttachmentsListSchema.optional(),
});

export interface DashboardPlannerObjectiveInput {
  objective: string;
  feedback?: string;
  current_dag?: unknown;
  // Sprint F4 (file upload): formatted attachments string appended after
  // the objective so the LLM sees the file context inline.
  attachments?: readonly DashboardAttachment[];
}

export interface DashboardPlanResult {
  status: string;
  workspace: string;
  objective: string;
  planner_objective: string;
  revision_feedback: string | null;
  task_count: number;
  pattern_used: string | null;
  skill_applied: unknown;
  execution_mode_source: string | null;
  workflow_mode: 'standard' | 'existing_code_feature';
  plan: unknown;
  dag: Dag;
  dag_json: string;
}

let plannerOverride: DashboardPlanner | null = null;

export function setDashboardPlannerForTests(planner: DashboardPlanner | null): void {
  plannerOverride = planner;
}

export function buildDashboardPlannerObjective(input: DashboardPlannerObjectiveInput): string {
  const feedback = input.feedback?.trim();
  // Sprint F4 (file upload): attachment-aware path. When attachments are
  // present we append the formatted block AFTER the objective (or after
  // the refine block) so the LLM sees them as supplemental context.
  const attachmentsBlock = input.attachments && input.attachments.length > 0
    ? formatAttachmentsForPrompt(input.attachments)
    : '';

  if (!feedback && input.current_dag === undefined) {
    return `${input.objective.trim()}${attachmentsBlock}`;
  }

  const currentDagJson = input.current_dag === undefined
    ? '(no current DAG provided)'
    : JSON.stringify(input.current_dag, null, 2);

  return [
    'Original objective:',
    input.objective.trim(),
    '',
    'Current DAG JSON:',
    currentDagJson,
    '',
    'Requested changes:',
    feedback || '(no explicit changes; improve the DAG while preserving intent)',
    '',
    'Return an updated Omniforge DAG. Preserve valid task ids when possible. Keep dependencies executable.',
  ].join('\n') + attachmentsBlock;
}

function parsePlannerJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('planner returned a non-object JSON payload');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Planner returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function dagFromPlannerPayload(payload: Record<string, unknown>): Dag {
  const rawDag = typeof payload['dag_json'] === 'string'
    ? JSON.parse(payload['dag_json'])
    : payload['dag'];
  return validateDashboardDag(rawDag);
}

export async function planDashboardDag(
  raw: unknown,
  planner: DashboardPlanner = plannerOverride ?? planWorkflowTool,
): Promise<DashboardPlanResult> {
  const input = PlanDashboardDagSchema.parse(raw);
  // Sprint F4 (file upload): the schema-parsed `attachments` is forwarded
  // through `buildDashboardPlannerObjective` so the formatted block is
  // appended exactly once; no second injection downstream.
  const plannerObjective = buildDashboardPlannerObjective({
    objective: input.objective,
    feedback: input.feedback,
    current_dag: input.current_dag,
    ...(input.attachments ? { attachments: input.attachments } : {}),
  });
  const text = await planner({
    workspace: input.workspace,
    objective: plannerObjective,
    workflow_mode: input.workflow_mode,
    ...(input.task_model ? { task_model: input.task_model } : {}),
    ...(input.max_total_cost_usd !== undefined
      ? { max_total_cost_usd: input.max_total_cost_usd }
      : {}),
  });
  const payload = parsePlannerJson(text);

  if (payload['error']) {
    const flags = Array.isArray(payload['flags']) ? ` (${payload['flags'].join(', ')})` : '';
    throw new Error(`${String(payload['error'])}${flags}`);
  }

  const dag = dagFromPlannerPayload(payload);
  return {
    status: typeof payload['status'] === 'string' ? payload['status'] : 'plan_ready',
    workspace: input.workspace,
    objective: input.objective.trim(),
    workflow_mode: input.workflow_mode,
    planner_objective: plannerObjective,
    revision_feedback: input.feedback?.trim() || null,
    task_count: dag.tasks.length,
    pattern_used: typeof payload['pattern_used'] === 'string' ? payload['pattern_used'] : null,
    skill_applied: payload['skill_applied'] ?? null,
    execution_mode_source: typeof payload['execution_mode_source'] === 'string'
      ? payload['execution_mode_source']
      : null,
    plan: payload['plan'] ?? dag.tasks,
    dag,
    dag_json: JSON.stringify(dag),
  };
}
