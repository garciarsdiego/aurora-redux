// =============================================================================
// spawn-common.ts — Windows .cmd handling, env vars, signal plumbing.
//
// Scope:
//   • `buildCliSpawnOptions` — the canonical SpawnOptions builder. Strips
//     CLAUDECODE so nested Claude Code invocations don't refuse; hints UTF-8
//     to children (PYTHONIOENCODING, LANG, LC_ALL); sets windowsHide:true so
//     CreateProcessW doesn't try to attach a console (the round-10 ROOT cause
//     of the 12-round ENOENT saga).
//   • `resolveSpawnTarget` — multi-candidate generation + spawnability probe.
//     Wraps cmd/bat shims with three escalating tiers (cursor-versioned →
//     npm-shim → cmd.exe-wrapped → direct) and probe-caches what works.
//
// IMPORTANT — preserve EVERY round-N comment block. They document the
// 12-round (2026-04-30) ENOENT saga whose tier-A/B/C/D fallback architecture
// is the entire reason this file exists. Removing any single comment block
// would lose institutional memory about why a future revert would re-break.
//
// Round-by-round:
//   1 (4666849) absolute claude.cmd path (was ENOENT)
//   2 (68623fe) shell:true to interpret .cmd shim (was EINVAL)
//   3 (b07a0b2) pre-resolved cmd.exe path (still ENOENT in daemon)
//   4 (12a7a63) spawn cmd.exe directly + verbatim outer-quoted command
//   5 (65fca39) bypass cmd.exe, spawn npm shim's node + cli.js
//   6 (a2c1f5b) demote claude.exe (Bun-bundled ENOENT in daemon)
//   9 (this)    multi-candidate generation + probe-cached selection
//  10           windowsHide:true (was the actual ROOT cause)
//  11           mkdir cwd before spawn (CreateProcessW ERROR_DIRECTORY → ENOENT)
//  12           strip CLAUDECODE/CLAUDE_CODE_* so nested Claude doesn't refuse
// =============================================================================

import { spawnSync, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SpawnTarget } from './types.js';

// Resolve cmd.exe to an absolute path verified at module load. Example smoke
// test 2026-04-30 (round 2): after enabling shell:true to handle .cmd shims,
// the detached daemon child got `spawn C:\Windows\system32\cmd.exe ENOENT`
// despite cmd.exe existing at that exact path. Node's shell:true delegates
// to `process.env.comspec` and on detached/orphaned children that lookup has
// occasionally returned a path that CreateProcessW then refuses. Pre-resolving
// against several known locations and verifying with existsSync gives us a
// path we can pass directly via `shell: '<path>'` (Node accepts a string for
// shell), bypassing the env lookup entirely.
function resolveCmdExePath(): string | null {
  if (process.platform !== 'win32') return null;
  const tried: string[] = [];
  const push = (p: string | undefined | null): void => {
    if (typeof p === 'string' && p.length > 0) tried.push(p);
  };
  push(process.env.ComSpec);
  push(process.env.COMSPEC);
  if (process.env.SystemRoot) {
    push(join(process.env.SystemRoot, 'System32', 'cmd.exe'));
    push(join(process.env.SystemRoot, 'system32', 'cmd.exe'));
  }
  push('C:\\Windows\\System32\\cmd.exe');
  push('C:\\Windows\\system32\\cmd.exe');
  for (const p of tried) {
    if (existsSync(p)) return p;
  }
  return null;
}

const RESOLVED_CMD_EXE: string | null = resolveCmdExePath();

if (process.platform === 'win32') {
  // Surface the resolution result once at module load so daemon logs document
  // exactly what cmd.exe (if any) the spawn path will use. This is the
  // observability hook the prior debug session lacked.
  process.stderr.write(
    `[cli-spawn] cmd.exe resolution: ${RESOLVED_CMD_EXE ?? 'NONE — will fall back to shell:true'}\n`,
  );
}

