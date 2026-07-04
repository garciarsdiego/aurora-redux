import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join, relative, resolve as pathResolve, sep as pathSep } from 'node:path';
import type { TaskExecutionContext } from './execution-context.js';

export interface ProvisionedWorktree {
  executionContext: TaskExecutionContext;
  created: boolean;
  dirtySource: boolean;
}

export type WorktreeProvisionResult =
  | ProvisionedWorktree
  | {
    skipped: true;
    reason: string;
    dirtySource: boolean;
  };

function runGit(
  cwd: string,
  args: string[],
): { ok: true; stdout: string; stderr: string } | { ok: false; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status === 0) {
    return {
      ok: true,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  }
  return {
    ok: false,
    stderr: [result.stderr, result.stdout].filter(Boolean).join('\n').trim() || `git ${args.join(' ')} failed`,
  };
}

function isInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${pathSep}`);
}

export type WorktreeStatus = 'changed' | 'clean' | 'unavailable';

/**
 * Cheap evidence-of-work probe for a cli_spawn worktree (Aurora-parity Wave 0,
 * F-LIVE-5). Returns 'clean' ONLY when git positively reports an empty working
 * tree, 'changed' when there are uncommitted modifications, and 'unavailable'
 * when the path is missing or git can't read it. Callers must treat
 * 'unavailable' as "cannot tell" (do NOT downgrade) so we never introduce a
 * false negative on workspaces that never provisioned a worktree.
 */
export function worktreeStatus(worktreeRoot: string): WorktreeStatus {
  if (!existsSync(worktreeRoot)) return 'unavailable';
  const result = runGit(worktreeRoot, ['status', '--porcelain']);
  if (!result.ok) return 'unavailable';
  return result.stdout.trim().length > 0 ? 'changed' : 'clean';
}

/**
 * Relative paths of added/modified (NOT deleted) files in the worktree, parsed
 * from `git status --porcelain`. Used by the Wave-1 precommit gate to scan only
 * what a coding task actually changed (not the whole checkout). Returns [] when
 * the path is missing or git can't read it. Handles rename ("old -> new") and
 * quoted paths.
 */
export function listWorktreeChangedFiles(worktreeRoot: string): string[] {
  if (!existsSync(worktreeRoot)) return [];
  // --untracked-files=all lists individual new files (not just their parent
  // dir), so a coding task that creates a brand-new directory has its files
  // enumerated for the precommit scan instead of being skipped as a dir.
  const result = runGit(worktreeRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (!result.ok) return [];
  const files: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const status = line.slice(0, 2);
    if (status.includes('D')) continue; // deletion — nothing to scan
    let pathPart = line.slice(3).trim();
    const renameIdx = pathPart.indexOf(' -> ');
    if (renameIdx !== -1) pathPart = pathPart.slice(renameIdx + 4).trim();
    pathPart = pathPart.replace(/^"|"$/g, '');
    if (pathPart.length > 0) files.push(pathPart);
  }
  return files;
}

function branchNameForWorkflow(workflowId: string): string {
  return `omniforge/${workflowId.replace(/[^a-zA-Z0-9/_-]/g, '-')}`;
}

function canonicalPath(target: string): string {
  return existsSync(target) ? realpathSync.native(target) : pathResolve(target);
}

function isExistingGitWorktree(target: string): boolean {
  if (!existsSync(target)) return false;
  if (existsSync(join(target, '.git'))) return true;
  const probe = runGit(target, ['rev-parse', '--is-inside-work-tree']);
  return probe.ok && probe.stdout.trim() === 'true';
}

function ensureEmptyTargetOrWorktree(target: string): void {
  if (!existsSync(target)) return;
  if (isExistingGitWorktree(target)) return;
  const entries = readdirSync(target);
  if (entries.length > 0) {
    throw new Error(`Worktree target already exists and is not empty: ${target}`);
  }
}

function sourceDirty(sourceProjectRoot: string): boolean {
  const result = runGit(sourceProjectRoot, ['status', '--porcelain']);
  return result.ok ? result.stdout.trim().length > 0 : false;
}

/**
 * Camada B (auto-init): when source_project_root is not yet a git repo,
 * initialize it on the fly so cli_spawn workers can run anywhere — even
 * brand-new workspaces that the operator never `git init`'d. Idempotent:
 * the initial commit is `--allow-empty` and only fires when the dir has
 * no commits. user.email / user.name fallbacks cover sandbox envs that
 * lack global git config. Returns the canonical toplevel path on success
 * or null when init itself failed (e.g. permission denied).
 */
export function ensureGitInitialized(sourceProjectRoot: string): string | null {
  // Probe first — already a repo? no-op.
  const probe = runGit(sourceProjectRoot, ['rev-parse', '--show-toplevel']);
  if (probe.ok) return probe.stdout.trim();

  // Make sure the directory exists so `git init` has somewhere to land.
  if (!existsSync(sourceProjectRoot)) {
    try {
      mkdirSync(sourceProjectRoot, { recursive: true });
    } catch {
      return null;
    }
  }

  const init = runGit(sourceProjectRoot, ['init']);
  if (!init.ok) return null;

  // `git worktree add` requires at least one commit on the source. Configure
  // a fallback identity so the commit doesn't fail in sandboxes where global
  // user.email / user.name aren't set.
  runGit(sourceProjectRoot, ['config', 'user.email', 'omniforge@local']);
  runGit(sourceProjectRoot, ['config', 'user.name', 'Omniforge']);

  // If the operator dropped files into the dir before the first run, stage
  // them so the seed commit captures the starting state.
  const status = runGit(sourceProjectRoot, ['status', '--porcelain']);
  if (status.ok && status.stdout.trim().length > 0) {
    runGit(sourceProjectRoot, ['add', '-A']);
  }

  const commit = runGit(sourceProjectRoot, [
    'commit',
    '--allow-empty',
    '-m',
    'omniforge: initialize workspace',
  ]);
  if (!commit.ok) return null;

  const reprobe = runGit(sourceProjectRoot, ['rev-parse', '--show-toplevel']);
  return reprobe.ok ? reprobe.stdout.trim() : null;
}

/**
 * Symlink one artifact dir from the source toplevel into the worktree. Junctions
 * on Windows (no admin), dir symlinks elsewhere; failures are logged + swallowed
 * so worktree provisioning still succeeds.
 */
function symlinkArtifactDir(worktreeRoot: string, sourceRoot: string, name: string): void {
  const target = join(worktreeRoot, name);
  if (existsSync(target)) return;
  const source = join(sourceRoot, name);
  if (!existsSync(source)) return;
  try {
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[git-worktree] failed to symlink ${name} into ${worktreeRoot}: ${(err as Error).message}`,
    );
  }
}

