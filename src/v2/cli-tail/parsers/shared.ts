/**
 * Shared helpers used by individual CLI tail parsers.
 *
 * Parsers operate on session-log file paths returned by `discovery.ts`.
 * Some CLIs (gemini, kimi, cursor) yield a *directory* path because their
 * log layout is multi-file; helpers here let the parser walk that dir and
 * read NDJSON / JSON / plain-text payloads uniformly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TailEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type TailRole = NonNullable<TailEvent['role']>;

export function asRole(value: unknown): TailRole | undefined {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'developer'
    ? value
    : undefined;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** True iff the path resolves to a regular file. */
export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True iff the path resolves to a directory. */
export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a text file safely. Returns `null` if the file cannot be read.
 * Used by every parser to swallow transient watcher races (file deleted
 * mid-scan) without throwing.
 */
export function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Recursively collect all files in `dir` matching the optional `predicate`.
 * The result is sorted by file mtime ascending so callers replay events in
 * roughly the order they were produced. Errors at any directory level are
 * silently skipped — discovery already validated the entry point.
 */
export function walkFilesByMtime(dir: string, predicate?: (entry: string) => boolean): string[] {
  const out: { p: string; mtime: number }[] = [];

  function visit(current: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      if (!stat.isFile()) continue;
      if (predicate && !predicate(entry)) continue;
      out.push({ p: full, mtime: stat.mtimeMs });
    }
  }

  visit(dir);
  out.sort((a, b) => a.mtime - b.mtime);
  return out.map((e) => e.p);
}

// ---------------------------------------------------------------------------
// Logging — non-fatal warnings
// ---------------------------------------------------------------------------

/**
 * Emit a non-fatal parse warning to stderr.
 * The cli-tail subsystem must never throw on malformed input — broken lines
 * are skipped, but operators benefit from knowing the parser tripped.
 */
export function warnParse(parserId: string, msg: string): void {
  try {
    process.stderr.write(`[cli-tail:${parserId}] ${msg}\n`);
  } catch {
    // stderr unavailable (extremely rare, but possible in detached children)
  }
}

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

/**
 * Coerce a value into a Unix-epoch timestamp in milliseconds.
 * Accepts:
 *   - number (treated as ms unless it looks like seconds)
 *   - ISO-8601 string
 *   - any other shape → `fallback`
 */
export function toEpochMs(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: 10-digit timestamps are seconds, 13-digit are ms.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extract a flat string from a content value that may be:
 *   - a string
 *   - an array of `{ type: "text", text: "..." }` blocks (Anthropic style)
 *   - an array of strings
 *   - an array of mixed primitives + records
 *
 * Returns `undefined` if no text could be extracted.
 */
export function flattenText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;

  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (typeof part['text'] === 'string') {
      parts.push(part['text']);
      continue;
    }
    if (typeof part['content'] === 'string') {
      parts.push(part['content']);
    }
  }
  const joined = parts.join('');
  return joined.length > 0 ? joined : undefined;
}

/**
 * Try to JSON-parse a value when the upstream encoded it as a JSON string,
 * otherwise return the value untouched. Useful for tool-call argument fields
 * that some CLIs serialize as strings (codex) and others as objects.
 */
export function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Captured CLI transcript extraction
// ---------------------------------------------------------------------------

/**
 * Parse transcripts produced by `scripts/repro-cli-failures.mjs`.
 *
 * Shape:
 *   key: value
 *   ...
 *   --- stdout ---
 *   <stdout>
 *   --- stderr ---
 *   <stderr>
 *
 * These samples are not native session history, but they are intentionally
 * fed through cli-tail tests so parser drift is caught against real CLI output.
 */
export function eventsFromCapturedCliTranscript(
  parserId: string,
  buffer: string,
  fallbackTs: number,
): TailEvent[] | null {
  const stdoutMarker = '--- stdout ---';
  const stderrMarker = '--- stderr ---';
  const stdoutStart = buffer.indexOf(stdoutMarker);
  const stderrStart = buffer.indexOf(stderrMarker);
  if (stdoutStart === -1 || stderrStart === -1 || stderrStart < stdoutStart) {
    return null;
  }

  const metadata = buffer.slice(0, stdoutStart);
  let ts = fallbackTs;
  for (const rawLine of metadata.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator === -1) {
      warnParse(parserId, `malformed capture metadata line: ${line}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'captured_at' || key === 'started_at') {
      ts = toEpochMs(value, ts);
    }
  }

  const stdout = buffer.slice(stdoutStart + stdoutMarker.length, stderrStart).trim();
  const stderr = buffer.slice(stderrStart + stderrMarker.length).trim();

  const events: TailEvent[] = [];
  if (stdout.length > 0) {
    events.push({ ts, kind: 'message', role: 'assistant', text: stdout });
  }
  if (stderr.length > 0) {
    events.push({ ts, kind: 'meta', text: `stderr: ${stderr}` });
  }
  return events;
}

// ---------------------------------------------------------------------------
// NDJSON iteration
// ---------------------------------------------------------------------------

/**
 * Iterate a buffer of newline-delimited JSON, yielding one parsed object per
 * non-empty line. Malformed lines are reported via `warnParse(parserId, …)`
 * and skipped — the iterator never throws.
 *
 * NOTE: this is the line-wise variant. Buffering split mid-line chunks is the
 * caller's responsibility — sessions on disk are always flushed at line
 * boundaries by the underlying CLIs we support, so for file-based parsing we
 * rely on `\n` boundaries being intact.
 */
export function* iterateNdjson(
  parserId: string,
  buffer: string,
): IterableIterator<Record<string, unknown>> {
  for (const rawLine of buffer.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnParse(parserId, `skipping malformed JSON line (${line.length} chars)`);
      continue;
    }
    if (!isRecord(parsed)) continue;
    yield parsed;
  }
}
