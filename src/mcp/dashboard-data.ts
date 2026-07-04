/**
 * dashboard-data.ts
 *
 * Main orchestrator for dashboard data layer.
 * Splits responsibilities into focused modules:
 * - dashboard-data-workflows.ts: workflow queries and cards
 * - dashboard-data-tasks.ts: task queries and cards
 * - dashboard-data-stats.ts: statistics and eval runs
 * - dashboard-data-audit.ts: events, subagent messages, gates
 *
 * Original: 1054 LOC → Split: ~150 LOC (orchestrator only)
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';

// Re-export types from split modules for backward compatibility
export type { WorkflowStatus, DashboardWorkflowCard } from './dashboard-data-workflows.js';
export type { TaskStatus, DashboardTaskCard, DashboardExecutionContext, DashboardTaskEvent, DashboardTaskModelCall, DashboardTraceSpan, DashboardArtifact, DashboardSubagentRun, DashboardMailboxEntry } from './dashboard-data-tasks.js';
export type { DashboardSummary, DashboardEvalRun } from './dashboard-data-stats.js';
export type { DashboardTimelineEvent, DashboardPendingGate } from './dashboard-data-audit.js';
export type { DashboardWorkspaceProfile } from './dashboard-data-workflows.js';

// Import query functions from split modules
import {
  queryWorkflows,
  queryModelTotals,
  queryLatestEvents,
  queryWorkspaces,
  queryWorkspaceProfiles,
  buildWorkflowCards,
  groupWorkflowsByStatus,
  type DashboardWorkflowCard as WorkflowCard,
  type WorkflowStatus,
  type DashboardWorkspaceProfile,
} from './dashboard-data-workflows.js';

import {
  queryTasks,
  queryAndAttachModelCalls,
  queryAndAttachTraceSpans,
  queryAndAttachArtifacts,
  queryAndAttachSubagentRuns,
  sortAndLimitTaskArrays,
  groupTasksByStatus,
  type DashboardTaskCard as TaskCard,
  type TaskStatus,
} from './dashboard-data-tasks.js';

import {
  calculateSummary,
  queryRecentEvalRuns,
  type DashboardSummary,
  type DashboardEvalRun,
} from './dashboard-data-stats.js';

import {
  queryEventsAndBuildTimeline,
  querySubagentMessages,
  queryPendingGates,
  type DashboardTimelineEvent,
  type DashboardPendingGate,
} from './dashboard-data-audit.js';

const SnapshotOptionsSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE).optional(),
  limit: z.number().int().min(1).max(100).optional().default(40),
});

export interface DashboardSnapshot {
  generated_at: number;
  filters: {
    workspace: string | null;
    limit: number;
  };
  workspaces: string[];
  workspace_profiles: DashboardWorkspaceProfile[];
  summary: DashboardSummary;
  workflows: WorkflowCard[];
  kanban: {
    workflows: Record<WorkflowStatus, WorkflowCard[]>;
    tasks: Record<string, Record<TaskStatus, TaskCard[]>>;
  };
  timelines: Record<string, DashboardTimelineEvent[]>;
  pending_gates: DashboardPendingGate[];
  recent_eval_runs: DashboardEvalRun[];
}

/**
 * Build complete dashboard snapshot by orchestrating split modules
 */
export function buildDashboardSnapshot(
  db: Database.Database,
  rawOptions: z.input<typeof SnapshotOptionsSchema> = {},
): DashboardSnapshot {
  const options = SnapshotOptionsSchema.parse(rawOptions);
  const now = Date.now();
  const workspaceFilter = options.workspace ?? null;

  // Query workflows
  const workflows = queryWorkflows(db, workspaceFilter, options.limit);
  const workflowIds = workflows.map((w) => w.id);

  // Query tasks
  const { tasksByWorkflow, tasksById } = queryTasks(db, workflowIds);

  // Query workflow-related data
  const modelTotals = queryModelTotals(db, workflowIds);
  const latestEvents = queryLatestEvents(db, workflowIds);

  // Attach task-related data
  queryAndAttachModelCalls(db, workflowIds, tasksById);
  queryAndAttachTraceSpans(db, workflowIds, tasksById);
  queryAndAttachArtifacts(db, workflowIds, tasksById);
  queryAndAttachSubagentRuns(db, workflowIds, tasksById);

  // Query audit data (events, subagent messages, gates)
  const { timelines, latestErrors } = queryEventsAndBuildTimeline(db, workflowIds, tasksById);
  querySubagentMessages(db, workflowIds, tasksById);
  const pendingGates = queryPendingGates(db, workflowIds);

  // Sort and limit task arrays
  sortAndLimitTaskArrays(tasksById);

  // Build workflow cards
  const workflowCards = buildWorkflowCards(
    workflows,
    tasksByWorkflow,
    modelTotals,
    latestEvents,
    latestErrors,
    now,
  );

  // Group workflows and tasks by status for kanban view
  const workflowColumns = groupWorkflowsByStatus(workflowCards);
  const taskColumnsByWorkflow: Record<string, Record<TaskStatus, TaskCard[]>> = {};
  for (const workflow of workflowCards) {
    const tasks = tasksByWorkflow.get(workflow.id) ?? [];
    taskColumnsByWorkflow[workflow.id] = groupTasksByStatus(tasks);
  }

  // Query workspaces and profiles
  const workspaces = queryWorkspaces(db);
  const workspaceProfiles = queryWorkspaceProfiles(db);

  // Calculate summary statistics
  const allTasks = [...tasksByWorkflow.values()].flat();
  const summary = calculateSummary(workflowCards, allTasks);

  // Query recent eval runs
  const recentEvalRuns = queryRecentEvalRuns(db, workspaceFilter);

  return {
    generated_at: now,
    filters: {
      workspace: workspaceFilter,
      limit: options.limit,
    },
    workspaces,
    workspace_profiles: workspaces.map((ws) => {
      const profile = workspaceProfiles.find((p) => p.workspace === ws);
      return profile ?? { workspace: ws, software_target: null };
    }),
    summary,
    workflows: workflowCards,
    kanban: {
      workflows: workflowColumns,
      tasks: taskColumnsByWorkflow,
    },
    timelines: Object.fromEntries(timelines.entries()),
    pending_gates: pendingGates,
    recent_eval_runs: recentEvalRuns,
  };
}
