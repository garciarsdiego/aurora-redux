import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve, sep as pathSep } from 'node:path';

// Workspace name allowlist — alphanumeric + underscore + hyphen only.
// Blocks `..`, `/`, `\`, `.` traversal sequences before any path resolve.
export const VALID_WORKSPACE_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * True when `candidate` equals `root` or lives strictly inside it. Both paths
 * must already be resolved/normalized by the caller. Shared by git-worktree.ts
 * and workspace-profile.ts so future edge-case fixes (e.g. Windows case
 * insensitivity) land in exactly one place.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${pathSep}`);
}

export function assertValidWorkspace(workspace: string): void {
  if (!VALID_WORKSPACE_RE.test(workspace)) {
    throw new Error(
      `Invalid workspace name '${workspace}'. ` +
      `Allowed: alphanumeric, underscore, hyphen. No path separators, dots, or whitespace.`,
    );
  }
}

export function loadWorkspaceEnv(workspace: string): void {
  assertValidWorkspace(workspace);
  const path = resolve('workspaces', workspace, '.env');
  if (!existsSync(path)) {
    return;
  }
  // override: true so workspace .env wins over root .env — that's the whole point
  // of workspace-scoped config. Pair with lazy getters in config.ts so reads happen
  // after this call, not at import time.
  dotenvConfig({ path, override: true, quiet: true });
}
