// Sprint 4.5 / Agent M2-A3: workflow diff / debug-log / architecture-contract
// + workspace folder target resolution.
//
// Extracted from dashboard-workflow-ops.ts. The folder-target helper is
// exported because `tests/unit/dashboard-workflow-open-folder.test.ts`
// imports it as a public surface — the facade re-exports it.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { initDb } from '../../../db/client.js';
import { getDbPath } from '../../../utils/config.js';
import { loadWorkflowById } from '../../../db/persist.js';
import { buildWorkflowDebugLog } from '../../../db/workflow-debug-log.js';
import { auditWorkflowDebugLog } from '../../workflow-log-audit.js';
import { getArchitectureContractTool } from '../../tools/get_architecture_contract.js';
import { inspectWorkflowDiffTool } from '../../tools/inspect_workflow_diff.js';
import type { Router } from '../types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from '../_shared.js';
import { parseRecordJson, respondWithCollaborationTool } from './shared.js';

export interface DashboardWorkflowFolderTarget {
  path: string;
  source: 'output_dir' | 'git_worktree';
  output_dir: string;
  worktree_root: string | null;
  reason: string;
}

function pathInsideBase(target: string, base: string): boolean {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hasVisibleEntries(folder: string): boolean {
  try {
    if (!existsSync(folder)) return false;
    return readdirSync(folder).some((entry) => entry !== '.git');
  } catch {
    return false;
  }
}

function latestWorkflowWorktreeRoot(
  db: Database.Database,
  workflowId: string,
): string | null {
  const eventRows = db.prepare(
    `SELECT payload_json
       FROM events
      WHERE workflow_id = ?
        AND type IN ('task_worktree_created', 'task_worktree_reused')
      ORDER BY id DESC
      LIMIT 50`,
  ).all(workflowId) as Array<{ payload_json: string | null }>;

  for (const row of eventRows) {
    const payload = parseRecordJson(row.payload_json);
    const value = payload?.['worktree_root'];
    if (typeof value === 'string' && value.trim()) return value;
  }

  const taskRows = db.prepare(
    `SELECT input_json
       FROM tasks
      WHERE workflow_id = ?
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC, id DESC
      LIMIT 50`,
  ).all(workflowId) as Array<{ input_json: string | null }>;

  for (const row of taskRows) {
    const input = parseRecordJson(row.input_json);
    const context = input?.['execution_context'];
    if (!context || typeof context !== 'object' || Array.isArray(context)) continue;
    const value = (context as Record<string, unknown>)['worktree_root'];
    if (typeof value === 'string' && value.trim()) return value;
  }

  return null;
}

export function resolveDashboardWorkflowFolderTarget(
  db: Database.Database,
  workflow: { id: string; workspace: string },
  options: {
    workspaceBase?: string;
    worktreeBase?: string;
  } = {},
): DashboardWorkflowFolderTarget {
  const workspaceBase = path.resolve(options.workspaceBase ?? 'workspaces');
  const outputDir = path.resolve(workspaceBase, workflow.workspace, 'runs', workflow.id);
  if (!pathInsideBase(outputDir, workspaceBase)) {
    throw new Error('Workflow folder resolved outside workspaces directory');
  }

  const worktreeBase = path.resolve(options.worktreeBase ?? path.join('data', 'worktrees'));
  const rawWorktreeRoot = latestWorkflowWorktreeRoot(db, workflow.id);
  const worktreeRoot = rawWorktreeRoot ? path.resolve(rawWorktreeRoot) : null;

  if (
    worktreeRoot &&
    pathInsideBase(worktreeRoot, worktreeBase) &&
    hasVisibleEntries(worktreeRoot)
  ) {
    return {
      path: worktreeRoot,
      source: 'git_worktree',
      output_dir: outputDir,
      worktree_root: worktreeRoot,
      reason: 'Workflow tasks wrote source artifacts to the git worktree; opening the worktree avoids the empty run output folder.',
    };
  }

  return {
    path: outputDir,
    source: 'output_dir',
    output_dir: outputDir,
    worktree_root: worktreeRoot,
    reason: worktreeRoot
      ? 'Worktree was missing, unsafe, or empty; opening the workflow output directory.'
      : 'No worktree was recorded for this workflow; opening the workflow output directory.',
  };
}

function handleDashboardWorkflowDebugLog(workflowId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    jsonOk(res, buildWorkflowDebugLog(db, workflowId));
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err), {
      structured_error: {
        code: 'workflow_debug_log_failed',
        where: 'dashboard_workflow_debugger',
        suggested_action: 'Refresh the workflow snapshot and verify the workflow still exists.',
      },
    });
  } finally {
    db.close();
  }
}

