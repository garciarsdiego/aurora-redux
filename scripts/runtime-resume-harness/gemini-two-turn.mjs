#!/usr/bin/env node
/**
 * gemini-two-turn.mjs — Wave 2 Agent H, Task 8A.2 IMPL
 *
 * Two-turn resume harness for the Gemini CLI. Mirrors the claude-two-turn
 * harness pattern (Wave 2 Agent G). Verifies that we can:
 *   1. Spawn `gemini -p` with `--session-id <uuid>` and capture the init.session_id
 *      from the NDJSON `--output-format stream-json` stream.
 *   2. Spawn a second `gemini -p` with `--resume <uuid>` (same cwd) and confirm
 *      the assistant remembers context from turn 1.
 *
 * Pinned CLI flag inventory (gemini --help, gemini-cli 0.41.2):
 *   -p, --prompt              non-interactive prompt; appended LAST to argv
 *   --output-format           text | json | stream-json
 *   --session-id <uuid>       start a NEW session with explicit UUID
 *   -r, --resume <id>         resume previous session (uuid | "latest" | index)
 *   --list-sessions           list sessions for current project (cwd-keyed)
 *   --delete-session <n>      delete session by index
 *   --yolo                    auto-approve all actions
 *   --skip-trust              trust workspace for this session
 *   --acp / --experimental-acp  ACP mode (NOT touched here — Phase 8C)
 *
 * Constraints (per task spec):
 *   - DO NOT pass `--model` (auth split risk per Wave 2 plan).
 *   - DO NOT touch acp-stdio (Phase 8C).
 *   - Prompt as argv `-p <prompt>` LAST, NOT stdin (gemini's `-p` mode rejects
 *     stdin per AGENTS.md cli.ts:558 historical note).
 *   - Cwd MUST be the same between turns. Gemini's session storage is
 *     per-project (cwd-keyed); rmdir-ing between turns silently breaks resume.
 *
 * Bin override: `CLI_GEMINI_BIN=/abs/path/to/gemini` (defaults to PATH lookup).
 *
 * Usage:
 *   node scripts/runtime-resume-harness/gemini-two-turn.mjs                 # full run
 *   node scripts/runtime-resume-harness/gemini-two-turn.mjs --dry-run       # plan only
 *   node scripts/runtime-resume-harness/gemini-two-turn.mjs --keep          # keep tmp cwd
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

const ARGV = process.argv.slice(2);
const DRY_RUN = ARGV.includes('--dry-run');
const KEEP_CWD = ARGV.includes('--keep');

// NOTE: prompt avoids embedded double-quotes. On Windows the harness must
// spawn through the shell to resolve the .cmd shim (gemini ships as
// gemini.cmd in the npm install layout); shell:true on Windows concatenates
// argv without escaping (Node DEP0190), so embedded `"` inside an argv
// element breaks gemini's argv parser. Plain ASCII keeps the round-trip safe.
const TURN_1_PROMPT
  = 'Remember the magic word ARCANE-TURTLE-7. '
  + 'Reply only with the single word Stored. Do not call any tools.';

const TURN_2_PROMPT
  = 'What was the magic word I asked you to remember? '
  + 'Reply with just the word and nothing else.';

const GEMINI_BIN = process.env.CLI_GEMINI_BIN ?? 'gemini';

/**
 * Build argv for a single gemini turn. Prompt comes LAST so it remains the
 * value paired with `-p`. We never pass `--model` (lets gemini default; mixing
 * an OAuth-only login with `--model` can split auth modes per the gemini-cli
 * issue tracker — and the harness only needs to prove the resume protocol).
 */
function buildArgs({ resume, sessionId, prompt }) {
  // --skip-trust: tmpdir() cwd is by definition not in gemini's trusted-folder
  // list, so headless runs error with exit 55 without it. Production cli.ts
  // skips this flag because gemini-cli 0.32.x rejected it as unknown — but
  // gemini-cli 0.41.2 (the version we're targeting in Wave 2) accepts and
  // requires it for ad-hoc cwds. We pin the version assumption in the file
  // header.
  const args = ['--yolo', '--skip-trust', '--output-format', 'stream-json'];
  if (resume) args.push('--resume', resume);
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-p', prompt);
  return args;
}

/**
 * Run gemini once and parse NDJSON from stdout. Returns:
 *   { exitCode, sessionId, finalText, toolCalls, raw }
 *
 * Defensive against:
 *   - Banner/info lines on stdout BEFORE NDJSON ("YOLO mode is enabled..."
 *     and friends from gemini 0.41.2).
 *   - Truncated final line (we collect by `\n` and tolerate non-JSON).
 *   - Missing `init` event (sessionId returns null and caller falls back).
 */
