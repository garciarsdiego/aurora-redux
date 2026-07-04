/**
 * Opencode model registry sync.
 *
 * Wave C / Agent Q (2026-05-09 → 2026-05-10) — replaces the deprecated vault
 * env-injection plan that used to live in this slot. Opencode handles its own
 * authentication; what Aurora actually needs is a deterministic snapshot of
 * "which models can I name when spawning `opencode session/new --model <X>`".
 *
 * Strategy: shell out to `opencode models` once (on demand), parse the
 * newline-separated `provider/model` list, cache the result for one hour, and
 * surface the entries to Aurora's existing model catalog so the dashboard /
 * MCP picker can show OpenCode-routable models alongside live Omniroute and
 * the curated CSV catalog.
 *
 * This file deliberately:
 *   - NEVER throws on a missing or failing `opencode` binary — Aurora must
 *     keep working without opencode installed. Errors degrade to an empty
 *     array plus a warning logged through `console.warn`.
 *   - NEVER stores secrets. `opencode models` does not emit auth material;
 *     even if it did, only the `provider/model` shape is preserved.
 *   - NEVER triggers a background refresh. The cache is lazily populated on
 *     first `listOpencodeModels()` call and refreshed only via explicit
 *     `refreshOpencodeModels()` or after the TTL elapses on the next read.
 *   - DOES sanity-cap parsing at 5000 entries so a runaway binary cannot
 *     fill memory. Today's real output is ~836 lines — ample headroom.
 *
 * The integration with Aurora's catalog lives in
 * `src/repl/services/modelCatalog.ts` (see `mergeOpencodeModels` and the
 * `'opencode'` source tag added in the same wave).
 */

import { spawn } from 'node:child_process';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface OpencodeModelEntry {
  /** Canonical id as printed by `opencode models`, e.g. `opencode/big-pickle`. */
  readonly id: string;
  /** Prefix before the first `/`, e.g. `opencode` or `anthropic`. */
  readonly provider: string;
  /** Suffix after the first `/`, e.g. `claude-haiku-4-5`. */
  readonly model: string;
  /** Always 'opencode' so consumers can filter / badge entries from this source. */
  readonly source: 'opencode';
  /**
   * True when the entry comes from a successful `opencode models` call.
   * Reserved for a future probing layer that may flip this to `false` for
   * entries `opencode auth` reports as missing credentials.
   */
  readonly available: true;
}

export interface ListOpencodeModelsOptions {
  /** Path or basename of the opencode binary. Defaults to OMNIFORGE_OPENCODE_BIN || 'opencode'. */
  readonly binPath?: string;
  /** Hard timeout for the spawn. Defaults to 15 seconds. */
  readonly timeoutMs?: number;
  /** Bypass the in-memory cache. */
  readonly force?: boolean;
}

interface CacheSlot {
  readonly fetchedAt: number;
  readonly entries: readonly OpencodeModelEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 5_000;
const ENV_BIN = 'OMNIFORGE_OPENCODE_BIN';
const DEFAULT_BIN = 'opencode';

// ─────────────────────────────────────────────────────────────────────────────
// Internal cache (in-memory only — no DB persistence by design)
// ─────────────────────────────────────────────────────────────────────────────

let cache: CacheSlot | null = null;

/** Test-only: clear the in-memory cache. */
export function _clearOpencodeModelsCache(): void {
  cache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the raw `opencode models` stdout into a deduplicated entry list.
 * Exposed for unit tests that prefer to validate parsing without spawning.
 *
 * - Lines without `/` are skipped (header lines, status messages).
 * - Lines with whitespace get the leading/trailing whitespace trimmed.
 * - Empty lines are skipped.
 * - Duplicates collapse to the first occurrence (preserves declared order).
 * - Caps at MAX_ENTRIES so a runaway binary cannot exhaust memory.
 */
export function parseOpencodeModelsOutput(stdout: string): OpencodeModelEntry[] {
  const seen = new Set<string>();
  const out: OpencodeModelEntry[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    if (out.length >= MAX_ENTRIES) break;

    const line = rawLine.trim();
    if (line.length === 0) continue;

    const slashIdx = line.indexOf('/');
    if (slashIdx <= 0 || slashIdx >= line.length - 1) continue;

    if (seen.has(line)) continue;
    seen.add(line);

    out.push({
      id: line,
      provider: line.slice(0, slashIdx),
      model: line.slice(slashIdx + 1),
      source: 'opencode',
      available: true,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn + capture
// ─────────────────────────────────────────────────────────────────────────────

interface SpawnResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason?: string;
}

function spawnOpencodeModels(binPath: string, timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(binPath, ['models'], { shell: false, windowsHide: true });
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: '',
        reason: `spawn threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const finish = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({
        ok: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        reason: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on('error', (err: Error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        reason: `spawn error: ${err.message}`,
      });
    });

    proc.on('close', (code: number | null) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) {
        finish({ ok: true, stdout, stderr });
      } else {
        finish({
          ok: false,
          stdout,
          stderr,
          reason: `exit code ${code ?? 'null'}`,
        });
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function resolveBin(opts: ListOpencodeModelsOptions): string {
  if (opts.binPath && opts.binPath.length > 0) return opts.binPath;
  const fromEnv = process.env[ENV_BIN];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_BIN;
}

function resolveTimeoutMs(opts: ListOpencodeModelsOptions): number {
  if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
    return Math.min(opts.timeoutMs, 60_000);
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * List the models opencode currently exposes.
 *
 * - Cached for one hour after a successful fetch.
 * - Returns `[]` (and logs a warning) on any failure: missing binary, non-zero
 *   exit, timeout, spawn error, or empty output.
 * - Pass `{ force: true }` to bypass the cache.
 */
export async function listOpencodeModels(
  opts: ListOpencodeModelsOptions = {},
): Promise<OpencodeModelEntry[]> {
  if (!opts.force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return [...cache.entries];
  }

  const bin = resolveBin(opts);
  const timeoutMs = resolveTimeoutMs(opts);

  const result = await spawnOpencodeModels(bin, timeoutMs);
  if (!result.ok) {
    // Aurora must continue without opencode. Log a single warning, return [].
    const detail = result.reason ?? 'unknown failure';
    const stderrSnippet = result.stderr.trim().slice(0, 200);
    const tail = stderrSnippet.length > 0 ? ` (stderr: ${stderrSnippet})` : '';
    // eslint-disable-next-line no-console
    console.warn(`[opencode-sync] '${bin} models' failed: ${detail}${tail}`);
    return [];
  }

  const entries = parseOpencodeModelsOutput(result.stdout);
  if (entries.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[opencode-sync] '${bin} models' returned no parseable entries`);
    return [];
  }

  cache = Object.freeze({
    fetchedAt: Date.now(),
    entries: Object.freeze(entries.slice()) as readonly OpencodeModelEntry[],
  });
  return [...entries];
}

/**
 * Force a fresh fetch and return the new entry list. Convenience wrapper used
 * by the MCP `omniforge_opencode_sync_models` tool to expose explicit refresh.
 */
export async function refreshOpencodeModels(
  opts: Omit<ListOpencodeModelsOptions, 'force'> = {},
): Promise<OpencodeModelEntry[]> {
  return listOpencodeModels({ ...opts, force: true });
}

/** Last successful fetch timestamp (ms epoch), or null if never fetched. */
export function getOpencodeModelsFetchedAt(): number | null {
  return cache?.fetchedAt ?? null;
}
