/**
 * dashboard-data-stats.ts
 *
 * Statistics queries for dashboard data layer.
 * Handles summary statistics, eval runs, and aggregated metrics.
 *
 * Split from dashboard-data.ts (1054 LOC → ~150 LOC)
 */

import type Database from 'better-sqlite3';
import type { DashboardWorkflowCard } from './dashboard-data-workflows.js';
import type { DashboardTaskCard } from './dashboard-data-tasks.js';

export interface DashboardSummary {
  workflow_count: number;
  active_workflow_count: number;
  completed_workflow_count: number;
  failed_workflow_count: number;
  task_count: number;
  completed_task_count: number;
  failed_task_count: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  model_call_count: number;
}

export interface DashboardEvalRun {
  id: string;
  workspace: string;
  suite_name: string;
  status: string;
  score: number;
  case_count: number;
  created_at: number;
  completed_at: number | null;
}

/**
 * Calculate summary statistics from workflow cards
 */
export function calculateSummary(
  workflows: DashboardWorkflowCard[],
  allTasks: DashboardTaskCard[],
): DashboardSummary {
  return {
    workflow_count: workflows.length,
    active_workflow_count: workflows.filter((workflow) =>
      !['completed', 'failed', 'cancelled'].includes(workflow.status),
    ).length,
    completed_workflow_count: workflows.filter((workflow) => workflow.status === 'completed').length,
    failed_workflow_count: workflows.filter((workflow) => workflow.status === 'failed').length,
    task_count: allTasks.length,
    completed_task_count: allTasks.filter((task) => task.status === 'completed').length,
    failed_task_count: allTasks.filter((task) => task.status === 'failed').length,
    total_cost_usd: workflows.reduce((sum, workflow) => sum + workflow.model_cost_usd, 0),
    total_input_tokens: workflows.reduce((sum, workflow) => sum + workflow.input_tokens, 0),
    total_output_tokens: workflows.reduce((sum, workflow) => sum + workflow.output_tokens, 0),
    model_call_count: workflows.reduce((sum, workflow) => sum + workflow.model_call_count, 0),
  };
}

/**
 * Query recent eval runs with optional workspace filter
 */
export function queryRecentEvalRuns(
  db: Database.Database,
  workspaceFilter: string | null,
): DashboardEvalRun[] {
  return db.prepare(
    `SELECT id, workspace, suite_name, status, score, case_count, created_at, completed_at
     FROM eval_runs
     WHERE (? IS NULL OR workspace = ?)
     ORDER BY created_at DESC
     LIMIT 8`,
  ).all(workspaceFilter, workspaceFilter) as DashboardEvalRun[];
}