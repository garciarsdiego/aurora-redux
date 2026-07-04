import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import { insertEvent } from '../../../db/persist.js';
import { ensureGitWorktree } from '../../../utils/git-worktree.js';
import {
  replaceTaskExecutionContext,
  resolveTaskExecutionContext,
} from '../../../utils/execution-context.js';

export function prepareCliSpawnIsolation(
  db: Database.Database,
  task: Task,
  workflowId: string,
): void {
  if (task.kind !== 'cli_spawn') return;
  const executionContext = resolveTaskExecutionContext(task);
  if (!executionContext) return;

  const result = ensureGitWorktree(executionContext);
  if ('skipped' in result) {
    insertEvent(db, {
      workflow_id: workflowId,
      task_id: task.id,
      type: 'task_worktree_skipped',
      payload: {
        reason: result.reason,
        source_project_root: executionContext.source_project_root,
        dirty_source: result.dirtySource,
      },
    });
    return;
  }

  task.input_json = replaceTaskExecutionContext(task, result.executionContext);
  try {
    db.prepare('UPDATE tasks SET input_json = ? WHERE id = ?').run(task.input_json, task.id);
  } catch { /* legacy schemas */ }

  if (result.dirtySource) {
    insertEvent(db, {
      workflow_id: workflowId,
      task_id: task.id,
      type: 'task_worktree_source_dirty',
      payload: {
        source_project_root: result.executionContext.source_project_root,
      },
    });
  }

  insertEvent(db, {
    workflow_id: workflowId,
    task_id: task.id,
    type: result.created ? 'task_worktree_created' : 'task_worktree_reused',
    payload: {
      source_project_root: result.executionContext.source_project_root,
      source_cwd: result.executionContext.source_cwd,
      worktree_root: result.executionContext.worktree_root,
      worktree_branch: result.executionContext.worktree_branch,
      base_ref: result.executionContext.base_ref,
      output_dir: result.executionContext.output_dir,
    },
  });
}
