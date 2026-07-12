/**
 * dashboard-data-tasks.ts
 *
 * Task queries for dashboard data layer.
 * Handles task card building, task-related data queries (model calls, events, trace spans, artifacts, subagent runs).
 *
 * Split from dashboard-data.ts (1054 LOC → ~300 LOC)
 */

import type Database from 'better-sqlite3';
import { durationMs, previewValue, safeJsonObject, taskMapKey } from './_json-utils.js';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface DashboardTaskCard {
  id: string;
  workflow_id: string;
  name: string;
  kind: string;
  status: TaskStatus | string;
  depends_on: string[];
  model: string | null;
  model_route: unknown;
  tool_name: string | null;
  executor_hint: string | null;
  acceptance_criteria: string | null;
  timeout_seconds: number | null;
  retry_count: number;
  refine_count: number;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  duration_ms: number | null;
  input_preview: string | null;
  output_preview: string | null;
  execution_context: DashboardExecutionContext | null;
  events: DashboardTaskEvent[];
  model_calls: DashboardTaskModelCall[];
  trace_spans: DashboardTraceSpan[];
  artifacts: DashboardArtifact[];
  subagent_runs: DashboardSubagentRun[];
  mailbox: DashboardMailboxEntry[];
}

export interface DashboardExecutionContext {
  workspace_root: string;
  run_root: string;
  project_root: string;
  cwd: string;
  output_dir: string;
  base_ref: string | null;
  source_project_root: string;
  source_cwd: string;
  worktree_root: string | null;
  worktree_branch: string | null;
  lineage: {
    lane: string;
    source: string;
    workspace: string;
    workflow_id: string;
    task_id: string;
  };
}

export interface DashboardTaskEvent {
  id: number;
  type: string;
  timestamp: number;
  payload_preview: string | null;
}

export interface DashboardTaskModelCall {
  id: string;
  model: string;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  source: string;
  created_at: number;
}

export interface DashboardTraceSpan {
  id: string;
  name: string;
  kind: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

export interface DashboardArtifact {
  id: string;
  kind: string;
  content_path: string | null;
  size_bytes: number | null;
  created_at: number;
}

export interface DashboardSubagentRun {
  run_id: string;
  parent_run_id: string | null;
  depth: number;
  model: string | null;
  task_text_preview: string;
  status: string;
  result_preview: string | null;
  error_msg: string | null;
  cleanup: string;
  spawn_mode: string;
  timeout_seconds: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface DashboardMailboxEntry {
  id: string;
  direction: 'inbox' | 'outbox';
  message_type: string;
  scope: 'direct' | 'broadcast';
  status: string;
  counterpart_task_id: string | null;
  delivery_count: number;
  created_at: number;
  delivered_at: number | null;
  payload_preview: string | null;
}

interface TaskRow {
  id: string;
  workflow_id: string;
  name: string;
  kind: string;
  input_json: string | null;
  output_json: string | null;
  status: string;
  depends_on_json: string | null;
  executor_hint: string | null;
  acceptance_criteria: string | null;
  timeout_seconds: number | null;
  model: string | null;
  tool_name: string | null;
  retry_count: number | null;
  refine_count: number | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
}

interface ModelCallDetailRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  model: string;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  source: string;
  created_at: number;
}

interface TraceSpanDetailRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  name: string;
  kind: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
}

interface ArtifactDetailRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  kind: string;
  content_path: string | null;
  size_bytes: number | null;
  created_at: number;
}

interface SubagentRunDetailRow {
  run_id: string;
  task_id: string;
  workflow_id: string;
  parent_run_id: string | null;
  depth: number;
  model: string | null;
  task_text: string;
  status: string;
  result_text: string | null;
  error_msg: string | null;
  cleanup: string;
  spawn_mode: string;
  timeout_seconds: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'running',
  'waiting',
  'completed',
  'failed',
  'skipped',
];

function emptyTaskColumns(): Record<TaskStatus, DashboardTaskCard[]> {
  return TASK_STATUSES.reduce((acc, status) => {
    acc[status] = [];
    return acc;
  }, {} as Record<TaskStatus, DashboardTaskCard[]>);
}

