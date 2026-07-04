/**
 * Workspace hygiene helpers — back up + restore stale stubs from prior attempts.
 *
 * The retry-loop bug we hit on 2026-05-04: the CLI worker reads a stub that the
 * previous attempt wrote, declares "already exists, looks correct", and never
 * calls Write. By moving prior outputs to `.attempt_N.bak` before the next
 * retry, the cli's Read call returns ENOENT, forcing it to actually write.
 */

import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export interface BackupResult {
  /** Original path that was renamed. */
  originalPath: string;
  /** New `.attempt_N.bak` location. */
  backupPath: string;
}

export interface BackupOptions {
  /** Retry attempt that just failed. The new backup gets this index. */
  retryCount: number;
  /** Skip files larger than this. Useful for `node_modules` / big binaries. */
  maxBytes?: number;
}

/**
 * Move a single file out of the way before retry, returning where it landed.
 *
 * Returns null when the file does not exist (no-op) or exceeds the byte cap.
 * Never throws — errors are logged via the caller's context.
 */
export function backupFileForRetry(
  absolutePath: string,
  options: BackupOptions,
): BackupResult | null {
  if (!existsSync(absolutePath)) return null;
  const stats = statSync(absolutePath);
  if (!stats.isFile()) return null;
  if (options.maxBytes && stats.size > options.maxBytes) return null;
  const backupPath = `${absolutePath}.attempt_${options.retryCount}.bak`;
  // Idempotent: if a backup with this name already exists (e.g. duplicate
  // call), bail out rather than clobbering historical evidence.
  if (existsSync(backupPath)) return { originalPath: absolutePath, backupPath };
  mkdirSync(path.dirname(backupPath), { recursive: true });
  renameSync(absolutePath, backupPath);
  return { originalPath: absolutePath, backupPath };
}

/**
 * Convenience: backup multiple paths (relative-to-workspace or absolute) at once.
 * Failures on individual paths are silenced — workspace hygiene is best-effort.
 */
export function backupFilesForRetry(
  workspaceDir: string,
  relPaths: readonly string[],
  options: BackupOptions,
): BackupResult[] {
  const out: BackupResult[] = [];
  for (const rel of relPaths) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(workspaceDir, rel);
    try {
      const result = backupFileForRetry(abs, options);
      if (result) out.push(result);
    } catch {
      // best-effort
    }
  }
  return out;
}