export function buildCliSpawnOptions(
  cwd?: string,
  windowsVerbatimArguments?: boolean,
  extraEnv?: Record<string, string>,
): SpawnOptionsWithoutStdio {
  // Example smoke test 2026-04-30 round 12 — second half of the saga'\''s
  // root cause. After fixing cwd-mkdir (round 11) the spawn succeeds,
  // but Claude Code fails fast with:
  //   "Claude Code cannot be launched inside another Claude Code
  //    session. ... To bypass this check, unset the CLAUDECODE
  //    environment variable."
  // The daemon inherits CLAUDECODE=1 from any Claude Code session that
  // started it (Example'\''s current testing context, my Claude Code sessions
  // running the daemon, anyone using Claude as their dev terminal). The
  // child claude.cmd then refuses to start. Strip CLAUDECODE (and the
  // sibling CLAUDE_CODE_* vars that signal nested invocation) from the
  // spawned env. Same pattern as NO_COLOR'\''s explicit set above.
  // Example smoke test 2026-05-01 — UTF-8 encoding hints for child processes:
  // gemini.txt landed as UTF-16 LE BOM (FF FE 4a 00 69 00 6e 00 78 00 0d 00 0a 00)
  // because Gemini's WriteFile tool internally invoked PowerShell 5.1 Set-Content
  // which defaults to UTF-16 LE. Setting these env vars hints child processes
  // (PowerShell, Python, Node) to prefer UTF-8 without BOM. Effective for the
  // tools that respect them; Gemini's system prompt also carries an explicit
  // instruction (registry.ts cli:gemini) as belt-and-suspenders.
  //
  //   PYTHONIOENCODING=utf-8         -- Python stdin/stdout/file ops
  //   PYTHONUTF8=1                   -- Python 3.7+ UTF-8 mode
  //   LANG=en_US.UTF-8               -- POSIX locale (affects libc, glib)
  //   LC_ALL=en_US.UTF-8             -- POSIX locale override
  // Note: PowerShell does not have an env var that changes Set-Content default
  // encoding. The system-prompt nudge is the only reliable fix there.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'en_US.UTF-8',
    ...(extraEnv ?? {}),
  };
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  delete childEnv.CLAUDE_CODE_SSE_PORT;
  return {
    ...(cwd ? { cwd } : {}),
    shell: false,
    stdio: 'pipe',
    env: childEnv,
    ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    // Example smoke test 2026-04-30 round 10: the saga'\''s root cause.
    // The detached daemon was started with no console (`stdio: ['ignore',
    // logFd, logFd]` + `detached: true`). When spawning a child without
    // `windowsHide`, Node defaults to console inheritance. CreateProcessW
    // tries to attach the child to the parent'\''s console; the parent has
    // none; the call fails with ERROR_FILE_NOT_FOUND, which surfaces as
    // `spawn <executable> ENOENT` even though the executable exists. The
    // probe in round 9 used windowsHide:true (and stdio:'ignore') by
    // accident, so the probe always succeeded while the real spawn
    // failed. The actual fix: pass windowsHide so CreateProcessW gets
    // CREATE_NO_WINDOW and doesn'\''t try to attach a console.
    windowsHide: true,
  };
}

/**
 * Cursor-agent has a versioned-install layout that the upstream .ps1 wrapper
 * navigates internally:
 *
 *   <install-dir>/
 *     cursor-agent.cmd       (powershell -File ...ps1)
 *     cursor-agent.ps1       (picks latest version dir, runs node.exe + index.js)
 *     versions/
 *       2026.04.28-e984b46/
 *         node.exe
 *         index.js
 *
 * We replicate that lookup in TS so we can spawn `node.exe + index.js` of
 * the latest version directly, bypassing the PowerShell wrapper entirely.
 * Same `bin/<bundle>` direct-spawn shape as round 5 of the npm shim path —
 * native EXE only, no shell, no quoting drama.
 */
