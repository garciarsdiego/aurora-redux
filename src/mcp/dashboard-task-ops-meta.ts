/**
 * dashboard-task-ops-meta.ts
 *
 * Meta operations for dashboard task operations layer.
 * Contains schemas, type definitions, and shared helper functions.
 *
 * Split from dashboard-task-ops.ts (884 LOC → ~200 LOC)
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Dag, DagTask, Task } from '../types/index.js';
import { TaskKindSchema } from '../types/schemas.js';
import { insertEvent, loadWorkflowTasks } from '../db/persist.js';
import { withSqliteRetrySync } from '../db/sqlite-retry.js';
import { getAutoCompactThreshold } from '../utils/config.js';
import {
  DEFAULT_COMPACTION_SETTINGS,
  maybeCompact,
  type MaybeCompactResult,
} from '../v2/context-engine/compaction.js';
import { loadTaskHandoff } from '../context/store.js';
import { validateDashboardDag } from './dashboard-dag-ops.js';
import { safeJsonObject } from './_json-utils.js';

const ModelRouteSchema = z.object({
  use_case: z.string().min(1).max(120).optional(),
  provider: z.string().min(1).max(80).optional(),
  strategy: z.enum(['quality', 'cost', 'balanced']).optional(),
  required_capabilities: z.array(z.enum([
    'streaming',
    'structured_output',
    'tool_calling',
    'multimodal',
    'embeddings',
    'batch',
    'local',
  ])).optional(),
}).strict();

export const PatchDashboardTaskSchema = z.object({
  name: z.string().min(1).max(240).optional(),
  kind: TaskKindSchema.optional(),
  model: z.union([z.string().min(1).max(240), z.null()]).optional(),
  model_route: z.union([ModelRouteSchema, z.null()]).optional(),
  executor_hint: z.union([z.string().min(1).max(160), z.null()]).optional(),
  acceptance_criteria: z.union([z.string().min(1).max(4_000), z.null()]).optional(),
  timeout_seconds: z.number().int().min(60).max(1800).optional(),
  tool_name: z.union([z.string().min(1).max(160), z.null()]).optional(),
  args: z.union([z.record(z.string(), z.unknown()), z.null()]).optional(),
  tool_policy: z.unknown().optional(),
  input_json: z.union([z.string().min(1).max(200_000), z.null()]).optional(),
});

export const RetryDashboardTaskSchema = z.object({
  mode: z.enum(['task', 'downstream', 'failed', 'workflow']).optional().default('downstream'),
  objective: z.string()
    .min(1)
    .max(200_000, {
      message:
        'Retry objective exceeds 200,000 characters. Either trim the objective or split the retry into smaller scopes.',
    })
    .optional(),
  auto_approve: z.boolean().optional().default(false),
  cli_permission_mode: z.enum(['safe', 'autonomous']).optional(),
  handoff_id: z.string().min(1).max(160).optional(),
});

export const AdjustDashboardTaskSchema = z.object({
  instruction: z.string().max(40_000).optional(),
  apply: z.boolean().optional().default(false),
});

export type DashboardTaskRetryMode = z.infer<typeof RetryDashboardTaskSchema>['mode'];

export interface DashboardTaskRetryDag {
  source_workflow_id: string;
  source_task_id: string;
  retry_scope: DashboardTaskRetryMode;
  workspace: string;
  objective: string;
  auto_approve: boolean;
  cli_permission_mode?: 'safe' | 'autonomous';
  dag: Dag;
  omitted_dependencies: Array<{ task_id: string; omitted: string[] }>;
}

export interface DashboardTaskRetryInPlace {
  source_workflow_id: string;
  source_task_id: string;
  retry_scope: DashboardTaskRetryMode;
  workspace: string;
  objective: string;
  auto_approve: boolean;
  cli_permission_mode?: 'safe' | 'autonomous';
  task_ids: string[];
  task_count: number;
  omitted_dependencies: Array<{ task_id: string; omitted: string[] }>;
}

export interface DashboardTaskAdjustResult {
  source_workflow_id: string;
  source_task_id: string;
  dag_task_id: string;
  applied: boolean;
  discarded_task_count: number;
  suggested_task: DagTask | null;
  task: Task | null;
  diagnosis_text?: string;
  refiner_changelog?: string[];
}

export function reloadTask(db: Database.Database, workflowId: string, taskId: string): Task {
  const task = loadWorkflowTasks(db, workflowId).find((item) => item.id === taskId);
  if (!task) throw new Error(`Task not found in workflow: ${taskId}`);
  return task;
}

async function compactDashboardText(input: {
  db: Database.Database;
  workflowId: string;
  taskId: string;
  text: string;
  stage: string;
  model?: string | null;
}): Promise<string> {
  const compacted = await maybeCompact(
    input.text,
    [],
    { ...DEFAULT_COMPACTION_SETTINGS, autoCompactThreshold: getAutoCompactThreshold() },
    input.model ?? DEFAULT_COMPACTION_SETTINGS.summarizationModel ?? 'unknown',
    `${input.workflowId}_${input.taskId}_${input.stage}`,
    input.workflowId,
  );
  emitContextCompactionEvent(input.db, input.workflowId, input.taskId, input.stage, compacted);
  return compacted.contextText;
}

function emitContextCompactionEvent(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  sourceStage: string,
  result: MaybeCompactResult,
): void {
  if (result.compactStats.stage === 'none') return;
  insertEvent(db, {
    workflow_id: workflowId,
    task_id: taskId,
    type: 'context_compaction',
    payload: {
      workflow_id: workflowId,
      task_id: taskId,
      stage: result.compactStats.stage,
      source_stage: sourceStage,
      chars_before: result.compactStats.charsBefore,
      chars_after: result.compactStats.charsAfter,
      archive_path: result.archivePath ?? null,
    },
  });
}

export { safeJsonObject, compactDashboardText };

function stringifyMaybeJson(raw: string | null): string {
  if (!raw) return '(empty)';
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

function buildSingleTaskAdjustObjective(input: {
  workflowObjective: string;
  currentDagTask: DagTask;
  task: Task;
  instruction?: string;
  events: string;
}): string {
  return [
    'You are revising exactly one Omniforge DAG task after a failed run.',
    '',
    'Return JSON for an Omniforge DAG with exactly one task in dag.tasks.',
    'Do not include upstream or downstream tasks. Do not create a full workflow.',
    'Use depends_on: [] in the returned single-task DAG; the dashboard will preserve existing graph edges when applying the patch.',
    'Keep the same task id shown below unless changing it is absolutely necessary.',
    'Prefer the smallest structural change that addresses the failure.',
    '',
    'Workflow objective:',
    input.workflowObjective,
    '',
    'Current task row:',
    JSON.stringify({
      id: input.task.id,
      name: input.task.name,
      kind: input.task.kind,
      model: input.task.model,
      executor_hint: input.task.executor_hint,
      timeout_seconds: input.task.timeout_seconds,
      acceptance_criteria: input.task.acceptance_criteria,
      retry_count: input.task.retry_count,
      status: input.task.status,
    }, null, 2),
    '',
    'Current DAG task structure:',
    JSON.stringify(input.currentDagTask, null, 2),
    '',
    'Task input_json:',
    stringifyMaybeJson(input.task.input_json),
    '',
    'Task output_json:',
    stringifyMaybeJson(input.task.output_json),
    '',
    'Recent task/error events:',
    input.events || '(no task-scoped events found)',
    '',
    'Operator instruction:',
    input.instruction?.trim() || 'Fix the task structure so the next retry can complete. Preserve the task intent.',
  ].join('\n');
}

async function taskFailureContext(db: Database.Database, workflowId: string, taskId: string): Promise<string> {
  const rows = db.prepare(
    `SELECT type, payload_json, timestamp
       FROM events
      WHERE workflow_id = ?
        AND (task_id = ? OR payload_json LIKE ?)
      ORDER BY timestamp DESC
      LIMIT 12`,
  ).all(workflowId, taskId, `%${taskId}%`) as Array<{
    type: string;
    payload_json: string | null;
    timestamp: number;
  }>;
  const formatted = rows
    .reverse()
    .map((row) => {
      const payload = row.payload_json ?? '{}';
      return `${new Date(row.timestamp).toISOString()} ${row.type}: ${payload}`;
    })
    .join('\n');
  return compactDashboardText({
    db,
    workflowId,
    taskId,
    text: formatted,
    stage: 'dashboard_task_failure_context',
  });
}

export function descendantsOf(targetId: string, tasks: readonly DagTask[]): Set<string> {
  const selected = new Set<string>([targetId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (selected.has(task.id)) continue;
      if (task.depends_on.some((dep) => selected.has(dep))) {
        selected.add(task.id);
        changed = true;
      }
    }
  }
  return selected;
}

function failedTaskDagIds(tasks: readonly Task[], dagTasks: readonly DagTask[]): Set<string> {
  const selected = new Set<string>();
  dagTasks.forEach((dagTask, index) => {
    if (tasks[index]?.status === 'failed') selected.add(dagTask.id);
  });
  return selected;
}

export function selectedDagIdsForRetry(
  mode: DashboardTaskRetryMode,
  targetDagId: string,
  tasks: readonly Task[],
  dagTasks: readonly DagTask[],
): Set<string> {
  if (mode === 'workflow') return new Set(dagTasks.map((task) => task.id));
  if (mode === 'task') return new Set([targetDagId]);
  if (mode === 'failed') return failedTaskDagIds(tasks, dagTasks);
  return descendantsOf(targetDagId, dagTasks);
}

export function sliceDag(dag: Dag, selectedIds: Set<string>): {
  dag: Dag;
  omitted_dependencies: Array<{ task_id: string; omitted: string[] }>;
} {
  const omitted: Array<{ task_id: string; omitted: string[] }> = [];
  const tasks = dag.tasks
    .filter((task) => selectedIds.has(task.id))
    .map((task) => {
      const keptDeps = task.depends_on.filter((dep) => selectedIds.has(dep));
      const omittedDeps = task.depends_on.filter((dep) => !selectedIds.has(dep));
      if (omittedDeps.length > 0) {
        omitted.push({ task_id: task.id, omitted: omittedDeps });
      }
      return { ...task, depends_on: keptDeps };
    });
  return { dag: validateDashboardDag({ tasks }), omitted_dependencies: omitted };
}

function shouldInjectExecutionPlan(task: DagTask): boolean {
  const combined = `${task.name}\n${task.acceptance_criteria ?? ''}`.toLowerCase();
  return combined.includes('execution plan') || (
    combined.includes('plan lists') &&
    combined.includes('subsequent tasks') &&
    combined.includes('deliverable')
  );
}

function buildExecutionPlanInput(dag: Dag, currentTaskId: string): Record<string, unknown> {
  return {
    current_task_id: currentTaskId,
    tasks: dag.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      kind: task.kind,
      depends_on: task.depends_on,
      deliverable: task.output_summary ?? task.acceptance_criteria ?? task.name,
      acceptance_criteria: task.acceptance_criteria ?? null,
    })),
  };
}

export function backfillExecutionPlanInputsForRetry(
  db: Database.Database,
  workflowId: string,
  tasks: readonly Task[],
  dag: Dag,
  selectedDagIds: Set<string>,
): void {
  for (const [index, dagTask] of dag.tasks.entries()) {
    if (!selectedDagIds.has(dagTask.id)) continue;
    if (!shouldInjectExecutionPlan(dagTask)) continue;
    const task = tasks[index];
    if (!task) continue;
    const input = safeJsonObject(task.input_json);
    input['execution_plan'] = buildExecutionPlanInput(dag, dagTask.id);
    withSqliteRetrySync(() =>
      db.prepare(`UPDATE tasks SET input_json = ? WHERE workflow_id = ? AND id = ?`)
        .run(JSON.stringify(input), workflowId, task.id),
    );
  }
}

function selectSuggestedTask(tasks: DagTask[], targetDagTask: DagTask): {
  task: DagTask;
  discarded_task_count: number;
} {
  const selected =
    tasks.length === 1
      ? tasks[0]
      : tasks.find((task) => task.id === targetDagTask.id)
        ?? tasks.find((task) => task.name.trim().toLowerCase() === targetDagTask.name.trim().toLowerCase());
  if (!selected) {
    throw new Error('AI adjustment returned multiple tasks but none matched the selected task');
  }
  return {
    task: selected,
    discarded_task_count: Math.max(0, tasks.length - 1),
  };
}

export function patchFromSuggestedTask(task: DagTask): z.infer<typeof PatchDashboardTaskSchema> {
  return {
    name: task.name,
    kind: task.kind,
    model: task.model ?? null,
    model_route: task.model_route ?? null,
    executor_hint: task.executor_hint ?? null,
    acceptance_criteria: task.acceptance_criteria ?? null,
    timeout_seconds: task.timeout_seconds,
    tool_name: task.tool_name ?? null,
    args: task.args ?? null,
    ...(task.tool_policy !== undefined ? { tool_policy: task.tool_policy } : {}),
  };
}

async function buildAdjustObjectiveWithCompaction(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  workflowObjective: string,
  currentDagTask: DagTask,
  task: Task,
  instruction?: string,
): Promise<string> {
  const failureContext = await taskFailureContext(db, workflowId, taskId);
  const objective = buildSingleTaskAdjustObjective({
    workflowObjective,
    currentDagTask,
    task,
    instruction,
    events: failureContext,
  });
  return compactDashboardText({
    db,
    workflowId,
    taskId,
    text: objective,
    stage: 'dashboard_task_adjust_objective',
    model: task.model,
  });
}

export function loadHandoffContext(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  handoffId: string,
): { id: string; title: string; body: string } {
  const handoff = loadTaskHandoff(db, handoffId);
  if (!handoff) {
    throw new Error(`Handoff not found: ${handoffId}`);
  }
  if (handoff.run_id !== workflowId) {
    throw new Error(
      `Handoff ${handoffId} belongs to a different workflow (got run_id=${handoff.run_id}, expected ${workflowId})`,
    );
  }
  if (handoff.task_id !== taskId) {
    throw new Error(
      `Handoff ${handoffId} belongs to a different task (got task_id=${handoff.task_id}, expected ${taskId})`,
    );
  }
  return { id: handoff.id, title: handoff.title, body: handoff.body };
}

export { buildAdjustObjectiveWithCompaction, selectSuggestedTask };