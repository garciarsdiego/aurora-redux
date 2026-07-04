import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { redactContextJson, redactContextText } from '../../context/redaction.js';

const InspectWorkflowDiffSchema = z.object({
  workflow_id: z.string().min(1),
});

function parseInputJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function executionRoots(inputJson: unknown): string[] {
  const input = parseInputJson(inputJson);
  const executionContext = input['execution_context'];
  if (!executionContext || typeof executionContext !== 'object' || Array.isArray(executionContext)) return [];
  return ['output_dir', 'worktree_root', 'source_cwd', 'cwd']
    .map((key) => (executionContext as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function gitStatus(root: string): { root: string; exists: boolean; is_git: boolean; status: string[]; error?: string } {
  const absolute = resolve(root);
  if (!existsSync(absolute)) return { root: absolute, exists: false, is_git: false, status: [] };
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: absolute,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (probe.status !== 0) return { root: absolute, exists: true, is_git: false, status: [] };
  const status = spawnSync('git', ['status', '--short'], {
    cwd: absolute,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (status.status !== 0) {
    return {
      root: absolute,
      exists: true,
      is_git: true,
      status: [],
      error: redactContextText(status.stderr || status.stdout || 'git status failed'),
    };
  }
  return {
    root: absolute,
    exists: true,
    is_git: true,
    status: status.stdout.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean),
  };
}

export async function inspectWorkflowDiffTool(raw: unknown): Promise<string> {
  const input = InspectWorkflowDiffSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const tasks = db.prepare(
      `SELECT id, name, status, input_json
         FROM tasks
        WHERE workflow_id = ?
        ORDER BY created_at ASC, id ASC`,
    ).all(input.workflow_id) as Array<Record<string, unknown>>;
    const roots = Array.from(new Set(tasks.flatMap((task) => executionRoots(task['input_json']))));
    const reports = roots.map(gitStatus);
    return JSON.stringify(redactContextJson({
      workflow_id: input.workflow_id,
      roots: reports,
      notes: [
        'This tool only reports git status for task execution roots. It does not modify files.',
        'Non-git output directories can still contain valid artifacts; inspect task output folders separately.',
      ],
    }), null, 2);
  } finally {
    db.close();
  }
}