function resolveCursorAgentLayout(
  cmdPath: string,
): { node: string; script: string } | null {
  if (process.platform !== 'win32') return null;
  if (!/\.cmd$/i.test(cmdPath)) return null;
  const dir = dirname(cmdPath);
  // Same-dir node.exe + index.js (one-version install layout)
  const sameDirNode = join(dir, 'node.exe');
  const sameDirIndex = join(dir, 'index.js');
  if (existsSync(sameDirNode) && existsSync(sameDirIndex)) {
    return { node: sameDirNode, script: sameDirIndex };
  }
  // Versioned layout: <dir>/versions/YYYY.M.D-commit/{node.exe, index.js}
  const versionsDir = join(dir, 'versions');
  if (!existsSync(versionsDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(versionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/.test(n));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  // Sort descending by parsed (year, month, day) so latest is first.
  entries.sort((a, b) => {
    const ma = a.match(/^(\d+)\.(\d+)\.(\d+)/);
    const mb = b.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!ma || !mb) return 0;
    for (let i = 1; i <= 3; i++) {
      const av = Number(ma[i]);
      const bv = Number(mb[i]);
      if (av !== bv) return bv - av;
    }
    return 0;
  });
  for (const v of entries) {
    const node = join(versionsDir, v, 'node.exe');
    const script = join(versionsDir, v, 'index.js');
    if (existsSync(node) && existsSync(script)) {
      return { node, script };
    }
  }
  return null;
}

/**
 * Parse an npm-style .cmd shim and extract the underlying node script path
 * plus any node CLI flags the shim wants applied (e.g. gemini-cli passes
 * `--no-warnings=DEP0040` to suppress a deprecation message).
 *
 * Round 5 (Example smoke test 2026-04-30): even after round 4 wrapped the bin
 * in outer quotes via cmd.exe, the detached daemon kept hitting
 * `spawn cmd.exe ENOENT` while the same code worked perfectly in a non-
 * detached smoke test. Rather than chase the upstream root cause (likely
 * Windows DETACHED_PROCESS interacting badly with CreateProcessW for
 * cmd.exe in certain installs), we bypass cmd.exe entirely. Every npm CLI
 * .cmd shim wraps `node [<flags>] "<path-to-package>/cli.js" %*`. We read
 * the .cmd file, extract the JS target + any node flags, and spawn the
 * current Node with them directly. Native EXE spawn — no shell, no
 * quoting, no detached-process gotchas.
 *
 * Observed shim formats (validated 2026-04-30):
 *   claude.cmd, codex.cmd: `"%_prog%"  "<script>" %*`            (no flags)
 *   gemini.cmd:            `"%_prog%" --no-warnings=DEP0040 "<script>" %*`
 *   future kimi.cmd:       expected to follow the standard npm shim format
 */
function resolveNpmShimToNodeScript(
  cmdPath: string,
): { script: string; nodeFlags: string[] } | null {
  if (process.platform !== 'win32') return null;
  if (!/\.cmd$/i.test(cmdPath)) return null;
  let content: string;
  try {
    content = readFileSync(cmdPath, 'utf8');
  } catch {
    return null;
  }
  // Capture optional flags between "%_prog%" and the first quoted path.
  // Group 1: flag soup (may be empty); Group 2: the script path. We do NOT
  // require a .js / .cjs / .mjs extension because some npm shims (kilo,
  // opencode, kilocode) reference an extensionless "bin/<name>" script.
  // npm's shim ensures Node treats it as JS by manipulating PATHEXT; when
  // we spawn `node <path>` directly, Node reads the file as JS regardless
  // of extension. The existsSync check below is the safety net against
  // false-positive matches.
  const match = content.match(/"%_prog%"\s+(.*?)\s*"([^"]+)"/);
  if (!match || !match[2]) return null;

  const dp0 = dirname(cmdPath);
  const scriptAbs = match[2]
    .replace(/%dp0%\\?/gi, dp0 + '\\')
    .replace(/\//g, '\\');
  if (!existsSync(scriptAbs)) return null;

  const flagsRaw = (match[1] ?? '').trim();
  // Tokenize flags by whitespace. Observed shims don't use quoted flags;
  // if that ever changes we'd need a more careful tokenizer.
  const nodeFlags = flagsRaw ? flagsRaw.split(/\s+/).filter(Boolean) : [];

  return { script: scriptAbs, nodeFlags };
}

/**
 * Generate ALL plausible spawn-target candidates for a given (bin, args) pair,
 * ordered fastest → most-defensive. resolveSpawnTarget() then probes each
 * candidate's executable for spawnability and picks the first one that
 * actually works on the current daemon.
 *
 * Bug saga that drove the multi-candidate design:
 *  - Round 1 (4666849): resolved claude.cmd by absolute path (was ENOENT)
 *  - Round 2 (68623fe): shell:true to interpret .cmd shim (was EINVAL)
 *  - Round 3 (b07a0b2): pre-resolved cmd.exe path (still ENOENT in daemon)
 *  - Round 4 (12a7a63): spawn cmd.exe directly + verbatim outer-quoted command
 *  - Round 5 (65fca39): bypass cmd.exe, spawn npm shim's node + cli.js
 *  - Round 6 (a2c1f5b): demote claude.exe (Bun-bundled ENOENT in daemon)
 *  - Round 9 (this):    multi-candidate generation + probe-cached selection
 *
 * Example smoke test 2026-04-30 round 9: each round fixed one ENOENT class
 * but introduced visibility into the next. Some Windows installs (Example's
 * daemon specifically) have CreateProcessW failing for absolute paths to
 * existing files — the file system reports the file is there, but spawn
 * can't invoke it. We don't know the upstream root cause (suspect AV /
 * WDAC / detached-process job restriction). Multi-candidate + spawn-time
 * probe is the architectural answer that survives whichever specific
 * executable the OS rejects today.
 */
function generateSpawnCandidates(
  bin: string,
  args: readonly string[],
): SpawnTarget[] {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) {
    return [{ executable: bin, finalArgs: [...args], windowsVerbatimArguments: false }];
  }

  const candidates: SpawnTarget[] = [];

  // Tier A: Cursor-agent versioned layout (specific install pattern).
  const cursor = resolveCursorAgentLayout(bin);
  if (cursor) {
    candidates.push({
      executable: cursor.node,
      finalArgs: [cursor.script, ...args],
      windowsVerbatimArguments: false,
    });
  }

  // Tier B: Standard npm shim — direct node + extracted JS path.
  const npmShim = resolveNpmShimToNodeScript(bin);
  if (npmShim) {
    candidates.push({
      executable: process.execPath,
      finalArgs: [...npmShim.nodeFlags, npmShim.script, ...args],
      windowsVerbatimArguments: false,
    });
  }

  // Tier C: cmd.exe wrapping with verbatim outer-quoted command (round 4).
  if (RESOLVED_CMD_EXE) {
    const quoteForCmd = (s: string): string =>
      !/[\s"]/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
    const command = [`"${bin}"`, ...args.map(quoteForCmd)].join(' ');
    candidates.push({
      executable: RESOLVED_CMD_EXE,
      finalArgs: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
    });
  }

  // Tier D: Last-ditch direct spawn of the .cmd. Will likely EINVAL on
  // CreateProcessW (interpreted scripts can't be launched directly), but
  // produces a clean, debuggable error if every tier above failed.
  candidates.push({
    executable: bin,
    finalArgs: [...args],
    windowsVerbatimArguments: false,
  });

  return candidates;
}

// Probe cache: per-executable spawnability, valid for daemon lifetime. Each
// entry is determined by spawning the executable with a low-cost --version
// (or /c exit for cmd.exe) and checking the result. Saved here so multi-
// candidate selection is fast on second use.
const executableProbeCache = new Map<string, boolean>();

function probeExecutableSpawnability(executable: string): boolean {
  const cached = executableProbeCache.get(executable);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    const isCmdExe = /cmd\.exe$/i.test(executable);
    // Pick a cheap, predictable probe argument:
    //  - cmd.exe → /c exit (returns 0 immediately)
    //  - any other executable → --version (Node, claude bun, etc all support it)
    // 2s timeout is generous; ENOENT fires immediately so we won't usually
    // hit it. We use stdio:'ignore' to avoid any pipe leakage.
    const probeArgs = isCmdExe ? ['/c', 'exit'] : ['--version'];
    const result = spawnSync(executable, probeArgs, {
      stdio: 'ignore',
      timeout: 2000,
      shell: false,
      windowsHide: true,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      // ENOENT means CreateProcessW couldn't load the executable. EACCES
      // means access denied (treat as unspawnable too). Other errors might
      // mean the executable ran but exited abnormally — that's fine, the
      // executable IS spawnable, just not happy with --version.
      ok = code !== 'ENOENT' && code !== 'EACCES';
    } else {
      // No error. status may be non-zero (--version returned non-zero), but
      // that just means the executable doesn't recognize --version, NOT
      // that it can't spawn.
      ok = true;
    }
  } catch {
    ok = false;
  }
  executableProbeCache.set(executable, ok);
  return ok;
}

/**
 * Resolve a (bin, args) pair to the spawn target most likely to work on
 * this daemon. Generates all candidates in priority order, then picks the
 * first whose executable passes a spawnability probe. The probe cache
 * means each unique executable pays its probe cost once per daemon
 * lifetime.
 */
export function resolveSpawnTarget(
  bin: string,
  args: readonly string[],
): SpawnTarget {
  const candidates = generateSpawnCandidates(bin, args);
  if (candidates.length === 1) return candidates[0]; // POSIX or non-shim path
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (probeExecutableSpawnability(c.executable)) {
      if (i > 0) {
        // Surface the fallback choice to the daemon log so operators can
        // see why a specific tier was selected.
        process.stderr.write(
          `[cli-spawn] selected fallback tier ${i} for bin=${bin} (executable=${c.executable})\n`,
        );
      }
      return c;
    }
  }
  // Every probe failed. Return tier-D (direct .cmd spawn) so the operator
  // gets a precise error rather than a silent hang. Log a loud diagnostic.
  process.stderr.write(
    `[cli-spawn] WARNING: every spawn-target probe failed for bin=${bin}; falling back to direct .cmd (will likely EINVAL)\n`,
  );
  return candidates[candidates.length - 1];
}