async function handleDashboardWorkflowLogAudit(
  workflowId: string,
  body: unknown,
  res: ServerResponse,
): Promise<void> {
  const db = initDb(getDbPath());
  try {
    jsonOk(res, await auditWorkflowDebugLog(db, workflowId, body));
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err), {
      structured_error: {
        code: 'workflow_log_audit_failed',
        where: 'dashboard_workflow_log_audit',
        suggested_action: 'Run a dry-run audit first. Approved-run requires explicit approved_by.',
      },
    });
  } finally {
    db.close();
  }
}

async function handleDashboardArchitectureContract(workflowId: string, res: ServerResponse): Promise<void> {
  await respondWithCollaborationTool(
    res,
    'architecture_contract_read_failed',
    'dashboard_collaboration:architecture_contract',
    { workflow_id: workflowId },
    'Open the debugger JSON and confirm this workflow was run with existing_code_feature or has a recorded architecture contract decision.',
    () => getArchitectureContractTool({ workflow_id: workflowId }),
  );
}

async function handleDashboardWorkflowDiff(workflowId: string, res: ServerResponse): Promise<void> {
  await respondWithCollaborationTool(
    res,
    'workflow_diff_inspect_failed',
    'dashboard_collaboration:workflow_diff',
    { workflow_id: workflowId },
    'Verify at least one task has an execution root/worktree recorded, then retry diff inspection.',
    () => inspectWorkflowDiffTool({ workflow_id: workflowId }),
  );
}

function handleDashboardWorkflowOpenFolder(workflowId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const workflow = loadWorkflowById(db, workflowId);
    if (!workflow) { notFound(res, `Workflow not found: ${workflowId}`); return; }
    const target = resolveDashboardWorkflowFolderTarget(db, workflow);
    mkdirSync(target.path, { recursive: true });
    const command = process.platform === 'win32'
      ? 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
    const child = spawn(command, [target.path], { detached: true, stdio: 'ignore', shell: false });
    child.unref();
    jsonOk(res, { ok: true, ...target });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

export const diffRouter: Router = async (req, url, res) => {
  const wfDebugLogMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/debug-log$/);
  if (req.method === 'GET' && wfDebugLogMatch) {
    handleDashboardWorkflowDebugLog(decodeURIComponent(wfDebugLogMatch[1] ?? ''), res);
    return true;
  }
  const wfLogAuditMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/log-audit$/);
  if (req.method === 'POST' && wfLogAuditMatch) {
    let body: unknown;
    try { body = await readJsonBody(req); } catch (err) { badRequest(res, (err as Error).message); return true; }
    await handleDashboardWorkflowLogAudit(decodeURIComponent(wfLogAuditMatch[1] ?? ''), body, res);
    return true;
  }
  const wfArchitectureContractMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/architecture-contract$/);
  if (req.method === 'GET' && wfArchitectureContractMatch) {
    await handleDashboardArchitectureContract(decodeURIComponent(wfArchitectureContractMatch[1] ?? ''), res);
    return true;
  }
  const wfDiffMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/diff$/);
  if (req.method === 'GET' && wfDiffMatch) {
    await handleDashboardWorkflowDiff(decodeURIComponent(wfDiffMatch[1] ?? ''), res);
    return true;
  }
  const wfOpenFolderMatch = url.pathname.match(/^\/api\/dashboard\/workflows\/([^/]+)\/open-folder$/);
  if (req.method === 'POST' && wfOpenFolderMatch) {
    handleDashboardWorkflowOpenFolder(decodeURIComponent(wfOpenFolderMatch[1] ?? ''), res);
    return true;
  }
  return false;
};
