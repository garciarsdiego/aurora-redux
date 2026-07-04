import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureGitWorktree } from '../../src/utils/git-worktree.js';
import type { TaskExecutionContext } from '../../src/utils/execution-context.js';

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error([result.stderr, result.stdout].filter(Boolean).join('\n') || `git ${args.join(' ')} failed`);
  }
}

describe('git worktree provisioning', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-initializes a fresh source root before provisioning a worktree', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-git-worktree-init-'));
    tempDirs.push(tempDir);
    const context: TaskExecutionContext = {
      workspace_root: resolve(tempDir, 'workspaces', 'internal'),
      run_root: resolve(tempDir, 'workspaces', 'internal', 'runs', 'wf_skip'),
      project_root: resolve(tempDir, 'repo'),
      cwd: resolve(tempDir, 'repo'),
      output_dir: resolve(tempDir, 'workspaces', 'internal', 'runs', 'wf_skip'),
      base_ref: null,
      source_project_root: resolve(tempDir, 'repo'),
      source_cwd: resolve(tempDir, 'repo'),
      worktree_root: resolve(tempDir, 'isolated-worktrees', 'wf_skip'),
      worktree_branch: null,
      lineage: {
        lane: 'software',
        source: 'workspace_run',
        workspace: 'internal',
        workflow_id: 'wf_skip',
        task_id: 'tk_skip',
      },
    };

    mkdirSync(context.project_root, { recursive: true });
    const result = ensureGitWorktree(context);
    expect('skipped' in result).toBe(false);
    if ('skipped' in result) return;
    expect(result.created).toBe(true);
    expect(result.executionContext.project_root).toBe(resolve(tempDir, 'isolated-worktrees', 'wf_skip'));
    expect(result.executionContext.lineage.source).toBe('git_worktree');
    runGit(result.executionContext.project_root, ['rev-parse', '--is-inside-work-tree']);
  });

  it('creates a workflow-scoped worktree and rewrites the effective execution context', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-git-worktree-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const repoCwd = join(repoRoot, 'packages', 'app');
    mkdirSync(repoCwd, { recursive: true });

    runGit(tempDir, ['init', repoRoot]);
    runGit(repoRoot, ['config', 'user.name', 'Omniforge Test']);
    runGit(repoRoot, ['config', 'user.email', 'omniforge@example.com']);
    runGit(repoRoot, ['checkout', '-b', 'main']);
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n');
    writeFileSync(join(repoCwd, 'index.ts'), 'export const ok = true;\n');
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'init']);

    const context: TaskExecutionContext = {
      workspace_root: resolve(tempDir, 'workspaces', 'internal'),
      run_root: resolve(tempDir, 'workspaces', 'internal', 'runs', 'wf_git'),
      project_root: resolve(repoRoot),
      cwd: resolve(repoCwd),
      output_dir: resolve(tempDir, 'workspaces', 'internal', 'runs', 'wf_git'),
      base_ref: 'main',
      source_project_root: resolve(repoRoot),
      source_cwd: resolve(repoCwd),
      worktree_root: resolve(tempDir, 'isolated-worktrees', 'wf_git'),
      worktree_branch: null,
      lineage: {
        lane: 'software',
        source: 'workspace_run',
        workspace: 'internal',
        workflow_id: 'wf_git',
        task_id: 'tk_git',
      },
    };

    const result = ensureGitWorktree(context);
    expect('skipped' in result).toBe(false);
    if ('skipped' in result) return;
    expect(result.executionContext.project_root).toBe(resolve(tempDir, 'isolated-worktrees', 'wf_git'));
    expect(result.executionContext.cwd).toBe(resolve(tempDir, 'isolated-worktrees', 'wf_git', 'packages', 'app'));
    expect(result.executionContext.source_project_root).toBe(realpathSync.native(repoRoot));
    expect(result.executionContext.worktree_branch).toBe('omniforge/wf_git');
    expect(result.executionContext.lineage.source).toBe('git_worktree');
    runGit(result.executionContext.project_root, ['rev-parse', '--is-inside-work-tree']);
  });

  it('skips and cleans up when the target cwd is not present in the checked-out ref', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-git-worktree-missing-cwd-'));
    tempDirs.push(tempDir);
    const repoRoot = join(tempDir, 'repo');
    const trackedDir = join(repoRoot, 'tracked');
    const untrackedDir = join(repoRoot, 'apps', 'dashboard');
    const worktreeRoot = resolve(tempDir, 'isolated-worktrees', 'wf_missing_cwd');
    mkdirSync(trackedDir, { recursive: true });

    runGit(tempDir, ['init', repoRoot]);
    runGit(repoRoot, ['config', 'user.name', 'Omniforge Test']);
    runGit(repoRoot, ['config', 'user.email', 'omniforge@example.com']);
    runGit(repoRoot, ['checkout', '-b', 'main']);
    writeFileSync(join(trackedDir, 'README.md'), 'tracked\n');
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'init tracked dir']);
    mkdirSync(untrackedDir, { recursive: true });
    writeFileSync(join(untrackedDir, 'local-only.txt'), 'untracked\n');

    const context: TaskExecutionContext = {
      workspace_root: resolve(tempDir, 'workspaces', 'internal'),
      run_root: resolve(tempDir, 'workspaces', 'internal', 'runs', 'wf_missing_cwd'),
      project_root: resolve(repoRoot),
      cwd: resolve(untrackedDir),
      output_dir: resolve(tempDir, 'workspaces', 'internal', 'runs', 'wf_missing_cwd'),
      base_ref: 'main',
      source_project_root: resolve(repoRoot),
      source_cwd: resolve(untrackedDir),
      worktree_root: worktreeRoot,
      worktree_branch: null,
      lineage: {
        lane: 'software',
        source: 'workspace_run',
        workspace: 'internal',
        workflow_id: 'wf_missing_cwd',
        task_id: 'tk_missing_cwd',
      },
    };

    const result = ensureGitWorktree(context);
    expect('skipped' in result && result.skipped).toBe(true);
    if (!('skipped' in result)) return;
    expect(result.reason).toContain('worktree target cwd is missing');
    expect(existsSync(worktreeRoot)).toBe(false);
  });
});
