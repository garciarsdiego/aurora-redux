/**
 * Per-CLI session discovery layer.
 * Locates the active/most-recent session file for each supported CLI agent
 * so that the tail subsystem can stream its output.
 *
 * Supported CLIs:
 *   codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   claude-code  ~/.claude/projects/<sanitized-cwd>/*.jsonl
 *   gemini       ~/.gemini/history/<YYYYMMDD-HHMMSS>/  (most-recent dir)
 *   kimi         ~/.kimi/sessions/<workspace>/<session>/ (most-recent)
 *   cursor       ~/.cursor/chats/<chat-id>/             (most-recent after task start)
 *   opencode     returns null — opencode does not produce a stable session log path
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read immediate children of a directory, returning [] on any error. */
function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Return stat mtime in ms, or 0 on error. */
function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Return true if path exists and is a file. */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Return true if path exists and is a directory. */
function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Sanitize a cwd path the same way claude-code does when naming its project dir:
 * replaces path separators and colons with dashes, lowercases, strips leading dash.
 *
 * Claude Code stores projects under ~/.claude/projects/<sanitized-cwd>/
 * where sanitized-cwd = absolute path with slashes and colons → '-', leading '-' stripped.
 * E.g. /home/user/my-project → -home-user-my-project → home-user-my-project
 */
function sanitizeCwd(cwd: string): string {
  // Normalize to forward slashes, replace path separators + colons with '-'
  const normalized = cwd.replace(/\\/g, "/").replace(/[/:]/g, "-");
  // Strip leading dash
  return normalized.replace(/^-+/, "");
}

// ---------------------------------------------------------------------------
// Per-CLI finders
// ---------------------------------------------------------------------------

/**
 * codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * Returns the rollout-*.jsonl file whose mtime is >= taskStartedAt.
 * If multiple qualify, returns the one with the largest mtime (most recent).
 */
