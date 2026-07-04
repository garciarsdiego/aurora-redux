// Contextual autocomplete for REPL input — 5 built-in completers per D-H2.022.
// Each completer accepts a partial token (chars typed for the current arg) plus a
// CompleterCtx (db handle, workspace, current model). Returns a sorted list of
// Completion suggestions. Each call is bounded by a 500ms timeout via Promise.race
// so a slow DB or filesystem can never freeze the REPL.
// See docs/plans/REPL-LEVEL-D.md § 6 (autocomplete) + MB phase.
//
// Threat model:
//   - filePathCompleter MUST refuse path traversal — uses path.relative() to
//     verify the resolved candidate stays inside the workspace dir.
//   - All completers fail open (return []) on any error so a broken provider
//     never blocks input.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { listPatternsByWorkspace } from '../../db/persist.js';
import type { ArgType } from '../commands/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Completion {
  readonly value: string;
  readonly hint?: string;
  readonly priority?: number;
}

export interface CompleterCtx {
  readonly db?: Database.Database;
  readonly workspace: string;
  readonly model: string;
}

export type Completer = (
  partial: string,
  ctx: CompleterCtx,
) => Promise<readonly Completion[]>;

const COMPLETER_TIMEOUT_MS = 500;
const MAX_RESULTS = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. On timeout, resolve with [] so the UI never
 * stalls. Failures inside the inner promise are swallowed for the same reason —
 * the user is mid-typing and a noisy error would be hostile.
 */
async function withTimeout<T extends readonly Completion[]>(
  inner: Promise<T>,
  ms: number = COMPLETER_TIMEOUT_MS,
): Promise<readonly Completion[]> {
  const timeout = new Promise<readonly Completion[]>((resolve) => {
    setTimeout(() => resolve([]), ms);
  });
  try {
    return await Promise.race([inner, timeout]);
  } catch {
    return [];
  }
}

