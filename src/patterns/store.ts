import type Database from 'better-sqlite3';
import type { DagTask, Pattern, Task } from '../types/index.js';
import {
  insertPattern,
  loadPatternById,
  loadPatternByName,
  listPatternsByWorkspace,
  deletePatternById,
  bumpPatternUsage,
  loadWorkflowById,
  loadWorkflowTasks,
} from '../db/persist.js';

export { bumpPatternUsage };

// Converts DB tasks back to a portable DAG using task names as stable IDs.
// Assumes task names are unique within the workflow (decomposer should guarantee this).
function tasksToPatternDag(tasks: Task[]): DagTask[] {
  const nameById = new Map(tasks.map((t) => [t.id, t.name]));
  return tasks.map((t) => ({
    id: t.name,
    name: t.name,
    kind: t.kind,
    depends_on: t.depends_on.map((dep) => nameById.get(dep) ?? dep),
    ...(t.executor_hint ? { executor_hint: t.executor_hint } : {}),
    ...(t.acceptance_criteria ? { acceptance_criteria: t.acceptance_criteria } : {}),
    ...(t.model ? { model: t.model } : {}),
  }));
}

export function saveWorkflowAsPattern(
  db: Database.Database,
  workflowId: string,
  name: string,
): Pattern {
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  if (workflow.status !== 'completed') {
    throw new Error(
      `Workflow ${workflowId} is '${workflow.status}' — only completed workflows can be saved as patterns`,
    );
  }

  const tasks = loadWorkflowTasks(db, workflowId);
  const dag = { tasks: tasksToPatternDag(tasks) };

  const pattern: Pattern = {
    id: `pt_${crypto.randomUUID()}`,
    workspace: workflow.workspace,
    name,
    source: 'generated',
    objective_sample: workflow.objective,
    dag_json: JSON.stringify(dag),
    usage_count: 0,
    success_count: 0,
    avg_duration_ms: null,
    last_used_at: null,
    created_at: Date.now(),
  };

  insertPattern(db, pattern);
  return pattern;
}

export function loadPattern(db: Database.Database, id: string): Pattern | null {
  return loadPatternById(db, id);
}

export function getPatternByName(
  db: Database.Database,
  workspace: string,
  name: string,
): Pattern | null {
  return loadPatternByName(db, workspace, name);
}

export function listPatterns(db: Database.Database, workspace: string): Pattern[] {
  return listPatternsByWorkspace(db, workspace);
}

export function deletePattern(db: Database.Database, id: string): boolean {
  return deletePatternById(db, id);
}