function findCodexSession(taskStartedAt: number): string | null {
  const base = path.join(os.homedir(), ".codex", "sessions");
  if (!isDir(base)) return null;

  const candidates: { p: string; mtime: number }[] = [];

  for (const year of safeReaddir(base)) {
    const yearDir = path.join(base, year);
    if (!isDir(yearDir)) continue;
    for (const month of safeReaddir(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!isDir(monthDir)) continue;
      for (const day of safeReaddir(monthDir)) {
        const dayDir1 = path.join(yearDir, month, day);
        for (const entry of safeReaddir(dayDir1)) {
          if (!entry.startsWith("rollout-") || !entry.endsWith(".jsonl")) continue;
          const full = path.join(dayDir1, entry);
          const mtime = safeMtime(full);
          if (mtime >= taskStartedAt) {
            candidates.push({ p: full, mtime });
          }
        }
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].p;
}

/**
 * claude-code: ~/.claude/projects/<sanitized-cwd>/*.jsonl
 * Returns the most-recently modified .jsonl in the project dir that matches cwd.
 * Falls back to most-recent across all project dirs if cwd is not provided.
 */
function findClaudeCodeSession(taskStartedAt: number, cwd?: string): string | null {
  const projectsBase = path.join(os.homedir(), ".claude", "projects");
  if (!isDir(projectsBase)) return null;

  const dirsToSearch: string[] = [];

  if (cwd) {
    const sanitized = sanitizeCwd(cwd);
    const specific = path.join(projectsBase, sanitized);
    if (isDir(specific)) {
      dirsToSearch.push(specific);
    }
  }

  // If specific dir not found or cwd not provided, search all project dirs
  if (dirsToSearch.length === 0) {
    for (const entry of safeReaddir(projectsBase)) {
      const full = path.join(projectsBase, entry);
      if (isDir(full)) dirsToSearch.push(full);
    }
  }

  const candidates: { p: string; mtime: number }[] = [];
  for (const dir of dirsToSearch) {
    for (const entry of safeReaddir(dir)) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = path.join(dir, entry);
      if (!isFile(full)) continue;
      const mtime = safeMtime(full);
      if (mtime >= taskStartedAt) {
        candidates.push({ p: full, mtime });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].p;
}

/**
 * gemini: ~/.gemini/history/<YYYYMMDD-HHMMSS>/
 * Returns the path to the most-recently modified directory (session dir).
 * The caller is expected to find the log file inside that dir.
 *
 * Returns the directory path, not a specific file, because the internal
 * structure may vary. Callers should read files inside the returned dir.
 */
function findGeminiSession(taskStartedAt: number): string | null {
  const historyBase = path.join(os.homedir(), ".gemini", "history");
  if (!isDir(historyBase)) return null;

  // Dir names look like YYYYMMDD-HHMMSS
  const dirPattern = /^\d{8}-\d{6}$/;
  const candidates: { p: string; mtime: number }[] = [];

  for (const entry of safeReaddir(historyBase)) {
    if (!dirPattern.test(entry)) continue;
    const full = path.join(historyBase, entry);
    if (!isDir(full)) continue;
    const mtime = safeMtime(full);
    if (mtime >= taskStartedAt) {
      candidates.push({ p: full, mtime });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].p;
}

/**
 * kimi: ~/.kimi/sessions/<workspace>/<session>/
 * Returns the path to the most-recently modified session directory.
 */
function findKimiSession(taskStartedAt: number): string | null {
  const sessionsBase = path.join(os.homedir(), ".kimi", "sessions");
  if (!isDir(sessionsBase)) return null;

  const candidates: { p: string; mtime: number }[] = [];

  for (const workspace of safeReaddir(sessionsBase)) {
    const workspaceDir = path.join(sessionsBase, workspace);
    if (!isDir(workspaceDir)) continue;
    for (const session of safeReaddir(workspaceDir)) {
      const sessionDir = path.join(workspaceDir, session);
      if (!isDir(sessionDir)) continue;
      const mtime = safeMtime(sessionDir);
      if (mtime >= taskStartedAt) {
        candidates.push({ p: sessionDir, mtime });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].p;
}

/**
 * cursor: ~/.cursor/chats/<chat-id>/
 * Returns the path to the most-recently modified chat directory after taskStartedAt.
 */
function findCursorSession(taskStartedAt: number): string | null {
  const chatsBase = path.join(os.homedir(), ".cursor", "chats");
  if (!isDir(chatsBase)) return null;

  const candidates: { p: string; mtime: number }[] = [];

  for (const chatId of safeReaddir(chatsBase)) {
    const chatDir = path.join(chatsBase, chatId);
    if (!isDir(chatDir)) continue;
    const mtime = safeMtime(chatDir);
    if (mtime >= taskStartedAt) {
      candidates.push({ p: chatDir, mtime });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].p;
}

/**
 * opencode: returns null.
 * opencode does not currently produce a stable, discoverable session log path.
 * TODO: revisit when opencode session log format is documented.
 */
function findOpencodeSession(_taskStartedAt: number): null {
  // opencode does not expose a stable session log path — return null intentionally.
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the active (or most-recently created) session path for the given CLI.
 *
 * @param cliId        One of: "codex" | "claude-code" | "gemini" | "kimi" | "cursor" | "opencode"
 * @param taskStartedAt  Unix epoch ms — only sessions created/modified at or after
 *                       this timestamp are considered.
 * @param cwd          Optional working directory (used by claude-code to locate project dir).
 * @returns            Absolute path to the session file/directory, or null if not found.
 */
export function findActiveSession(
  cliId: string,
  taskStartedAt: number,
  cwd?: string
): string | null {
  switch (cliId) {
    case "codex":
      return findCodexSession(taskStartedAt);
    case "claude-code":
      return findClaudeCodeSession(taskStartedAt, cwd);
    case "gemini":
      return findGeminiSession(taskStartedAt);
    case "kimi":
      return findKimiSession(taskStartedAt);
    case "cursor":
      return findCursorSession(taskStartedAt);
    case "opencode":
      return findOpencodeSession(taskStartedAt);
    default:
      return null;
  }
}