function toolNameFromInput(raw: string | null, fallback: string | null): string | null {
  if (fallback) return fallback;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)['tool_name'];
      return typeof value === 'string' && value.length > 0 ? value : null;
    }
  } catch {
    return null;
  }
  return null;
}

function parseDependsOn(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function taskCard(row: TaskRow, now: number): DashboardTaskCard {
  const input = safeJsonObject(row.input_json);
  const executionContext = input['execution_context'];
  return {
    id: row.id,
    workflow_id: row.workflow_id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    depends_on: parseDependsOn(row.depends_on_json),
    model: row.model,
    model_route: input['model_route'] ?? null,
    tool_name: toolNameFromInput(row.input_json, row.tool_name),
    executor_hint: row.executor_hint,
    acceptance_criteria: row.acceptance_criteria,
    timeout_seconds: row.timeout_seconds,
    retry_count: row.retry_count ?? 0,
    refine_count: row.refine_count ?? 0,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    duration_ms: durationMs(row.started_at, row.completed_at, now),
    input_preview: previewValue(row.input_json),
    output_preview: previewValue(row.output_json),
    execution_context:
      executionContext && typeof executionContext === 'object' && !Array.isArray(executionContext)
        ? executionContext as DashboardExecutionContext
        : null,
    events: [],
    model_calls: [],
    trace_spans: [],
    artifacts: [],
    subagent_runs: [],
    mailbox: [],
  };
}

/**
 * Query task rows from database for given workflow IDs
 */
export function queryTasks(
  db: Database.Database,
  workflowIds: string[],
): { tasksByWorkflow: Map<string, DashboardTaskCard[]>; tasksById: Map<string, DashboardTaskCard> } {
  const now = Date.now();
  const tasksByWorkflow = new Map<string, DashboardTaskCard[]>();
  const tasksById = new Map<string, DashboardTaskCard>();

  if (workflowIds.length === 0) return { tasksByWorkflow, tasksById };

  const placeholders = workflowIds.map(() => '?').join(',');
  const taskRows = db.prepare(
    `SELECT id, workflow_id, name, kind, input_json, output_json, status, depends_on_json,
            executor_hint, acceptance_criteria, timeout_seconds, model, tool_name,
            retry_count, refine_count, started_at, completed_at, created_at
     FROM tasks
     WHERE workflow_id IN (${placeholders})
     ORDER BY created_at ASC`,
  ).all(...workflowIds) as TaskRow[];

  for (const row of taskRows) {
    const list = tasksByWorkflow.get(row.workflow_id) ?? [];
    const card = taskCard(row, now);
    list.push(card);
    tasksById.set(`${card.workflow_id}::${card.id}`, card);
    tasksByWorkflow.set(row.workflow_id, list);
  }

  return { tasksByWorkflow, tasksById };
}

/**
 * Shared skeleton for the queryAndAttach* helpers below: SELECT detail rows
 * for the given workflow IDs, look the owning task card up in tasksById and
 * push the mapped row into one of the card's detail arrays.
 */
function attachRowsToTasks<Row extends { workflow_id: string; task_id: string | null }, Item>(
  db: Database.Database,
  buildSql: (placeholders: string) => string,
  workflowIds: string[],
  tasksById: Map<string, DashboardTaskCard>,
  getTarget: (task: DashboardTaskCard) => Item[],
  mapRow: (row: Row) => Item,
): void {
  if (workflowIds.length === 0) return;
  const placeholders = workflowIds.map(() => '?').join(',');
  const rows = db.prepare(buildSql(placeholders)).all(...workflowIds) as Row[];
  for (const row of rows) {
    const key = taskMapKey(row.workflow_id, row.task_id);
    if (!key) continue;
    const task = tasksById.get(key);
    if (!task) continue;
    getTarget(task).push(mapRow(row));
  }
}

/**
 * Query model calls and attach to task cards
 */
export function queryAndAttachModelCalls(
  db: Database.Database,
  workflowIds: string[],
  tasksById: Map<string, DashboardTaskCard>,
): void {
  attachRowsToTasks<ModelCallDetailRow, DashboardTaskModelCall>(
    db,
    (placeholders) =>
      `SELECT id, workflow_id, task_id, model, provider, input_tokens, output_tokens,
              cost_usd, latency_ms, source, created_at
       FROM model_calls
       WHERE workflow_id IN (${placeholders})
       ORDER BY created_at ASC`,
    workflowIds,
    tasksById,
    (task) => task.model_calls,
    (row) => ({
      id: row.id,
      model: row.model,
      provider: row.provider,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cost_usd: row.cost_usd,
      latency_ms: row.latency_ms,
      source: row.source,
      created_at: row.created_at,
    }),
  );
}

/**
 * Query trace spans and attach to task cards
 */
export function queryAndAttachTraceSpans(
  db: Database.Database,
  workflowIds: string[],
  tasksById: Map<string, DashboardTaskCard>,
): void {
  attachRowsToTasks<TraceSpanDetailRow, DashboardTraceSpan>(
    db,
    (placeholders) =>
      `SELECT id, workflow_id, task_id, name, kind, status, started_at, ended_at, duration_ms
       FROM trace_spans
       WHERE workflow_id IN (${placeholders})
       ORDER BY started_at ASC`,
    workflowIds,
    tasksById,
    (task) => task.trace_spans,
    (row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      status: row.status,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.duration_ms,
    }),
  );
}

