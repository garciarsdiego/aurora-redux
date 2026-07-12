/**
 * dashboard-task-ops-tasks.ts
 *
 * Task-level operations for dashboard task operations layer.
 * Handles task patching and AI-assisted task adjustment.
 *
 * Split from dashboard-task-ops.ts (884 LOC → ~250 LOC)
 */

import type Database from 'better-sqlite3';
import type { Dag, DagTask, Task } from '../types/index.js';
import { loadWorkflowById, insertEvent } from '../db/persist.js';
import { withSqliteRetrySync } from '../db/sqlite-retry.js';
import { callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import { getUsePersonas } from '../utils/config.js';
import { normalizeCliExecutorHintForModel } from '../utils/cli-routing.js';
import { runAgent, type AgentInvoker } from '../v2/agents/runner.js';
import {
  REFINER_PERSONA,
  KNOWN_CLIS,
  type RefinerInput,
} from '../v2/agents/index.js';
import { AgentRejectedError, AgentOutputError, type AgentContext } from '../v2/agents/types.js';
import { reconstructWorkflowDag } from './dashboard-dag-ops.js';
import { planDashboardDag, type DashboardPlanner } from './dashboard-plan-ops.js';
import {
  PatchDashboardTaskSchema,
  AdjustDashboardTaskSchema,
  DashboardTaskAdjustResult,
  safeJsonObject,
  reloadTask,
  buildAdjustObjectiveWithCompaction,
  selectSuggestedTask,
  patchFromSuggestedTask,
} from './dashboard-task-ops-meta.js';

const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
    model: args.model,
  });
  return result.content;
};

function buildRefinerAgentContext(workflowId: string, taskId: string): AgentContext {
  return {
    retryCount: 0,
    workflowId,
    taskId,
    workspaceDir: process.cwd(),
    emit(event, payload) {
      console.debug(`[dashboard-task-ops:refiner:event] ${event}`, payload);
    },
    warn(message, payload) {
      console.warn(`[dashboard-task-ops:refiner:warn] ${message}`, payload ?? '');
    },
    log(level, message, payload) {
      if (level === 'error' || level === 'warn') {
        console.warn(`[dashboard-task-ops:refiner:${level}] ${message}`, payload ?? '');
      }
    },
  };
}

