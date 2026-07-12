// Per-workspace history (D-H2.028): workspaces/<ws>/.repl-history (chmod 0600).
// Format: JSONL append-only. Last 1000 entries returned. Rotation at 10MB FIFO.
// Redaction applied before every write via utils/redaction.ts (G5 BLOCKER).
// Workspace name is validated against an allowlist regex BEFORE any path
// resolve to block traversal (../, absolute paths, NUL bytes, etc.).

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { redact } from '../utils/redaction.js';
import { errorMessage } from '../utils/errors.js';
import { HISTORY_RING_CAP, HISTORY_MAX_BYTES } from '../config.js';

export interface HistoryEntry {
  readonly ts: number;
  readonly raw: string;
  readonly category: string;
}

// Mirrors src/utils/workspace.ts allowlist. Inlined to avoid pulling dotenv
// into the REPL bundle just for a regex check.
const VALID_WORKSPACE_RE = /^[a-zA-Z0-9_-]+$/;

function assertValidWorkspace(workspace: string): void {
  if (typeof workspace !== 'string' || !VALID_WORKSPACE_RE.test(workspace)) {
    throw new Error(
      `Invalid workspace name '${workspace}'. ` +
        `Allowed: alphanumeric, underscore, hyphen. ` +
        `No path separators, dots, or whitespace.`,
    );
  }
}

function historyFilePath(workspace: string): string {
  assertValidWorkspace(workspace);
  return path.join(process.cwd(), 'workspaces', workspace, '.repl-history');
}

function rotatedFilePath(workspace: string, suffix: '.1' | '.2'): string {
  return historyFilePath(workspace) + suffix;
}

/** Narrow an unknown catch value to a Node ENOENT filesystem error. */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    process.stderr.write(
      `[history] warn: failed to unlink ${p}: ${errorMessage(err)}\n`,
    );
  }
}

/**
 * Append one entry to the workspace history file.
 * Applies redaction before writing. chmod 0600 best-effort (no-op on Windows).
 * Triggers rotation BEFORE the write if the file is over HISTORY_MAX_BYTES.
 */
export async function appendHistoryEntry(
  workspace: string,
  entry: HistoryEntry,
): Promise<void> {
  const filePath = historyFilePath(workspace);

  await rotateHistoryIfNeeded(workspace);

  const redacted: HistoryEntry = { ...entry, raw: redact(entry.raw) };
  const line = JSON.stringify(redacted) + '\n';

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, { encoding: 'utf8' });

  try {
    await fs.chmod(filePath, 0o600);
  } catch (err: unknown) {
    // Best-effort: Windows does not support POSIX chmod. Surface as a
    // non-fatal warning so test harnesses can verify it ran (D-H2.028 G5).
    if (process.platform !== 'win32') {
      process.stderr.write(
        `[history] warn: chmod 0600 failed: ${errorMessage(err)}\n`,
      );
    }
  }
}

/**
 * Load up to HISTORY_RING_CAP entries from the workspace history file.
 * Skips malformed lines with a stderr warning. Returns [] if file missing.
 */
export async function loadHistoryEntries(
  workspace: string,
): Promise<readonly HistoryEntry[]> {
  const filePath = historyFilePath(workspace);

  let content: string;
  try {
    content = await fs.readFile(filePath, { encoding: 'utf8' });
  } catch (err: unknown) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const entries: HistoryEntry[] = [];

  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as Record<string, unknown>)['ts'] === 'number' &&
        typeof (parsed as Record<string, unknown>)['raw'] === 'string' &&
        typeof (parsed as Record<string, unknown>)['category'] === 'string'
      ) {
        entries.push(parsed as HistoryEntry);
      } else {
        process.stderr.write(`[history] skipping malformed line: ${line}\n`);
      }
    } catch {
      process.stderr.write(`[history] skipping unparseable line: ${line}\n`);
    }
  }

  // Return last HISTORY_RING_CAP entries (most recent).
  return entries.slice(-HISTORY_RING_CAP);
}

/**
 * If the history file exceeds HISTORY_MAX_BYTES, rotate it FIFO-style:
 *   - delete .repl-history.2 if it exists (cleanup of any leftover state),
 *   - delete the previous .repl-history.1 if it exists (we keep only one
 *     backup at a time per D-H2.028 — "FIFO with cap=1 backup"),
 *   - rename current → .repl-history.1.
 *
 * Returns true if rotation happened, false if it was a no-op.
 */
export async function rotateHistoryIfNeeded(
  workspace: string,
): Promise<boolean> {
  const filePath = historyFilePath(workspace);
  const r1 = rotatedFilePath(workspace, '.1');
  const r2 = rotatedFilePath(workspace, '.2');

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(filePath);
  } catch (err: unknown) {
    if (isEnoent(err)) return false;
    throw err;
  }

  if (stat.size <= HISTORY_MAX_BYTES) return false;

  // Cleanup any stale .2 from older code paths first, then drop the previous
  // backup so the rename below is atomic on Windows (rename across an existing
  // target throws EEXIST on win32). safeUnlink tolerates missing files.
  await safeUnlink(r2);
  await safeUnlink(r1);

  try {
    await fs.rename(filePath, r1);
  } catch (err: unknown) {
    process.stderr.write(
      `[history] warn: rotation rename failed: ${errorMessage(err)}\n`,
    );
    return false;
  }

  return true;
}

/**
 * Delete the history file for a workspace (used by /reset).
 * Does not touch rotated backups.
 */
export async function clearHistory(workspace: string): Promise<void> {
  const filePath = historyFilePath(workspace);
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    throw err;
  }
}
