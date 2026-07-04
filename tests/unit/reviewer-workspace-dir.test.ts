import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveReviewerWorkspaceDir } from '../../src/brain/executor/run-task.js';
import type { Task } from '../../src/types/index.js';

function taskWithExecutionContext(ctx: Record<string, unknown>, outputJson = ''): Task {
  return {
    id: 'tk_dir',
    workflow_id: 'wf_dir',
    name: 'Scaffold project',
    kind: 'cli_spawn',
    input_json: JSON.stringify({ execution_context: ctx }),
    output_json: outputJson,
    status: 'completed',
    depends_on: [],
    executor_hint: 'cli:claude-code',
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: 'package.json exists; tsconfig.json present',
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: null,
    hitl: false,
    workspace: 'internal',
  } as unknown as Task;
}

describe('resolveReviewerWorkspaceDir', () => {
  it('prefers OUTPUT_DIR when the worker says generated artifacts were created there', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'omniforge-review-dir-'));
    const worktreeRoot = path.join(root, 'worktree');
    const outputDir = path.join(root, 'run-output');
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(worktreeRoot, '.git'), 'gitdir: elsewhere\n');
    writeFileSync(path.join(outputDir, 'package.json'), '{"scripts":{"build":"vite"}}\n');

    const task = taskWithExecutionContext({
      worktree_root: worktreeRoot,
      output_dir: outputDir,
      source_cwd: path.join(root, 'source'),
      cwd: worktreeRoot,
    });

    expect(resolveReviewerWorkspaceDir(task, 'internal', 'Scaffold complete in OUTPUT_DIR.')).toBe(outputDir);
  });

  it('keeps the worktree when the worker output does not point at OUTPUT_DIR', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'omniforge-review-dir-'));
    const worktreeRoot = path.join(root, 'worktree');
    const outputDir = path.join(root, 'run-output');
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(worktreeRoot, 'package.json'), '{"name":"source-edit"}\n');
    writeFileSync(path.join(outputDir, 'package.json'), '{"name":"artifact"}\n');

    const task = taskWithExecutionContext({
      worktree_root: worktreeRoot,
      output_dir: outputDir,
      source_cwd: path.join(root, 'source'),
      cwd: worktreeRoot,
    });

    expect(resolveReviewerWorkspaceDir(task, 'internal', 'Updated the source project.')).toBe(worktreeRoot);
  });

  it('prefers output_dir when the worker output links files inside that absolute directory', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'omniforge-review-dir-'));
    const worktreeRoot = path.join(root, 'worktree');
    const outputDir = path.join(root, 'run output');
    const outputFile = path.join(outputDir, 'src', 'data', 'mock.ts');
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(path.join(worktreeRoot, 'package.json'), '{"name":"source-edit"}\n');
    writeFileSync(outputFile, 'export const mockWorkspace = {};\n');

    const task = taskWithExecutionContext({
      worktree_root: worktreeRoot,
      output_dir: outputDir,
      source_cwd: path.join(root, 'source'),
      cwd: worktreeRoot,
    });

    const linkedOutput = `Created [src/data/mock.ts](${outputFile.replace(/\\/g, '/').replace(/ /g, '%20')}).`;

    expect(resolveReviewerWorkspaceDir(task, 'internal', linkedOutput)).toBe(outputDir);
  });
});
