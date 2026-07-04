import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  loadWorkflowById,
  loadWorkflowTasks,
} from '../db/persist.js';
import {
  countActiveRunsForTask,
} from '../v2/subagent/registry.js';
import {
  kill,
  steer,
} from '../v2/subagent/control.js';

const DashboardSubagentSteerSchema = z.object({
  instruction: z.string().trim().min(1).max(8_000),
});

const DashboardSubagentKillSchema = z.object({
  reason: z.string().trim().min(1).max(4_000).optional(),
});

function taskById(db: Database.Database, workflowId: string, taskId: string) {
  const task = loadWorkflowTasks(db, workflowId).find((item) => item.id === taskId);
  if (!task) throw new Error(`Task not found in workflow: ${taskId}`);
  return task;
}

function hasSubagentSurface(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  executionMode?: string,
): boolean {
  if (executionMode === 'adaptive') return true;
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
       FROM subagent_runs
      WHERE workflow_id = ? AND task_id = ?`,
  ).get(workflowId, taskId) as { cnt: number };
  return row.cnt > 0;
}

export function steerDashboardSubagents(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  raw: unknown,
): {
  workflow_id: string;
  task_id: string;
  steer_status: 'accepted' | 'already_done';
  active_runs: number;
  task_status: string;
  steer_instruction: string | null;
} {
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const task = taskById(db, workflowId, taskId);
  if (!hasSubagentSurface(db, workflowId, taskId, task.execution_mode)) {
    throw new Error(`Task has no subagent console surface: ${taskId}`);
  }

  const input = DashboardSubagentSteerSchema.parse(raw);
  const result = steer(db, taskId, input.instruction);
  if (result === 'not_found') throw new Error(`Task not found: ${taskId}`);

  const reloaded = taskById(db, workflowId, taskId);
  return {
    workflow_id: workflowId,
    task_id: taskId,
    steer_status: result,
    active_runs: countActiveRunsForTask(db, taskId),
    task_status: reloaded.status,
    steer_instruction: reloaded.steer_instruction ?? null,
  };
}

export function killDashboardSubagents(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  raw: unknown = {},
): {
  workflow_id: string;
  task_id: string;
  kill_status: 'killed' | 'already_done';
  active_runs: number;
  task_status: string;
} {
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const task = taskById(db, workflowId, taskId);
  if (!hasSubagentSurface(db, workflowId, taskId, task.execution_mode)) {
    throw new Error(`Task has no subagent console surface: ${taskId}`);
  }

  const input = DashboardSubagentKillSchema.parse(raw);
  const result = kill(
    db,
    taskId,
    input.reason?.trim() || 'Killed from dashboard subagent console',
  );
  if (result === 'not_found') throw new Error(`Task not found: ${taskId}`);

  const reloaded = taskById(db, workflowId, taskId);
  return {
    workflow_id: workflowId,
    task_id: taskId,
    kill_status: result,
    active_runs: countActiveRunsForTask(db, taskId),
    task_status: reloaded.status,
  };
}
