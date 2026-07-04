import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Task, TaskKind } from '../types/index.js';
import { insertEvent, loadWorkflowById, loadWorkflowTasks } from '../db/persist.js';
import { withSqliteRetrySync } from '../db/sqlite-retry.js';
import {
  loadCatalog as loadOmnirouteCatalog,
  extractProvider,
  type Catalog,
  type ModelEntry,
  type ModelKind,
} from '../repl/services/modelCatalog.js';

const PatchDashboardTaskModelSchema = z.object({
  model: z.string().min(1).max(240),
}).strict();

type CompatibleTask = Pick<Task, 'kind' | 'executor_hint'> | {
  kind: TaskKind | string;
  executor_hint?: string | null;
};

type CompatibleModel = Pick<ModelEntry, 'model_id' | 'kind'> | {
  model_id: string;
  kind: ModelKind | string;
};

const CLI_PROVIDER_COMPAT: Readonly<Record<string, readonly string[]>> = {
  'claude-code': ['cc', 'claude', 'cli'],
  claude: ['cc', 'claude', 'cli'],
  codex: ['cx', 'openai', 'cli'],
  gemini: ['gemini-cli', 'gemini', 'cli'],
  kimi: ['kmc', 'kimi', 'cli'],
  cursor: ['cu', 'cli'],
  kilo: ['cli'],
  opencode: ['opencode-go', 'cli'],
};

function normalizeExecutorHint(hint: string | null | undefined): string {
  return (hint ?? '').trim().toLowerCase();
}

function cliSlugFromHint(hint: string | null | undefined): string | null {
  const normalized = normalizeExecutorHint(hint);
  if (!normalized.startsWith('cli:')) return null;
  const slug = normalized.slice('cli:'.length).trim();
  return slug || null;
}

export function isTaskModelCompatible(task: CompatibleTask, model: CompatibleModel): boolean {
  const modelId = model.model_id.trim();
  const modelKind = String(model.kind).toLowerCase();
  const provider = extractProvider(modelId);
  const cliSlug = cliSlugFromHint(task.executor_hint);

  if (task.kind === 'cli_spawn' || cliSlug) {
    if (!cliSlug) return modelKind === 'cli' || provider === 'cli';
    if (modelId.toLowerCase().startsWith('cli:')) {
      return modelId.toLowerCase() === `cli:${cliSlug}`;
    }
    return (CLI_PROVIDER_COMPAT[cliSlug] ?? ['cli']).includes(provider);
  }

  if (task.kind === 'pal_call' || normalizeExecutorHint(task.executor_hint).startsWith('pal:')) {
    return modelKind === 'pal' || provider === 'pal';
  }

  if (task.kind === 'llm_call' || task.kind === 'tool_call') {
    return modelKind === 'llm' || modelKind === 'unknown';
  }

  return modelKind === 'llm' || modelKind === 'unknown';
}

function taskById(db: Database.Database, workflowId: string, taskId: string): Task {
  const task = loadWorkflowTasks(db, workflowId).find((item) => item.id === taskId);
  if (!task) throw new Error(`Task not found in workflow: ${taskId}`);
  return task;
}

export async function patchDashboardTaskModel(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  rawPatch: unknown,
  catalogLoader: (input?: { force?: boolean }) => Promise<Catalog> = loadOmnirouteCatalog,
): Promise<Task> {
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  const task = taskById(db, workflowId, taskId);
  if (task.status !== 'pending') {
    throw new Error(`Cannot change model for ${task.status} task: ${taskId}`);
  }

  const patch = PatchDashboardTaskModelSchema.parse(rawPatch);
  const catalog = await catalogLoader({ force: false });
  const model = catalog.models.find((item) => item.model_id === patch.model);
  if (!model) throw new Error(`Model not found in catalog: ${patch.model}`);
  if (!isTaskModelCompatible(task, model)) {
    throw new Error(`Model ${patch.model} is not compatible with ${task.kind}${task.executor_hint ? ` (${task.executor_hint})` : ''}`);
  }

  withSqliteRetrySync(() =>
    db.prepare(`UPDATE tasks SET model = ? WHERE id = ? AND workflow_id = ?`)
      .run(patch.model, taskId, workflowId),
  );

  insertEvent(db, {
    workflow_id: workflowId,
    task_id: taskId,
    type: 'dashboard_task_model_changed',
    payload: {
      previous_model: task.model,
      model: patch.model,
      executor_hint: task.executor_hint,
      kind: task.kind,
    },
  });

  return taskById(db, workflowId, taskId);
}

export function lookupWorkflowIdForTask(db: Database.Database, taskId: string): string | null {
  const row = db.prepare(`SELECT workflow_id FROM tasks WHERE id = ? LIMIT 1`).get(taskId) as
    | { workflow_id: string }
    | undefined;
  return row?.workflow_id ?? null;
}
