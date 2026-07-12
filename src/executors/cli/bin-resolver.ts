// =============================================================================
// bin-resolver.ts — locate the right binary for each supported CLI.
//
// Scope:
//   • Memoize "where is `claude.cmd` on this box" lookups for the daemon
//     lifetime (saves a few-hundred-ms spawn of `--version` on every task).
//   • Prefer the highest-semver install when multiple shims exist.
//   • Handle Windows-specific install locations: %APPDATA%\npm, C:\npm-global,
//     %USERPROFILE%\.local\bin, %LOCALAPPDATA%\OpenAI\Codex\bin, etc.
//
// IMPORTANT — preserve EVERY load-bearing comment around claudeBin():
// native claude.exe (~250 MB Bun bundle) hits spawn ENOENT in detached
// daemons (round 6 of the 12-round saga, 2026-04-30); we deliberately
// prefer the .cmd shim and only fall back to .exe when no shim exists.
// resolveSpawnTarget downstream picks tier-A/B/C/D based on this choice;
// removing the bias here re-introduces ENOENT for daemon-spawned children.
// =============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { resolveSpawnTarget } from './spawn-common.js';

export function resolveExistingBinary(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && existsSync(candidate)) return candidate;
  }
  const pathEntries = (process.env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const dir of pathEntries) {
    for (const candidate of candidates) {
      if (isAbsolute(candidate)) continue;
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

// Locations where Example (and most Windows operators) install npm-style CLI
// shims. Custom prefix `C:\npm-global` is in this list because operators who
// run `npm config set prefix` to keep packages out of %APPDATA% land there.
export function commonNpmShimDirs(): string[] {
  if (process.platform !== 'win32') return [];
  const dirs: string[] = [];
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'));
  dirs.push('C:\\npm-global');
  return dirs;
}

export function userLocalBin(): string | null {
  if (process.platform !== 'win32') return null;
  const profile = process.env.USERPROFILE;
  return profile ? join(profile, '.local', 'bin') : null;
}

// ============================================================================
// Latest-version selection — when multiple installs of the same CLI exist
// (e.g. claude.exe at ~/.local/bin AND claude.cmd at %APPDATA%\npm), prefer
// the one reporting the highest semver via `<bin> --version`. Per-CLI bin
// resolution is memoized for the daemon lifetime so the version-query cost
// is paid at most once per CLI per restart.
// ============================================================================

function parseSemverTuple(s: string): number[] | null {
  // Best-effort: scan for X.Y.Z anywhere in the version output string.
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function compareSemverTuple(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function querySemver(bin: string, timeoutMs = 4000): number[] | null {
  // Defer to resolveSpawnTarget so .cmd shims and cursor-agent's versioned
  // layout are handled correctly. spawnSync is synchronous — used only at
  // bin resolution time (memoized), never on the hot path of a workflow.
  let executable: string;
  let finalArgs: string[];
  let verbatim: boolean;
  try {
    const r = resolveSpawnTarget(bin, ['--version']);
    executable = r.executable;
    finalArgs = r.finalArgs;
    verbatim = r.windowsVerbatimArguments;
  } catch {
    return null;
  }
  let result;
  try {
    result = spawnSync(executable, finalArgs, {
      shell: false,
      stdio: 'pipe',
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1' },
      ...(verbatim ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    return null;
  }
  if (result.error || (result.status !== 0 && result.status != null)) return null;
  const out = (result.stdout?.toString() ?? '') + (result.stderr?.toString() ?? '');
  return parseSemverTuple(out);
}

/**
 * Pick the candidate path with the highest reported `--version`. Skips the
 * version query when only one candidate exists (the common case). Returns
 * the first existing candidate as a last-ditch fallback when every query
 * fails (e.g. the bin is broken but we still want SOMETHING to spawn).
 */
export function pickLatestVersion(candidates: string[]): string | null {
  const present = candidates.filter((c) => isAbsolute(c) && existsSync(c));
  if (present.length === 0) return null;
  if (present.length === 1) return present[0];
  let best: { bin: string; ver: number[] } | null = null;
  for (const bin of present) {
    const ver = querySemver(bin);
    if (!ver) continue;
    if (!best || compareSemverTuple(ver, best.ver) > 0) {
      best = { bin, ver };
    }
  }
  return best?.bin ?? present[0];
}

const binCache = new Map<string, string>();
function memoBin(key: string, factory: () => string): string {
  const cached = binCache.get(key);
  if (cached) return cached;
  const v = factory();
  binCache.set(key, v);
  return v;
}

// Shared config-driven pipeline for the per-CLI resolvers below. Every CLI
// except claude follows the exact same shape: env override (existsSync-gated)
// → bare name on non-win32 → latest-version pick across absolute candidates
// → PATH probe over fallback names → hardcoded default. Adding a new CLI is
// one resolveCliBinary call. claudeBin stays hand-rolled — its .cmd-over-.exe
// preference is load-bearing (see the round-6 ENOENT comments on it).
interface ResolveCliBinaryConfig {
  /** Memoization key AND the bare command returned on non-win32 platforms. */
  name: string;
  /** Env var that force-overrides resolution when it points at a real file. */
  envVar: string;
  /** win32 absolute-path candidates fed to pickLatestVersion (lazy — only
   *  evaluated on the memoized first resolution). */
  candidates?: () => string[];
  /** Names probed via resolveExistingBinary when no candidate resolves. */
  fallbackNames: string[];
  /** Last-ditch default when nothing on disk or PATH matches. */
  fallbackDefault: string;
}

function resolveCliBinary(cfg: ResolveCliBinaryConfig): string {
  return memoBin(cfg.name, () => {
    const override = process.env[cfg.envVar];
    if (override && existsSync(override)) return override;
    if (process.platform !== 'win32') return cfg.name;
    const latest = cfg.candidates ? pickLatestVersion(cfg.candidates()) : null;
    if (latest) return latest;
    return resolveExistingBinary(cfg.fallbackNames) ?? cfg.fallbackDefault;
  });
}

export function codexBin(): string {
  return resolveCliBinary({
    name: 'codex',
    envVar: 'CLI_CODEX_BIN',
    candidates: () => {
      const localAppData = process.env.LOCALAPPDATA;
      return [
        ...(localAppData ? [join(localAppData, 'OpenAI', 'Codex', 'bin', 'codex.exe')] : []),
        ...commonNpmShimDirs().map(d => join(d, 'codex.cmd')),
      ];
    },
    fallbackNames: ['codex.exe', 'codex.cmd', 'codex'],
    fallbackDefault: 'codex.exe',
  });
}

export function claudeBin(): string {
  return memoBin('claude', () => {
    const override = process.env.CLI_CLAUDE_BIN;
    if (override && existsSync(override)) return override;
    if (process.platform !== 'win32') return 'claude';
    // Example smoke test 2026-04-30 round 6: native claude.exe (a ~250 MB
    // Bun-bundled standalone at ~/.local/bin/claude.exe) reports `spawn
    // ENOENT` when invoked from the detached daemon process — even though
    // the file exists, has correct permissions, and works fine when spawned
    // from a foreground or detached Node child in our smoke tests. The
    // upstream root cause is unconfirmed (suspect Bun runtime + Windows
    // CreateProcessW interaction in some console-detached contexts).
    // Until the upstream issue is pinned, prefer the .cmd shim — proven
    // stable across all rounds 1–5 of the spawn pipeline. We still apply
    // latest-version selection ACROSS the .cmd shim installs, so operators
    // who keep newer versions in C:\npm-global vs %APPDATA%\npm get the
    // newest one. Operators who want native .exe opt in via CLI_CLAUDE_BIN.
    const cmdCandidates = commonNpmShimDirs().map(d => join(d, 'claude.cmd'));
    const latestCmd = pickLatestVersion(cmdCandidates);
    if (latestCmd) return latestCmd;
    // Fallback: try native EXE locations only if no .cmd shim found.
    const localAppData = process.env.LOCALAPPDATA;
    const localBin = userLocalBin();
    const exeCandidates = [
      ...(localBin ? [join(localBin, 'claude.exe')] : []),
      ...(localAppData ? [join(localAppData, 'AnthropicClaude', 'claude.exe')] : []),
    ];
    const exeFallback = pickLatestVersion(exeCandidates);
    if (exeFallback) return exeFallback;
    return resolveExistingBinary(['claude.cmd', 'claude.exe', 'claude']) ?? 'claude.cmd';
  });
}

// NOTE: geminiBin() was removed 2026-07-11 — dead code with zero importers.
// The gemini adapter migrated to agyBin() (Antigravity CLI) on 2026-07-04
// after gemini-cli shut down; see adapters/gemini.ts for the migration notes.

// Antigravity CLI (`agy`) — successor to the deprecated gemini-cli (shut down
// 2026-06-18). Installed at %LOCALAPPDATA%\agy\bin\agy on Windows; usually on
// PATH. Aurora-Redux uses it for the cli:gemini spawn path.
export function agyBin(): string {
  return resolveCliBinary({
    name: 'agy',
    envVar: 'CLI_AGY_BIN',
    fallbackNames: ['agy.exe', 'agy.cmd', 'agy'],
    fallbackDefault: 'agy.exe',
  });
}

export function kimiBin(): string {
  return resolveCliBinary({
    name: 'kimi',
    envVar: 'CLI_KIMI_BIN',
    candidates: () => {
      const localBin = userLocalBin();
      return [
        ...(localBin ? [join(localBin, 'kimi.exe'), join(localBin, 'kimi-cli.exe')] : []),
        ...commonNpmShimDirs().map(d => join(d, 'kimi.cmd')),
      ];
    },
    fallbackNames: ['kimi.exe', 'kimi.cmd', 'kimi'],
    fallbackDefault: 'kimi.cmd',
  });
}

export function cursorAgentBin(): string {
  return resolveCliBinary({
    name: 'cursor-agent',
    envVar: 'CLI_CURSOR_BIN',
    candidates: () => {
      const localAppData = process.env.LOCALAPPDATA;
      const localBin = userLocalBin();
      return [
        ...(localBin ? [join(localBin, 'cursor-agent.exe')] : []),
        ...(localAppData ? [
          join(localAppData, 'cursor-agent', 'cursor-agent.cmd'),
          join(localAppData, 'cursor-agent', 'agent.cmd'),
        ] : []),
        ...commonNpmShimDirs().map(d => join(d, 'cursor-agent.cmd')),
      ];
    },
    fallbackNames: [
      'cursor-agent.cmd', 'cursor-agent.exe', 'cursor-agent',
      'agent.cmd', 'agent',
    ],
    fallbackDefault: 'cursor-agent.cmd',
  });
}

export function kiloBin(): string {
  return resolveCliBinary({
    name: 'kilo',
    envVar: 'CLI_KILO_BIN',
    candidates: () => commonNpmShimDirs().map(d => join(d, 'kilo.cmd')),
    fallbackNames: ['kilo.cmd', 'kilo.exe', 'kilo'],
    fallbackDefault: 'kilo.cmd',
  });
}

export function opencodeBin(): string {
  return resolveCliBinary({
    name: 'opencode',
    envVar: 'CLI_OPENCODE_BIN',
    candidates: () => commonNpmShimDirs().map(d => join(d, 'opencode.cmd')),
    fallbackNames: ['opencode.cmd', 'opencode.exe', 'opencode'],
    fallbackDefault: 'opencode.cmd',
  });
}
