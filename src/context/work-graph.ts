import type Database from 'better-sqlite3';
import { createWorkItem, type WorkItemRow } from './store.js';

export interface WorkflowWorkGraphTask {
  id: string;
  name: string;
  kind: string;
  dependsOn?: string[];
}

export interface EnsureWorkflowWorkGraphInput {
  workspace: string;
  runId: string;
  objective: string;
  tasks: WorkflowWorkGraphTask[];
}

function loadRunWorkItem(
  db: Database.Database,
  workspace: string,
  runId: string,
): WorkItemRow | null {
  const row = db.prepare(
    `SELECT *
       FROM work_items
      WHERE workspace = ?
        AND run_id = ?
        AND parent_id IS NULL
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
  ).get(workspace, runId) as WorkItemRow | undefined;
  return row ?? null;
}

function loadTaskWorkItem(
  db: Database.Database,
  runId: string,
  taskId: string,
): WorkItemRow | null {
  const row = db.prepare(
    `SELECT *
       FROM work_items
      WHERE run_id = ?
        AND task_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
  ).get(runId, taskId) as WorkItemRow | undefined;
  return row ?? null;
}

export function ensureWorkflowWorkGraph(
  db: Database.Database,
  input: EnsureWorkflowWorkGraphInput,
): { root: WorkItemRow; tasks: WorkItemRow[] } {
  const root = loadRunWorkItem(db, input.workspace, input.runId) ?? createWorkItem(db, {
    workspace: input.workspace,
    kind: 'batch',
    title: `Run ${input.runId}`,
    objective: input.objective,
    runId: input.runId,
    metadata: { source: 'workflow_context_adapter' },
  });

  const taskItems = input.tasks.map((task, index) =>
    loadTaskWorkItem(db, input.runId, task.id) ?? createWorkItem(db, {
      workspace: input.workspace,
      kind: 'task',
      title: task.name,
      objective: task.name,
      parentId: root.id,
      runId: input.runId,
      taskId: task.id,
      orderIndex: index,
      metadata: {
        executor_kind: task.kind,
        depends_on: task.dependsOn ?? [],
      },
    }),
  );

  return { root, tasks: taskItems };
}

export function safeEnsureWorkflowWorkGraph(
  db: Database.Database,
  input: EnsureWorkflowWorkGraphInput,
): void {
  try {
    ensureWorkflowWorkGraph(db, input);
  } catch {
    // Work graph capture must never block workflow execution.
  }
}
