import { resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import { safeParseJson } from '../../../utils/safe-parse-json.js';

function hasReviewableEntries(dir: unknown): boolean {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  try {
    if (!existsSync(dir)) return false;
    return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.name !== '.git');
  } catch {
    return false;
  }
}

function safeDecodeOutputText(output: string): string {
  try {
    return decodeURIComponent(output);
  } catch {
    return output.replace(/%20/gi, ' ');
  }
}

function normalizePathMention(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function outputMentionsOutputDir(output: string | undefined, outputDir?: string): boolean {
  const text = output ?? '';
  if (/\bOUTPUT_DIR\b/i.test(text)) return true;
  if (!outputDir) return false;
  return normalizePathMention(safeDecodeOutputText(text)).includes(normalizePathMention(outputDir));
}

export function resolveReviewerWorkspaceDir(
  task: Task,
  workspace: string,
  output?: string,
  db?: Database.Database,
  workflowId?: string,
): string {
  const parseCtx = {
    where: 'resolve_reviewer_workspace_dir',
    taskId: task.id,
    ...(db ? { db } : {}),
    ...(workflowId ? { workflowId } : {}),
  };
  const ctx = safeParseJson<Record<string, unknown>>(task.input_json, parseCtx);
  if (ctx) {
    const exec = ctx['execution_context'] as Record<string, unknown> | undefined;
    if (exec && typeof exec === 'object') {
      const outputDir = exec['output_dir'];
      const wt = exec['worktree_root'];
      if (
        typeof outputDir === 'string' &&
        outputDir.length > 0 &&
        (outputMentionsOutputDir(output, outputDir) || (hasReviewableEntries(outputDir) && !hasReviewableEntries(wt)))
      ) {
        return outputDir;
      }
      if (typeof wt === 'string' && wt.length > 0) return wt;
      const sourceCwd = exec['source_cwd'];
      if (typeof sourceCwd === 'string' && sourceCwd.length > 0) return sourceCwd;
      const cwd = exec['cwd'];
      if (typeof cwd === 'string' && cwd.length > 0) return cwd;
    }
  }

  const wsPath = resolve('workspaces', workspace);
  try {
    if (existsSync(wsPath)) return wsPath;
  } catch { /* ignore */ }
  return workspace;
}