export function patchDashboardTask(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  rawPatch: unknown,
): Task {
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const task = (() => {
    const tasks = db.prepare(
      `SELECT * FROM tasks WHERE workflow_id = ? AND id = ?`,
    ).get(workflowId, taskId) as Task | undefined;
    if (!tasks) throw new Error(`Task not found in workflow: ${taskId}`);
    return tasks;
  })();
  if (task.status === 'running') throw new Error('Cannot patch a running task');

  const patch = PatchDashboardTaskSchema.parse(rawPatch);
  const inputJsonOverride =
    'input_json' in patch && typeof patch.input_json === 'string' ? patch.input_json : null;
  const input = inputJsonOverride
    ? (() => {
        try {
          const parsed = JSON.parse(inputJsonOverride) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          /* not JSON — fall through to objective wrapper */
        }
        return { objective: inputJsonOverride };
      })()
    : safeJsonObject(task.input_json);

  if ('model_route' in patch) {
    if (patch.model_route === null) delete input['model_route'];
    else input['model_route'] = patch.model_route;
  }
  if ('tool_name' in patch) {
    if (patch.tool_name === null) delete input['tool_name'];
    else input['tool_name'] = patch.tool_name;
  }
  if ('args' in patch) {
    if (patch.args === null) delete input['args'];
    else input['args'] = patch.args;
  }
  if ('tool_policy' in patch) {
    if (patch.tool_policy === null) delete input['tool_policy'];
    else input['tool_policy'] = patch.tool_policy;
  }

  const name = patch.name ?? task.name;
  const model = 'model' in patch ? patch.model ?? null : task.model;
  const kind = patch.kind ?? task.kind;
  const requestedExecutorHint = 'executor_hint' in patch ? patch.executor_hint ?? null : task.executor_hint;
  const executorHint = normalizeCliExecutorHintForModel(kind, requestedExecutorHint, model);
  const acceptance = 'acceptance_criteria' in patch
    ? patch.acceptance_criteria ?? null
    : task.acceptance_criteria;
  const timeoutSeconds = patch.timeout_seconds ?? task.timeout_seconds;

  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks
        SET name = ?,
            kind = ?,
            model = ?,
            executor_hint = ?,
            acceptance_criteria = ?,
            timeout_seconds = ?,
            tool_name = ?,
            input_json = ?
      WHERE id = ? AND workflow_id = ?`,
    ).run(
      name,
      kind,
      model,
      executorHint,
      acceptance,
      timeoutSeconds,
      'tool_name' in patch ? patch.tool_name ?? null : task.tool_name ?? null,
      JSON.stringify(input),
      taskId,
      workflowId,
    ),
  );

  insertEvent(db, {
    workflow_id: workflowId,
    task_id: taskId,
    type: 'dashboard_task_patched',
    payload: {
      name,
      kind,
      model,
      executor_hint: executorHint,
      timeout_seconds: timeoutSeconds,
      tool_name: input['tool_name'] ?? null,
      args: input['args'] ?? null,
      model_route: input['model_route'] ?? null,
    },
  });

  return reloadTask(db, workflowId, taskId);
}

export async function adjustDashboardTaskWithAi(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  raw: unknown = {},
  planner?: DashboardPlanner,
): Promise<DashboardTaskAdjustResult> {
  const input = AdjustDashboardTaskSchema.parse(raw);
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const tasks = db.prepare(
    `SELECT * FROM tasks WHERE workflow_id = ?`,
  ).all(workflowId) as Task[];
  const taskIndex = tasks.findIndex((item) => item.id === taskId);
  if (taskIndex < 0) throw new Error(`Task not found in workflow: ${taskId}`);
  const task = tasks[taskIndex]!;
  if (task.status === 'running') throw new Error('Cannot adjust a running task');

  const replay = reconstructWorkflowDag(db, workflowId);
  const currentDagTask = replay.dag.tasks[taskIndex];
  if (!currentDagTask) throw new Error(`Cannot map task to DAG node: ${taskId}`);

  const defaultFeedback =
    'Fix the task structure so the next retry can complete. Preserve the task intent.';
  const feedbackBase = input.instruction?.trim() || defaultFeedback;
  const feedbackText = feedbackBase.slice(0, 8_000);

  let suggestedTask: DagTask | null = null;
  let discardedTaskCount = 0;
  let diagnosisText: string | undefined;
  let refinerChangelog: string[] | undefined;

  if (getUsePersonas()) {
    try {
      const refinerInput: RefinerInput = {
        workspace: workflow.workspace,
        workflow_id: workflowId,
        current_dag: replay.dag,
        feedback_text: feedbackText,
        feedback_origin: 'operator',
        failed_task_ids: [taskId],
        retry_count_for_failed: task.retry_count,
        available_models: [],
        available_clis: [...KNOWN_CLIS],
      };
      const ctx = buildRefinerAgentContext(workflowId, taskId);
      const refined = await runAgent(REFINER_PERSONA, refinerInput, ctx, { invoke: omnirouteInvoker, parseJson: true });
      const selected = selectSuggestedTask(refined.tasks, currentDagTask);
      suggestedTask = {
        ...selected.task,
        id: currentDagTask.id,
        depends_on: currentDagTask.depends_on,
      };
      refinerChangelog = refined.changelog;
      discardedTaskCount = selected.discarded_task_count;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `[dashboard-task-ops] REFINER_PERSONA path failed (${(err instanceof AgentRejectedError || err instanceof AgentOutputError) ? err.constructor.name : 'Error'}: ${detail}); falling back to legacy planner`,
      );
    }
  }

  if (!suggestedTask) {
    const objective = await buildAdjustObjectiveWithCompaction(
      db,
      workflowId,
      taskId,
      workflow.objective,
      currentDagTask,
      task,
      input.instruction,
    );
    try {
      const plan = await planDashboardDag({ workspace: workflow.workspace, objective }, planner);
      const selected = selectSuggestedTask(plan.dag.tasks, currentDagTask);
      suggestedTask = {
        ...selected.task,
        id: currentDagTask.id,
        depends_on: currentDagTask.depends_on,
      };
      discardedTaskCount = selected.discarded_task_count;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const proseMatch = /Preview:\s*(.+)$/s.exec(message);
      if (proseMatch && message.includes('failed to parse LLM output as JSON')) {
        diagnosisText = proseMatch[1].trim();
      } else if (message.includes('did not match DagSchema')) {
        diagnosisText = message;
      } else {
        throw err;
      }
    }
  }

  const patchedTask = input.apply && suggestedTask
    ? patchDashboardTask(db, workflowId, taskId, patchFromSuggestedTask(suggestedTask))
    : null;

  insertEvent(db, {
    workflow_id: workflowId,
    task_id: taskId,
    type: input.apply
      ? 'dashboard_task_ai_adjusted'
      : suggestedTask
        ? 'dashboard_task_ai_adjustment_suggested'
        : 'dashboard_task_ai_diagnosis_text',
    payload: {
      instruction: input.instruction?.trim() || null,
      suggested_task: suggestedTask,
      diagnosis_text: diagnosisText ?? null,
      discarded_task_count: discardedTaskCount,
      applied: input.apply && Boolean(suggestedTask),
      refiner_changelog: refinerChangelog ?? null,
    },
  });

  return {
    source_workflow_id: workflowId,
    source_task_id: taskId,
    dag_task_id: currentDagTask.id,
    applied: input.apply && Boolean(suggestedTask),
    discarded_task_count: discardedTaskCount,
    suggested_task: suggestedTask,
    ...(diagnosisText ? { diagnosis_text: diagnosisText } : {}),
    ...(refinerChangelog ? { refiner_changelog: refinerChangelog } : {}),
    task: patchedTask,
  };
}