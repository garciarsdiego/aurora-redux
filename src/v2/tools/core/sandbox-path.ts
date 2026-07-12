// Shared workspace-sandbox path resolution. Previously duplicated
// byte-for-byte across index.ts, grep.ts and glob.ts (plus a boolean-return
// variant in apply-patch.ts) — consolidated here so any future sandbox fix
// applies to all call sites at once.

import path from 'node:path';

/**
 * Resolve an LLM-supplied path against `root` and ensure the resolved
 * location stays inside the sandbox. Absolute paths (including Windows
 * drive-letter paths) are accepted only when they already lie under `root`.
 */
export function resolveSafeWorkspacePath(rawPath: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.isAbsolute(rawPath) || /^[A-Za-z]:[/\\]/.test(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(resolvedRoot, rawPath);
  const rel = path.relative(resolvedRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace sandbox: ${rawPath} (resolved=${candidate}, root=${resolvedRoot})`);
  }
  return candidate;
}

/** Boolean-returning variant of resolveSafeWorkspacePath for callers that just need a guard check. */
export function pathEscapesWorkspace(rawPath: string, root: string): boolean {
  try {
    resolveSafeWorkspacePath(rawPath, root);
    return false;
  } catch {
    return true;
  }
}