/**
 * Windows: gemini ships as gemini.cmd in npm's global bin. There are two
 * spawn paths that don't lose argv tokens:
 *
 *   (a) PATH-walk to find <name>.cmd, then unwrap the npm shim by reading
 *       the .cmd contents to extract the underlying JS entrypoint. Spawn
 *       node + that JS file directly with the original argv. This mirrors
 *       Tier B in src/executors/cli.ts (resolveNpmShimToNodeScript) and is
 *       the production-blessed approach.
 *   (b) Fall back to spawning the .cmd via cmd.exe with windowsVerbatimArguments.
 *
 * shell:true on Windows is NOT acceptable here: it concatenates argv into a
 * single command line and re-tokenises with cmd.exe rules, which breaks any
 * argv element containing spaces or dashes (gemini parses ARCANE-TURTLE-7
 * as flag-then-positional once unquoted).
 */
function resolveWindowsCmdShim(name) {
  if (process.platform !== 'win32') return null;
  // Already a path (absolute or relative) — caller knows where the bin is.
  if (name.includes('\\') || name.includes('/')) return name;
  const pathDirs = (process.env.PATH ?? '').split(';').filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, `${name}.cmd`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function unwrapNpmShim(cmdPath) {
  if (process.platform !== 'win32') return null;
  if (!/\.cmd$/i.test(cmdPath)) return null;
  let content;
  try { content = readFileSync(cmdPath, 'utf8'); } catch { return null; }
  // Match the standard npm shim line: `"%_prog%" <flags> "%dp0%\node_modules\..."`
  const match = content.match(/"%_prog%"\s+(.*?)\s*"([^"]+)"/);
  if (!match || !match[2]) return null;
  const dp0 = dirname(cmdPath);
  const scriptAbs = match[2]
    .replace(/%dp0%\\?/gi, `${dp0}\\`)
    .replace(/\//g, '\\');
  if (!existsSync(scriptAbs)) return null;
  const flagsRaw = (match[1] ?? '').trim();
  const nodeFlags = flagsRaw ? flagsRaw.split(/\s+/).filter(Boolean) : [];
  return { script: scriptAbs, nodeFlags };
}

function buildSpawnTarget(args) {
  if (process.platform !== 'win32') {
    return { executable: GEMINI_BIN, finalArgs: args, windowsVerbatimArguments: false };
  }
  const cmdPath = resolveWindowsCmdShim(GEMINI_BIN);
  if (cmdPath) {
    const shim = unwrapNpmShim(cmdPath);
    if (shim) {
      // Tier B (production-preferred): node + script + original args.
      return {
        executable: process.execPath,
        finalArgs: [...shim.nodeFlags, shim.script, ...args],
        windowsVerbatimArguments: false,
      };
    }
    // Tier C fallback: cmd.exe wrap with verbatim outer-quoted command.
    const quoteForCmd = (s) => (!/[\s"]/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
    const command = [`"${cmdPath}"`, ...args.map(quoteForCmd)].join(' ');
    return {
      executable: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      finalArgs: ['/d', '/s', '/c', `"${command}"`],
      windowsVerbatimArguments: true,
    };
  }
  // No .cmd found — let spawn surface ENOENT with the bare name.
  return { executable: GEMINI_BIN, finalArgs: args, windowsVerbatimArguments: false };
}

function runOnce({ args, cwd, label }) {
  return new Promise((resolve, reject) => {
    const target = buildSpawnTarget(args);
    process.stderr.write(`\n[harness] ${label} spawn: ${target.executable} ${target.finalArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}\n`);
    process.stderr.write(`[harness] ${label} cwd:   ${cwd}\n`);
    const child = spawn(target.executable, target.finalArgs, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.once('error', (err) => reject(new Error(`${label} spawn error: ${err.message}`)));
    child.once('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const parsed = parseGeminiStreamJson(stdout);
      resolve({
        exitCode: code ?? -1,
        sessionId: parsed.sessionId,
        finalText: parsed.finalText,
        toolCalls: parsed.toolCalls,
        isError: parsed.isError,
        errorReason: parsed.errorReason,
        raw: stdout,
        stderr,
      });
    });
  });
}

/**
 * Parse Gemini stream-json NDJSON output (gemini-cli 0.41.2).
 * EVENT SHAPE VERIFIED via _artifacts/runtime-resume-harness/gemini-stream-json-sample.txt.
 *
 *   { type: "init",        session_id, model, timestamp }
 *   { type: "message",     role: "user"|"assistant", content, delta?, timestamp }
 *   { type: "tool_use",    tool_name, tool_id, parameters, timestamp }
 *   { type: "tool_result", tool_id, status, output?, timestamp }
 *   { type: "result",      status: "success"|..., stats: {...}, timestamp }
 *
 * Mirrors `parseClaudeStreamJson` in src/executors/cli.ts: tolerant of
 * non-JSON lines (banner) and missing fields. Future schema additions are
 * surfaced as raw event types under `unknownTypes` rather than throwing.
 */
export function parseGeminiStreamJson(stdout) {
  const toolCalls = [];
  const unknownTypes = new Set();
  let sessionId = null;
  let finalText = '';
  let isError = false;
  let errorReason = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) continue;
    const type = event.type;
    if (type === 'init') {
      if (typeof event.session_id === 'string') sessionId = event.session_id;
    } else if (type === 'message') {
      if (event.role === 'assistant' && typeof event.content === 'string') {
        // Gemini deltas chunk text across multiple message events; concat all.
        finalText += event.content;
      }
    } else if (type === 'tool_use') {
      const name = typeof event.tool_name === 'string' ? event.tool_name : 'unknown';
      const input = (event.parameters && typeof event.parameters === 'object')
        ? event.parameters
        : {};
      toolCalls.push({ name, input });
    } else if (type === 'tool_result') {
      // Observed but not surfaced in the Claude-shape adapter.
    } else if (type === 'result') {
      if (typeof event.status === 'string' && event.status !== 'success') {
        isError = true;
        errorReason = event.status;
      }
    } else if (typeof type === 'string') {
      unknownTypes.add(type);
    }
  }
  if (unknownTypes.size > 0) {
    process.stderr.write(`[harness] note: parser saw unknown event types: ${[...unknownTypes].join(', ')}\n`);
  }
  return { sessionId, finalText: finalText.trim(), toolCalls, isError, errorReason };
}

/**
 * Adapter: shape the Gemini parsed result like Claude's so downstream wrappers
 * (wrapClaudeOutput) keep working unchanged. Used by src/executors/cli.ts when
 * cliId === 'gemini' && streamJson.
 */
export function geminiParsedToClaudeShape(parsed) {
  return {
    toolCalls: parsed.toolCalls,
    finalText: parsed.finalText,
    isError: parsed.isError,
    errorReason: parsed.errorReason,
  };
}

async function main() {
  const sessionId = randomUUID();
  const cwd = join(tmpdir(), `gemini-two-turn-${sessionId.slice(0, 8)}`);

  if (DRY_RUN) {
    const turn1 = buildArgs({ sessionId, prompt: TURN_1_PROMPT });
    const turn2 = buildArgs({ resume: sessionId, prompt: TURN_2_PROMPT });
    process.stdout.write([
      'gemini-two-turn dry-run plan',
      `  bin            : ${GEMINI_BIN}`,
      `  cwd            : ${cwd}`,
      `  session-id     : ${sessionId}`,
      `  turn 1 argv    : ${JSON.stringify(turn1)}`,
      `  turn 2 argv    : ${JSON.stringify(turn2)}`,
      '  (no spawn — pass --dry-run to inspect; remove flag to execute)',
      '',
    ].join('\n'));
    return 0;
  }

  mkdirSync(cwd, { recursive: true });
  let cleanup = true;
  try {
    const t1 = await runOnce({
      args: buildArgs({ sessionId, prompt: TURN_1_PROMPT }),
      cwd,
      label: 'turn 1',
    });
    process.stdout.write(`turn 1 exit=${t1.exitCode} session=${t1.sessionId ?? '(none)'} chars=${t1.finalText.length}\n`);
    process.stdout.write(`  text: ${t1.finalText.slice(0, 120)}${t1.finalText.length > 120 ? '...' : ''}\n`);
    if (t1.exitCode !== 0) {
      process.stderr.write(`turn 1 stderr tail: ${t1.stderr.slice(-400)}\n`);
      throw new Error(`turn 1 exited non-zero (${t1.exitCode})`);
    }
    // Fallback contract: if init never produced a session_id, fall back to the
    // explicit UUID we passed at turn 1. Mirrors claude-two-turn fallback at
    // claude-two-turn.mjs:333-335 — keeps resume working if a future gemini
    // build silently changes the init event shape.
    const resumeId = t1.sessionId ?? sessionId;
    if (!t1.sessionId) {
      process.stderr.write('[harness] init.session_id absent — falling back to explicit --session-id UUID\n');
    }
    const t2 = await runOnce({
      args: buildArgs({ resume: resumeId, prompt: TURN_2_PROMPT }),
      cwd,
      label: 'turn 2',
    });
    process.stdout.write(`turn 2 exit=${t2.exitCode} session=${t2.sessionId ?? '(none)'} chars=${t2.finalText.length}\n`);
    process.stdout.write(`  text: ${t2.finalText.slice(0, 200)}${t2.finalText.length > 200 ? '...' : ''}\n`);
    if (t2.exitCode !== 0) {
      process.stderr.write(`turn 2 stderr tail: ${t2.stderr.slice(-400)}\n`);
      throw new Error(`turn 2 exited non-zero (${t2.exitCode})`);
    }
    const resumed = /ARCANE[-\s]TURTLE[-\s]7/i.test(t2.finalText);
    process.stdout.write(`\nresult: resume ${resumed ? 'OK (assistant recalled magic word)' : 'INDETERMINATE (magic word not found in turn 2 reply)'}\n`);
    if (KEEP_CWD) cleanup = false;
    return resumed ? 0 : 1;
  } finally {
    if (cleanup) {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      process.stdout.write(`\n(kept cwd: ${cwd})\n`);
    }
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`harness failed: ${err.message}\n`);
  process.exit(2);
});