function startsWithCI(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  return haystack.toLowerCase().startsWith(needle.toLowerCase());
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

function workspaceRoot(workspace: string): string {
  return path.join(process.cwd(), 'workspaces', workspace);
}

/**
 * Resolve `rel` against the workspace root and reject anything that escapes the
 * sandbox. Returns null on traversal attempts. Mirrors the contract of the
 * homonymous helper in src/v2/tools/core/index.ts so file completers stay safe
 * even if the LLM eventually drives autocomplete via tool calls.
 */
export function resolveSafeWorkspacePath(rel: string, workspace: string): string | null {
  const root = path.resolve(workspaceRoot(workspace));
  const candidate = path.isAbsolute(rel) || /^[A-Za-z]:[/\\]/.test(rel)
    ? path.resolve(rel)
    : path.resolve(root, rel);
  const inside = path.relative(root, candidate);
  if (inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return candidate;
}

// ---------------------------------------------------------------------------
// 1. workspaceCompleter
// ---------------------------------------------------------------------------

export const workspaceCompleter: Completer = (partial, _ctx) =>
  withTimeout(workspaceCompleterImpl(partial));

async function workspaceCompleterImpl(partial: string): Promise<readonly Completion[]> {
  const root = path.join(process.cwd(), 'workspaces');
  let entries: readonly string[];
  try {
    const raw = await fs.readdir(root, { withFileTypes: true });
    entries = raw.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const matches = entries
    .filter((name) => startsWithCI(name, partial))
    .sort()
    .slice(0, MAX_RESULTS)
    .map<Completion>((name) => ({ value: name, hint: 'workspace' }));
  return matches;
}

// ---------------------------------------------------------------------------
// 2. workflowIdCompleter
// ---------------------------------------------------------------------------

interface WorkflowRow {
  id: string;
  objective: string;
  status: string;
}

export const workflowIdCompleter: Completer = (partial, ctx) =>
  withTimeout(workflowIdCompleterImpl(partial, ctx));

async function workflowIdCompleterImpl(
  partial: string,
  ctx: CompleterCtx,
): Promise<readonly Completion[]> {
  if (!ctx.db) return [];
  const like = `${partial}%`;
  let rows: readonly WorkflowRow[];
  try {
    rows = ctx.db
      .prepare(
        `SELECT id, objective, status FROM workflows
         WHERE id != '_daemon' AND workspace = ? AND id LIKE ?
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(ctx.workspace, like) as readonly WorkflowRow[];
  } catch {
    return [];
  }
  return rows.map<Completion>((row) => ({
    value: row.id,
    hint: `${truncate(row.objective ?? '', 40)} · ${row.status}`,
  }));
}

// ---------------------------------------------------------------------------
// 3. filePathCompleter
// ---------------------------------------------------------------------------

export const filePathCompleter: Completer = (partial, ctx) =>
  withTimeout(filePathCompleterImpl(partial, ctx));

async function filePathCompleterImpl(
  partial: string,
  ctx: CompleterCtx,
): Promise<readonly Completion[]> {
  // Split the partial into "directory portion" (already typed) and "name prefix"
  // (the in-flight token we're filtering against).
  const lastSlash = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'));
  const dirPart = lastSlash >= 0 ? partial.slice(0, lastSlash + 1) : '';
  const namePart = lastSlash >= 0 ? partial.slice(lastSlash + 1) : partial;

  const resolved = resolveSafeWorkspacePath(dirPart || '.', ctx.workspace);
  if (resolved === null) return [];

  // Node 24 returns Dirent<NonSharedBuffer>[] by default for the 2-arg overload;
  // explicitly pass `encoding: 'utf8'` to get Dirent<string>[] (.name is string).
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return [];
  }

  const matches = entries
    .filter((e) => startsWithCI(e.name, namePart))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_RESULTS)
    .map<Completion>((e) => ({
      value: dirPart + e.name + (e.isDirectory() ? '/' : ''),
      hint: e.isDirectory() ? 'dir/' : 'file',
    }));
  return matches;
}

// ---------------------------------------------------------------------------
// 4. patternNameCompleter
// ---------------------------------------------------------------------------

export const patternNameCompleter: Completer = (partial, ctx) =>
  withTimeout(patternNameCompleterImpl(partial, ctx));

async function patternNameCompleterImpl(
  partial: string,
  ctx: CompleterCtx,
): Promise<readonly Completion[]> {
  if (!ctx.db) return [];
  let patterns: ReturnType<typeof listPatternsByWorkspace>;
  try {
    patterns = listPatternsByWorkspace(ctx.db, ctx.workspace);
  } catch {
    return [];
  }
  return patterns
    .filter((p) => startsWithCI(p.name, partial))
    .slice(0, MAX_RESULTS)
    .map<Completion>((p) => ({
      value: p.name,
      hint: truncate(p.objective_sample ?? '', 40),
    }));
}

// ---------------------------------------------------------------------------
// 5. modelIdCompleter
// ---------------------------------------------------------------------------

const PROVIDER_MATRIX_PATH = path.join('docs', '08-AI-PROVIDER-MATRIX.csv');

interface CsvRow {
  readonly id: string;
  readonly tier: string;
}

let _csvCache: { mtimeMs: number; rows: readonly CsvRow[] } | null = null;

async function loadProviderMatrix(): Promise<readonly CsvRow[]> {
  const abs = path.resolve(PROVIDER_MATRIX_PATH);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    return [];
  }
  if (_csvCache && _csvCache.mtimeMs === stat.mtimeMs) {
    return _csvCache.rows;
  }
  let raw: string;
  try {
    raw = await fs.readFile(abs, 'utf8');
  } catch {
    return [];
  }
  const rows = parseProviderCsv(raw);
  _csvCache = { mtimeMs: stat.mtimeMs, rows };
  return rows;
}

/**
 * Minimal CSV parser tailored to docs/08-AI-PROVIDER-MATRIX.csv.
 * Skips the header row, ignores empty lines, and extracts:
 *   col 0 → model id (e.g. "cc/claude-opus-4-7")
 *   col 5 → tier ("S+", "S", "A", "B+", "C", ...)
 * Quoted fields are NOT supported (the source file uses unquoted commas only).
 */
export function parseProviderCsv(raw: string): readonly CsvRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // Drop the header row.
  const dataLines = lines.slice(1);
  const out: CsvRow[] = [];
  for (const line of dataLines) {
    const cols = line.split(',');
    if (cols.length < 6) continue;
    const id = cols[0]?.trim() ?? '';
    const tier = cols[5]?.trim() ?? '';
    if (id.length === 0) continue;
    out.push({ id, tier });
  }
  return out;
}

export const modelIdCompleter: Completer = (partial, _ctx) =>
  withTimeout(modelIdCompleterImpl(partial));

async function modelIdCompleterImpl(partial: string): Promise<readonly Completion[]> {
  const rows = await loadProviderMatrix();
  return rows
    .filter((r) => startsWithCI(r.id, partial))
    .slice(0, MAX_RESULTS)
    .map<Completion>((r) => ({
      value: r.id,
      hint: r.tier ? `tier ${r.tier}` : undefined,
    }));
}

// ---------------------------------------------------------------------------
// Resolver: ArgType → Completer
// ---------------------------------------------------------------------------

const COMPLETER_BY_ARG_TYPE: Readonly<Partial<Record<ArgType, Completer>>> = {
  workspace_name: workspaceCompleter,
  workflow_id: workflowIdCompleter,
  file_path: filePathCompleter,
  pattern_name: patternNameCompleter,
  model_id: modelIdCompleter,
};

export function getCompleterForArgType(type: ArgType): Completer | undefined {
  return COMPLETER_BY_ARG_TYPE[type];
}

/**
 * Public registry — kept for backward compat with the M0 placeholder shape.
 * New code should import the functions directly or use getCompleterForArgType.
 */
export const completers = {
  workspace: workspaceCompleter,
  workflowId: workflowIdCompleter,
  filePath: filePathCompleter,
  patternName: patternNameCompleter,
  modelId: modelIdCompleter,
} as const;