/**
 * Symlink build/runtime artifacts the worktree needs:
 *   - node_modules (D-H2.078 Fix B) — so spawned CLIs can run tsc/vitest instead
 *     of hitting ENOENT and falling back to editing the main repo.
 *   - dist (Aurora dogfood 2026-05-31) — so the Wave-1 test-runner doesn't
 *     FALSE-FAIL on tests that import compiled `dist/*` (gitignored → absent from
 *     a fresh checkout). The build-check (tsc) already validates src; this only
 *     prevents ENOENT for the minority of dist-importing tests.
 */
function ensureWorktreeArtifacts(worktreeRoot: string, sourceRoot: string): void {
  symlinkArtifactDir(worktreeRoot, sourceRoot, 'node_modules');
  symlinkArtifactDir(worktreeRoot, sourceRoot, 'dist');
}

export function ensureGitWorktree(
  executionContext: TaskExecutionContext,
): WorktreeProvisionResult {
  const sourceProjectRoot = canonicalPath(executionContext.source_project_root || executionContext.project_root);
  const sourceCwd = canonicalPath(executionContext.source_cwd || executionContext.cwd);

  // Camada B: auto-init the source if it's not a git repo yet. Self-healing —
  // every `cli_spawn` task that hits a fresh workspace ends up bootstrapping
  // git so worktree provisioning succeeds on the very first run. The probe
  // re-runs after init so the rest of the pipeline keeps working unchanged.
  let autoInitialized = false;
  let topLevel = runGit(sourceProjectRoot, ['rev-parse', '--show-toplevel']);
  if (!topLevel.ok) {
    const initToplevel = ensureGitInitialized(sourceProjectRoot);
    if (initToplevel === null) {
      return {
        skipped: true,
        reason: 'source_project_root is not a git repository (auto-init failed)',
        dirtySource: false,
      };
    }
    autoInitialized = true;
    topLevel = runGit(sourceProjectRoot, ['rev-parse', '--show-toplevel']);
    if (!topLevel.ok) {
      return {
        skipped: true,
        reason: 'source_project_root not git-able even after auto-init',
        dirtySource: false,
      };
    }
  }
  const dirty = sourceDirty(sourceProjectRoot);

  // D-H2.078 Fix A (onda-2 cleanup): the previous implementation rejected any
  // sourceProjectRoot that wasn't EXACTLY the git toplevel. In practice the
  // executor builds executionContext with project_root =
  // workspaces/<ws>/runs/<wfId> — a SUBDIR of the toplevel — so every cli_spawn
  // task fell into `task_worktree_skipped`, defeating worktree isolation.
  //
  // The fix: when sourceProjectRoot is inside the toplevel, switch to using
  // the toplevel as the canonical source for `git worktree add`. The worker
  // still gets cwd = wherever the original sourceCwd resolves inside the
  // worktree.
  const repoRoot = canonicalPath(topLevel.stdout.trim());
  const sourceMatchesToplevel = repoRoot === sourceProjectRoot;
  const sourceInsideToplevel = isInsideRoot(sourceProjectRoot, repoRoot);

  if (!sourceMatchesToplevel && !sourceInsideToplevel) {
    return {
      skipped: true,
      reason: `source_project_root (${sourceProjectRoot}) is not inside the git toplevel (${repoRoot})`,
      dirtySource: dirty,
    };
  }

  // When source is inside (but not equal to) toplevel, use the toplevel as
  // the canonical source — `git worktree add` only works from a real toplevel.
  const effectiveSourceRoot = sourceMatchesToplevel ? sourceProjectRoot : repoRoot;
  const effectiveSourceCwd = sourceMatchesToplevel ? sourceCwd : (
    isInsideRoot(sourceCwd, repoRoot) ? sourceCwd : repoRoot
  );

  if (!isInsideRoot(effectiveSourceCwd, effectiveSourceRoot)) {
    throw new Error(`source_cwd must stay inside source_project_root: ${effectiveSourceCwd}`);
  }

  const relativeCwd = relative(effectiveSourceRoot, effectiveSourceCwd);
  if (relativeCwd.startsWith('..')) {
    throw new Error(`source_cwd is outside source_project_root: ${effectiveSourceCwd}`);
  }

  const worktreeRoot = executionContext.worktree_root
    ? canonicalPath(executionContext.worktree_root)
    : pathResolve('data', 'worktrees', executionContext.lineage.workspace, executionContext.lineage.workflow_id);
  const worktreeBranch = executionContext.worktree_branch ?? branchNameForWorkflow(executionContext.lineage.workflow_id);
  const alreadyExists = isExistingGitWorktree(worktreeRoot);

  if (!alreadyExists) {
    ensureEmptyTargetOrWorktree(worktreeRoot);
    mkdirSync(dirname(worktreeRoot), { recursive: true });
    const addArgs = ['worktree', 'add', '-b', worktreeBranch, worktreeRoot];
    if (executionContext.base_ref) {
      const baseRef = executionContext.base_ref;
      const baseExists = runGit(effectiveSourceRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
      // Auto-init creates a fresh one-commit repo whose default branch depends
      // on local git config. If the workspace profile still says `main`, use
      // HEAD rather than failing with "invalid reference: main".
      if (baseExists.ok || !autoInitialized) {
        addArgs.push(baseRef);
      }
    }
    const created = runGit(effectiveSourceRoot, addArgs);
    if (!created.ok) {
      throw new Error(created.stderr);
    }
  }

  // D-H2.078 Fix B: symlink node_modules so the worker can run tsc/vitest
  // inside the worktree. See ensureNodeModulesSymlink doc above.
  ensureWorktreeArtifacts(worktreeRoot, effectiveSourceRoot);

  const effectiveCwd = relativeCwd && relativeCwd !== '.'
    ? pathResolve(worktreeRoot, relativeCwd)
    : worktreeRoot;

  if (!existsSync(effectiveCwd)) {
    if (!alreadyExists) {
      runGit(effectiveSourceRoot, ['worktree', 'remove', '--force', worktreeRoot]);
    }
    return {
      skipped: true,
      reason: `worktree target cwd is missing from checked out ref: ${effectiveCwd}`,
      dirtySource: dirty,
    };
  }

  return {
    created: !alreadyExists,
    dirtySource: dirty,
    executionContext: {
      ...executionContext,
      project_root: worktreeRoot,
      cwd: effectiveCwd,
      source_project_root: effectiveSourceRoot,
      source_cwd: effectiveSourceCwd,
      worktree_root: worktreeRoot,
      worktree_branch: worktreeBranch,
      lineage: {
        ...executionContext.lineage,
        source: 'git_worktree',
      },
    },
  };
}
