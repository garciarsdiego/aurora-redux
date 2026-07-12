import type Database from 'better-sqlite3';
import { load as yamlLoad } from 'js-yaml';
import { z } from 'zod';
import { DagSchema } from '../types/schemas.js';
import type { Dag, DagTask, Pattern, Task } from '../types/index.js';
import { validateDag } from '../brain/dag-validator.js';
import {
  insertPattern,
  listPatternsByWorkspace,
  loadPatternById,
  loadWorkflowById,
  loadWorkflowTasks,
} from '../db/persist.js';
import { normalizeCliExecutorHintForModel } from '../utils/cli-routing.js';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';
import { safeJsonObject } from './_json-utils.js';

export const ImportDashboardDagSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  name: z.string().min(1).max(120),
  objective_sample: z.string().optional().default(''),
  source: z.string().min(1).optional(),
  dag: z.unknown().optional(),
}).refine((value) => value.source !== undefined || value.dag !== undefined, {
  message: 'source or dag is required',
});

export const ListDashboardDagsSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE).optional(),
  limit: z.number().int().min(1).max(200).optional().default(80),
});

export interface DashboardDagLibraryItem {
  id: string;
  workspace: string;
  name: string;
  source: string;
  objective_sample: string;
  task_count: number;
  kinds: string[];
  usage_count: number;
  success_count: number;
  last_used_at: number | null;
  created_at: number;
  dag: Dag;
}

export interface ReconstructedWorkflowDag {
  workflow_id: string;
  workspace: string;
  objective: string;
  dag: Dag;
}

function normalizeDagRouting(dag: Dag): Dag {
  return {
    ...dag,
    tasks: dag.tasks.map((task) => {
      const executor_hint = normalizeCliExecutorHintForModel(
        task.kind,
        task.executor_hint,
        task.model,
      );
      return {
        ...task,
        ...(executor_hint ? { executor_hint } : { executor_hint: null }),
      };
    }),
  };
}

function parseRawDag(value: unknown): Dag {
  const parsed = DagSchema.safeParse(value);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid DAG: ${msg}`);
  }
  const dag = normalizeDagRouting(parsed.data);
  const validation = validateDag(dag);
  const graphErrors = validation.issues.filter(
    (issue) => issue.severity === 'error' && issue.rule === 'graph-integrity',
  );
  if (graphErrors.length > 0) {
    const msg = graphErrors
      .map((issue) => `${issue.rule}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid DAG: ${msg}`);
  }
  return dag;
}

export function validateDashboardDag(value: unknown): Dag {
  return parseRawDag(value);
}

export function parseDashboardDag(source: string): Dag {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    parsed = yamlLoad(source);
  }
  return parseRawDag(parsed);
}

function dagFromInput(input: z.infer<typeof ImportDashboardDagSchema>): Dag {
  if (input.source !== undefined) return parseDashboardDag(input.source);
  return parseRawDag(input.dag);
}

function patternToLibraryItem(pattern: Pattern): DashboardDagLibraryItem {
  const dag = parseRawDag(JSON.parse(pattern.dag_json) as unknown);
  const kinds = [...new Set(dag.tasks.map((task) => task.kind))].sort();
  return {
    id: pattern.id,
    workspace: pattern.workspace,
    name: pattern.name,
    source: pattern.source,
    objective_sample: pattern.objective_sample,
    task_count: dag.tasks.length,
    kinds,
    usage_count: pattern.usage_count,
    success_count: pattern.success_count,
    last_used_at: pattern.last_used_at,
    created_at: pattern.created_at,
    dag,
  };
}

export function importDashboardDag(
  db: Database.Database,
  raw: unknown,
): Pattern {
  const input = ImportDashboardDagSchema.parse(raw);
  const dag = dagFromInput(input);
  const pattern: Pattern = {
    id: `pt_${crypto.randomUUID()}`,
    workspace: input.workspace,
    name: input.name,
    source: 'imported',
    objective_sample: input.objective_sample,
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

export function listDashboardDags(
  db: Database.Database,
  raw: z.input<typeof ListDashboardDagsSchema> = {},
): DashboardDagLibraryItem[] {
  const input = ListDashboardDagsSchema.parse(raw);
  const patterns = input.workspace
    ? listPatternsByWorkspace(db, input.workspace)
    : db.prepare(`SELECT * FROM patterns ORDER BY created_at DESC LIMIT ?`).all(input.limit) as Pattern[];
  return patterns.slice(0, input.limit).map(patternToLibraryItem);
}

export function loadDashboardDagByPatternId(db: Database.Database, patternId: string): DashboardDagLibraryItem {
  const pattern = loadPatternById(db, patternId);
  if (!pattern) throw new Error(`Pattern not found: ${patternId}`);
  return patternToLibraryItem(pattern);
}

function reconstructDagTask(task: Task, index: number, idByTaskId: Map<string, string>): DagTask {
  const input = safeJsonObject(task.input_json);
  const taskId = idByTaskId.get(task.id) ?? `t${index}`;
  const toolName = task.tool_name ?? (typeof input['tool_name'] === 'string' ? input['tool_name'] : undefined);
  const dagTask: DagTask = {
    id: taskId,
    name: task.name,
    kind: task.kind,
    depends_on: task.depends_on.map((dep) => idByTaskId.get(dep) ?? dep),
    ...(task.executor_hint ? { executor_hint: task.executor_hint } : {}),
    ...(task.acceptance_criteria ? { acceptance_criteria: task.acceptance_criteria } : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(input['args'] !== undefined ? { args: input['args'] as Record<string, unknown> } : {}),
    ...(input['model_route'] !== undefined ? { model_route: input['model_route'] as DagTask['model_route'] } : {}),
    ...(input['input_selectors'] !== undefined ? { input_selectors: input['input_selectors'] as DagTask['input_selectors'] } : {}),
    ...(input['output_summary'] !== undefined ? { output_summary: input['output_summary'] as string } : {}),
    ...(input['tool_policy'] !== undefined ? { tool_policy: input['tool_policy'] } : {}),
    ...(task.timeout_seconds ? { timeout_seconds: task.timeout_seconds } : {}),
    ...(task.execution_mode && task.execution_mode !== 'ephemeral' ? { execution_mode: task.execution_mode } : {}),
  };
  return dagTask;
}

export function reconstructWorkflowDag(db: Database.Database, workflowId: string): ReconstructedWorkflowDag {
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
  const tasks = loadWorkflowTasks(db, workflowId);
  if (tasks.length === 0) throw new Error(`Workflow has no tasks: ${workflowId}`);
  const idByTaskId = new Map(tasks.map((task, index) => [task.id, `t${index}`]));
  const dag: Dag = {
    tasks: tasks.map((task, index) => reconstructDagTask(task, index, idByTaskId)),
  };
  return {
    workflow_id: workflow.id,
    workspace: workflow.workspace,
    objective: workflow.objective,
    dag: parseRawDag(dag),
  };
}
