/**
 * dashboard-data-workflows.ts
 *
 * Workflow queries for dashboard data layer.
 * Handles workflow card building, workflow filtering, and workflow-related statistics.
 *
 * Split from dashboard-data.ts (1054 LOC → ~250 LOC)
 */

import type Database from 'better-sqlite3';
import { workspaceProfileFromRow, type WorkspaceProfile } from '../utils/workspace-profile.js';
import { durationMs } from './_json-utils.js';

export type WorkflowStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DashboardWorkflowCard {
  id: string;
  workspace: string;
  objective: string;
  display_name: string | null;
  archived_at: number | null;
  status: WorkflowStatus | string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  task_total: number;
  progress_pct: number;
  task_counts: Record<string, number>;
  model_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  model_call_count: number;
  latest_event_type: string | null;
  latest_event_at: number | null;
  latest_error: {
    event_id: number;
    type: string;
    message: string;
    payload_preview: string | null;
    timestamp: number;
  } | null;
}

export interface DashboardWorkspaceProfile extends WorkspaceProfile {}

interface WorkflowRow {
  id: string;
  workspace: string;
  objective: string;
  display_name: string | null;
  archived_at: number | null;
  status: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

interface ModelTotalsRow {
  workflow_id: string;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  call_count: number;
}

interface LatestEventRow {
  workflow_id: string;
  type: string;
  timestamp: number;
}

const WORKFLOW_STATUSES: WorkflowStatus[] = [
  'pending',
  'approved',
  'executing',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

function emptyWorkflowColumns(): Record<WorkflowStatus, DashboardWorkflowCard[]> {
  return WORKFLOW_STATUSES.reduce((acc, status) => {
    acc[status] = [];
    return acc;
  }, {} as Record<WorkflowStatus, DashboardWorkflowCard[]>);
}

function countByStatus(tasks: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Query workflow rows from database with optional workspace filter
 */
export function queryWorkflows(
  db: Database.Database,
  workspaceFilter: string | null,
  limit: number,
): WorkflowRow[] {
  return db.prepare(
    `SELECT w.id, w.workspace, w.objective, o.display_name, o.archived_at,
            w.status, w.created_at, w.started_at, w.completed_at
       FROM workflows w
       LEFT JOIN dashboard_workflow_overrides o ON o.workflow_id = w.id
      WHERE w.id != '_daemon'
        AND (? IS NULL OR w.workspace = ?)
        AND COALESCE(o.deleted_at, 0) = 0
      ORDER BY w.created_at DESC
      LIMIT ?`,
  ).all(workspaceFilter, workspaceFilter, limit) as WorkflowRow[];
}

/**
 * Query model totals (cost, tokens, call count) for workflows
 */
export function queryModelTotals(
  db: Database.Database,
  workflowIds: string[],
): Map<string, ModelTotalsRow> {
  if (workflowIds.length === 0) return new Map();
  const placeholders = workflowIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT workflow_id,
            SUM(COALESCE(cost_usd, 0)) AS cost_usd,
            SUM(COALESCE(input_tokens, 0)) AS input_tokens,
            SUM(COALESCE(output_tokens, 0)) AS output_tokens,
            COUNT(*) AS call_count
     FROM model_calls
     WHERE workflow_id IN (${placeholders})
     GROUP BY workflow_id`,
  ).all(...workflowIds) as ModelTotalsRow[];
  const map = new Map<string, ModelTotalsRow>();
  for (const row of rows) map.set(row.workflow_id, row);
  return map;
}

/**
 * Query latest event for each workflow
 */
export function queryLatestEvents(
  db: Database.Database,
  workflowIds: string[],
): Map<string, LatestEventRow> {
  if (workflowIds.length === 0) return new Map();
  const placeholders = workflowIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT e.workflow_id, e.type, e.timestamp
     FROM events e
     JOIN (
       SELECT workflow_id, MAX(id) AS max_id
       FROM events
       WHERE workflow_id IN (${placeholders})
       GROUP BY workflow_id
     ) latest ON latest.max_id = e.id`,
  ).all(...workflowIds) as LatestEventRow[];
  const map = new Map<string, LatestEventRow>();
  for (const row of rows) map.set(row.workflow_id, row);
  return map;
}

/**
 * Query all workspace names from various sources
 */
export function queryWorkspaces(db: Database.Database): string[] {
  const rows = db.prepare(
    `SELECT name AS workspace FROM dashboard_workspaces
     UNION
     SELECT DISTINCT workspace FROM workflows
     UNION
     SELECT DISTINCT workspace FROM patterns
     UNION
     SELECT DISTINCT workspace FROM eval_cases
     UNION
     SELECT DISTINCT workspace FROM eval_runs
     ORDER BY workspace ASC`,
  ).all() as Array<{ workspace: string }>;
  return rows.map((row) => row.workspace);
}

/**
 * Query workspace profiles
 */
export function queryWorkspaceProfiles(db: Database.Database): DashboardWorkspaceProfile[] {
  const rows = db.prepare(
    `SELECT name AS workspace, metadata_json
       FROM dashboard_workspaces
      ORDER BY name ASC`,
  ).all() as Array<{ workspace: string; metadata_json: string | null }>;
  return rows.map((row) => workspaceProfileFromRow(row));
}

/**
 * Build workflow cards from rows with associated data
 */
export function buildWorkflowCards(
  workflows: WorkflowRow[],
  tasksByWorkflow: Map<string, Array<{ status: string }>>,
  modelTotals: Map<string, ModelTotalsRow>,
  latestEvents: Map<string, LatestEventRow>,
  latestErrors: Map<string, DashboardWorkflowCard['latest_error']>,
  now: number,
): DashboardWorkflowCard[] {
  return workflows.map((workflow): DashboardWorkflowCard => {
    const tasks = tasksByWorkflow.get(workflow.id) ?? [];
    const counts = countByStatus(tasks);
    const completed = counts.completed ?? 0;
    const total = tasks.length;
    const totals = modelTotals.get(workflow.id);
    const latest = latestEvents.get(workflow.id);
    return {
      id: workflow.id,
      workspace: workflow.workspace,
      objective: workflow.objective,
      display_name: workflow.display_name,
      archived_at: workflow.archived_at,
      status: workflow.status,
      created_at: workflow.created_at,
      started_at: workflow.started_at,
      completed_at: workflow.completed_at,
      duration_ms: durationMs(workflow.started_at, workflow.completed_at, now),
      task_total: total,
      progress_pct: total === 0 ? 0 : Math.round((completed / total) * 100),
      task_counts: counts,
      model_cost_usd: roundMoney(totals?.cost_usd ?? 0),
      input_tokens: totals?.input_tokens ?? 0,
      output_tokens: totals?.output_tokens ?? 0,
      model_call_count: totals?.call_count ?? 0,
      latest_event_type: latest?.type ?? null,
      latest_event_at: latest?.timestamp ?? null,
      latest_error: latestErrors.get(workflow.id) ?? null,
    };
  });
}

/**
 * Group workflow cards by status for kanban view
 */
export function groupWorkflowsByStatus(
  workflows: DashboardWorkflowCard[],
): Record<WorkflowStatus, DashboardWorkflowCard[]> {
  const columns = emptyWorkflowColumns();
  for (const workflow of workflows) {
    if (workflow.status in columns) {
      columns[workflow.status as WorkflowStatus].push(workflow);
    }
  }
  return columns;
}