/**
 * Query artifacts and attach to task cards
 */
export function queryAndAttachArtifacts(
  db: Database.Database,
  workflowIds: string[],
  tasksById: Map<string, DashboardTaskCard>,
): void {
  attachRowsToTasks<ArtifactDetailRow, DashboardArtifact>(
    db,
    (placeholders) =>
      `SELECT id, workflow_id, task_id, kind, content_path, size_bytes, created_at
       FROM artifacts
       WHERE workflow_id IN (${placeholders})
       ORDER BY created_at ASC`,
    workflowIds,
    tasksById,
    (task) => task.artifacts,
    (row) => ({
      id: row.id,
      kind: row.kind,
      content_path: row.content_path,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
    }),
  );
}

/**
 * Query subagent runs and attach to task cards
 */
export function queryAndAttachSubagentRuns(
  db: Database.Database,
  workflowIds: string[],
  tasksById: Map<string, DashboardTaskCard>,
): void {
  attachRowsToTasks<SubagentRunDetailRow, DashboardSubagentRun>(
    db,
    (placeholders) =>
      `SELECT run_id, task_id, workflow_id, parent_run_id, depth, model, task_text, status,
              result_text, error_msg, cleanup, spawn_mode, timeout_seconds,
              created_at, started_at, ended_at
       FROM subagent_runs
       WHERE workflow_id IN (${placeholders})
       ORDER BY created_at ASC`,
    workflowIds,
    tasksById,
    (task) => task.subagent_runs,
    (row) => ({
      run_id: row.run_id,
      parent_run_id: row.parent_run_id,
      depth: row.depth,
      model: row.model,
      task_text_preview: previewValue(row.task_text, 500) ?? '',
      status: row.status,
      result_preview: previewValue(row.result_text, 500),
      error_msg: row.error_msg,
      cleanup: row.cleanup,
      spawn_mode: row.spawn_mode,
      timeout_seconds: row.timeout_seconds,
      created_at: row.created_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
    }),
  );
}

/**
 * Sort and limit task-related arrays (subagent_runs, mailbox)
 */
export function sortAndLimitTaskArrays(tasksById: Map<string, DashboardTaskCard>): void {
  for (const task of tasksById.values()) {
    task.subagent_runs.sort((a, b) => b.created_at - a.created_at);
    task.mailbox.sort((a, b) => b.created_at - a.created_at);
    task.mailbox = task.mailbox.slice(0, 16);
  }
}

/**
 * Group task cards by status for kanban view
 */
export function groupTasksByStatus(
  tasks: DashboardTaskCard[],
): Record<TaskStatus, DashboardTaskCard[]> {
  const columns = emptyTaskColumns();
  for (const task of tasks) {
    if (task.status in columns) {
      columns[task.status as TaskStatus].push(task);
    }
  }
  return columns;
}