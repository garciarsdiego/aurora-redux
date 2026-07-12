import { isAbsolute, resolve as pathResolve } from 'node:path';
import type { Task } from '../types/index.js';
import { initDb } from '../db/client.js';
import { getDbPath } from './config.js';
import { safeJsonObject } from './safe-parse-json.js';

export interface TaskExecutionLineage {
  lane: 'software';
  source: 'workspace_run' | 'git_worktree';
  workspace: string;
  workflow_id: string;
  task_id: string;
}

export interface TaskExecutionContext {
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
  lineage: TaskExecutionLineage;
}

interface TaskExecutionSeed {
  workspace: string;
  workflowId: string;
  taskId: string;
}

function resolveContextPath(raw: unknown, fallback: string, baseDir: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  return isAbsolute(raw) ? pathResolve(raw) : pathResolve(baseDir, raw);
}

function parseTaskInput(task: Pick<Task, 'input_json'>): Record<string, unknown> {
  return safeJsonObject(task.input_json, { where: 'execution_context.parseTaskInput' });
}

function readWorkflowWorkspace(workflowId: string): string | null {
  try {
    const db = initDb(getDbPath());
    try {
      const row = db
        .prepare('SELECT workspace FROM workflows WHERE id = ?')
        .get(workflowId) as { workspace: string } | undefined;
      return row?.workspace ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function resolveTaskWorkspace(task: Pick<Task, 'workflow_id' | 'workspace' | 'input_json'>): string | null {
  if (typeof task.workspace === 'string' && task.workspace.length > 0) return task.workspace;
  const input = parseTaskInput(task);
  if (typeof input['workspace'] === 'string' && input['workspace'].length > 0) {
    return input['workspace'];
  }
  return task.workflow_id ? readWorkflowWorkspace(task.workflow_id) : null;
}

export function buildTaskExecutionContext(
  seed: TaskExecutionSeed,
  raw?: unknown,
): TaskExecutionContext {
  const workspaceRoot = pathResolve('workspaces', seed.workspace);
  const runRoot = pathResolve(workspaceRoot, 'runs', seed.workflowId);
  const rawCtx = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};

  const resolvedRunRoot = resolveContextPath(rawCtx['run_root'], runRoot, workspaceRoot);
  const projectRoot = resolveContextPath(rawCtx['project_root'], resolvedRunRoot, resolvedRunRoot);
  const outputDir = resolveContextPath(rawCtx['output_dir'], resolvedRunRoot, resolvedRunRoot);
  const cwd = resolveContextPath(rawCtx['cwd'], projectRoot, projectRoot);
  const resolvedWorkspaceRoot = resolveContextPath(rawCtx['workspace_root'], workspaceRoot, workspaceRoot);
  const sourceProjectRoot = resolveContextPath(rawCtx['source_project_root'], projectRoot, resolvedRunRoot);
  const sourceCwd = resolveContextPath(rawCtx['source_cwd'], cwd, sourceProjectRoot);
  const worktreeRoot = typeof rawCtx['worktree_root'] === 'string' && rawCtx['worktree_root'].trim().length > 0
    ? resolveContextPath(rawCtx['worktree_root'], resolvedRunRoot, resolvedWorkspaceRoot)
    : null;
  const lineageRaw = rawCtx['lineage'];
  const lineageInput = lineageRaw && typeof lineageRaw === 'object' && !Array.isArray(lineageRaw)
    ? lineageRaw as Record<string, unknown>
    : {};

  return {
    workspace_root: resolvedWorkspaceRoot,
    run_root: resolvedRunRoot,
    project_root: projectRoot,
    cwd,
    output_dir: outputDir,
    base_ref: typeof rawCtx['base_ref'] === 'string' ? rawCtx['base_ref'] : null,
    source_project_root: sourceProjectRoot,
    source_cwd: sourceCwd,
    worktree_root: worktreeRoot,
    worktree_branch: typeof rawCtx['worktree_branch'] === 'string' ? rawCtx['worktree_branch'] : null,
    lineage: {
      lane: 'software',
      source: lineageInput['source'] === 'git_worktree' ? 'git_worktree' : 'workspace_run',
      workspace: typeof lineageInput['workspace'] === 'string' ? lineageInput['workspace'] : seed.workspace,
      workflow_id: typeof lineageInput['workflow_id'] === 'string' ? lineageInput['workflow_id'] : seed.workflowId,
      task_id: typeof lineageInput['task_id'] === 'string' ? lineageInput['task_id'] : seed.taskId,
    },
  };
}

export function replaceTaskExecutionContext(
  task: Pick<Task, 'input_json'>,
  executionContext: TaskExecutionContext,
): string {
  const input = parseTaskInput(task);
  return JSON.stringify({
    ...input,
    execution_context: executionContext,
  });
}

export function resolveTaskExecutionContext(
  task: Pick<Task, 'id' | 'workflow_id' | 'workspace' | 'input_json'>,
): TaskExecutionContext | null {
  const workspace = resolveTaskWorkspace(task);
  if (!workspace) return null;
  const input = parseTaskInput(task);
  return buildTaskExecutionContext(
    {
      workspace,
      workflowId: task.workflow_id,
      taskId: task.id,
    },
    input['execution_context'],
  );
}
