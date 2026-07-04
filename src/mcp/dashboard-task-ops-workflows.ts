/**
 * dashboard-task-ops-workflows.ts
 *
 * Workflow-level operations for dashboard task operations layer.
 * Handles workflow retry DAG building and in-place retry preparation.
 *
 * Split from dashboard-task-ops.ts (884 LOC → ~200 LOC)
 */

import type Database from 'better-sqlite3';
import type { Dag, Task } from '../types/index.js';
import { loadWorkflowById, loadWorkflowTasks, insertEvent } from '../db/persist.js';
import { withSqliteRetrySync } from '../db/sqlite-retry.js';
import { normalizeCliExecutorHintForModel } from '../utils/cli-routing.js';
import { reconstructWorkflowDag } from './dashboard-dag-ops.js';
import {
  RetryDashboardTaskSchema,
  DashboardTaskRetryDag,
  DashboardTaskRetryInPlace,
  DashboardTaskRetryMode,
  selectedDagIdsForRetry,
  sliceDag,
  backfillExecutionPlanInputsForRetry,
  loadHandoffContext,
} from './dashboard-task-ops-meta.js';

export function buildDashboardTaskRetryDag(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  raw: unknown = {},
): DashboardTaskRetryDag {
  const input = RetryDashboardTaskSchema.parse(raw);
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const tasks = loadWorkflowTasks(db, workflowId);
  const taskIndex = tasks.findIndex((task) => task.id === taskId);
  if (taskIndex < 0) throw new Error(`Task not found in workflow: ${taskId}`);

  const replay = reconstructWorkflowDag(db, workflowId);
  const targetDagId = replay.dag.tasks[taskIndex]?.id;
  if (!targetDagId) throw new Error(`Cannot map task to DAG node: ${taskId}`);

  const selectedIds = selectedDagIdsForRetry(input.mode, targetDagId, tasks, replay.dag.tasks);
  if (selectedIds.size === 0) throw new Error('No failed tasks selected for retry');
  const sliced = sliceDag(replay.dag, selectedIds);
  const sourceObjective = workflow.objective?.trim()
    || `Retry ${tasks[taskIndex]?.name ?? taskId} from ${workflow.id}`;

  return {
    source_workflow_id: workflowId,
    source_task_id: taskId,
    retry_scope: input.mode,
    workspace: workflow.workspace,
    objective: input.objective?.trim() || sourceObjective,
    auto_approve: input.auto_approve,
    ...(input.cli_permission_mode ? { cli_permission_mode: input.cli_permission_mode } : {}),
    ...sliced,
  };
}

export function prepareDashboardTaskRetryInPlace(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  raw: unknown = {},
): DashboardTaskRetryInPlace {
  const input = RetryDashboardTaskSchema.parse(raw);
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const tasks = loadWorkflowTasks(db, workflowId);
  const taskIndex = tasks.findIndex((task) => task.id === taskId);
  if (taskIndex < 0) throw new Error(`Task not found in workflow: ${taskId}`);

  let handoffContext: { id: string; title: string; body: string } | null = null;
  if (input.handoff_id) {
    handoffContext = loadHandoffContext(db, workflowId, taskId, input.handoff_id);
  }

  const replay = reconstructWorkflowDag(db, workflowId);
  const targetDagId = replay.dag.tasks[taskIndex]?.id;
  if (!targetDagId) throw new Error(`Cannot map task to DAG node: ${taskId}`);

  const selectedDagIds = selectedDagIdsForRetry(input.mode, targetDagId, tasks, replay.dag.tasks);
  const selectedTaskIds = replay.dag.tasks
    .map((dagTask, index) => selectedDagIds.has(dagTask.id) ? tasks[index]?.id : null)
    .filter((id): id is string => Boolean(id));
  if (selectedTaskIds.length === 0) throw new Error('No tasks selected for retry');

  const runningSelected = tasks.filter((task) => selectedTaskIds.includes(task.id) && task.status === 'running');
  if (runningSelected.length > 0) {
    throw new Error(`Cannot retry running tasks: ${runningSelected.map((task) => task.id).join(', ')}`);
  }

  const sliced = sliceDag(replay.dag, selectedDagIds);
  const placeholders = selectedTaskIds.map(() => '?').join(',');
  const now = Date.now();
  const normalizeSelected = db.prepare(
    `UPDATE tasks
        SET executor_hint = ?
      WHERE workflow_id = ? AND id = ?`,
  );
  for (const task of tasks) {
    if (!selectedTaskIds.includes(task.id)) continue;
    const normalized = normalizeCliExecutorHintForModel(task.kind, task.executor_hint, task.model);
    if (normalized !== (task.executor_hint ?? null)) {
      withSqliteRetrySync(() => normalizeSelected.run(normalized, workflowId, task.id));
    }
  }
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE tasks
        SET status = 'pending',
            started_at = NULL,
            completed_at = NULL,
            output_json = NULL,
            refine_feedback = NULL
      WHERE workflow_id = ?
        AND id IN (${placeholders})`,
    ).run(workflowId, ...selectedTaskIds),
  );
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE workflow_task_leases
        SET status = 'expired',
            released_at = ?
      WHERE workflow_id = ?
        AND task_id IN (${placeholders})
        AND status = 'running'`,
    ).run(now, workflowId, ...selectedTaskIds),
  );
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE workflows
        SET status = 'executing',
            completed_at = NULL
      WHERE id = ?`,
    ).run(workflowId),
  );

  backfillExecutionPlanInputsForRetry(db, workflowId, tasks, replay.dag, selectedDagIds);

  const baseObjective = input.objective?.trim() || workflow.objective;
  const composedObjective = handoffContext
    ? [
        '# Retry context — operator-selected handoff',
        `Handoff id: ${handoffContext.id}`,
        `Handoff title: ${handoffContext.title}`,
        '',
        '## Handoff body',
        handoffContext.body,
        '',
        '# Retry objective',
        baseObjective,
      ].join('\n')
    : baseObjective;

  insertEvent(db, {
    workflow_id: workflowId,
    task_id: taskId,
    type: 'dashboard_task_retry_started',
    payload: {
      mode: input.mode,
      selected_task_ids: selectedTaskIds,
      task_count: selectedTaskIds.length,
      objective: composedObjective,
      handoff_id: handoffContext?.id ?? null,
      cli_permission_mode: input.cli_permission_mode ?? null,
    },
  });

  return {
    source_workflow_id: workflowId,
    source_task_id: taskId,
    retry_scope: input.mode,
    workspace: workflow.workspace,
    objective: composedObjective,
    auto_approve: input.auto_approve,
    ...(input.cli_permission_mode ? { cli_permission_mode: input.cli_permission_mode } : {}),
    task_ids: selectedTaskIds,
    task_count: selectedTaskIds.length,
    omitted_dependencies: sliced.omitted_dependencies,
  };
}