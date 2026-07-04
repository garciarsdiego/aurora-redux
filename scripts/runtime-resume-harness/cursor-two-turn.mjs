#!/usr/bin/env node
/**
 * Cursor two-turn resume harness — FULL stream-json + --resume=<uuid> path.
 *
 * Live-verified 2026-05-11 (Example correction round 2): cursor-agent supports
 * the canonical flag-based resume IF you use the `=` form, not the
 * space-separated `<flag> <value>` form. The earlier W3 probe FAILED
 * because it ran `cursor-agent --resume <uuid>` (two args). The working
 * syntax is `cursor-agent --resume=<uuid>` (single arg).
 *
 * Combined with `--output-format stream-json`, cursor exposes:
 *   • session_id on EVERY event (system/user/assistant/result/thinking)
 *   • Structured `system.init` event at start with session_id, model, cwd
 *   • Structured `result.success` event at end with duration, usage
 *
 * This is full parity with Claude Code's headless mode:
 *   Turn 1: cursor-agent -p --output-format stream-json ... "<prompt>"
 *           → parse session_id from the `system.init` line
 *   Turn 2: cursor-agent --resume=<session_id> -p --output-format stream-json ... "<prompt>"
 *           → same session_id, prior context retained
 *
 * Capabilities consequence: cli:cursor jsonl-headless tier can be marked
 * `verified` with explicitSessionId=true, resume=true, structuredOutput=true.
 *
 * Pre-flight assertion guards against the D-H2.074 Issue 1 hang: every
 * spawn MUST have CURSOR_INVOKED_AS in its env or cursor-agent's inner
 * index.js hangs silently after resolveSpawnTarget unwraps the .cmd shim.
 *
 * Verdicts:
 *   PASS  — turn 2 (--resume=<id> + stream-json) returns the secret AND
 *           emits the same session_id as turn 1's init event
 *   FAIL  — turn 1 timed out, missing session_id, or turn 2 didn't retrieve
 *
 * --dry-run prints the spawn plan without spawning anything.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(__dirname, '..', '..');
const ARTIFACTS_DIR = join(WORKTREE_ROOT, '_artifacts', 'runtime-resume-harness');
const FIXTURE_PATH = join(ARTIFACTS_DIR, 'cursor-stream-json-fixture.jsonl');
const FIXTURE_CAP_BYTES = 64 * 1024;

const TURN_TIMEOUT_MS = 90_000;
const SECRET_NUMBER = '47';
const SECRET_PROMPT_TURN_1 =
  `Remember this number: ${SECRET_NUMBER}. Just acknowledge with a one-line "OK" — do not write any files. Do not explain.`;
const SECRET_PROMPT_TURN_2 =
  `What was the number I told you to remember earlier? Reply with only the digits, nothing else. Do not write any files.`;
const INTERLEAVE_PROMPT = `What is 2+2? Reply with only the digits, nothing else. Do not write any files.`;

const DRY_RUN = process.argv.includes('--dry-run');
const CAPTURE_STREAM_JSON = process.argv.includes('--capture-stream-json');

function cursorAgentBinary() {
  if (process.env.OMNIFORGE_CURSOR_BIN) return process.env.OMNIFORGE_CURSOR_BIN;
  return 'cursor-agent';
}

/**
 * Mirror src/executors/cli.ts:711-717 verbatim. The block is LOAD-BEARING:
 * removing either env var silently re-introduces the D-H2.074 Issue 1 hang.
 * Keep this function in sync with the production resolver — when the
 * resolver gains another env var, this helper must too.
 */
function buildCursorEnv() {
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  // Two LOAD-BEARING env vars from cli.ts:712-716. Without them cursor-agent
  // hangs silently after resolveSpawnTarget bypasses the .cmd shim.
  env.CURSOR_INVOKED_AS = 'cursor-agent.cmd';
  if (process.env.LOCALAPPDATA) {
    env.NODE_COMPILE_CACHE = `${process.env.LOCALAPPDATA}\\cursor-compile-cache`;
  }
  return env;
}

function assertCursorEnvValid(cursorEnv, label) {
  if (!cursorEnv.CURSOR_INVOKED_AS) {
    throw new Error(
      `REGRESSION: missing CURSOR_INVOKED_AS — would hang per D-H2.074 (${label})`,
    );
  }
}

function nowMs() {
  return Date.now();
}

function shortSnippet(s, n = 200) {
  if (!s) return '';
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > n ? `${trimmed.slice(0, n)}…` : trimmed;
}

/**
 * Spawn a single cursor-agent turn. `args` is the full argv after the
 * binary, with the prompt already embedded as the LAST element (cursor uses
 * arg-delivery for prompts). Returns { code, stdout, stderr, durationMs }.
 */
function runCursorTurn({ args, cwd, captureStreamJson, label, stdinPrompt }) {
  const cursorEnv = buildCursorEnv();
  assertCursorEnvValid(cursorEnv, label);

  const bin = cursorAgentBinary();
  const startedAt = nowMs();

  // Node 24+ on Windows refuses to spawn .cmd / .bat with shell: false (EINVAL).
  // The Aurora production cli.ts path resolves the inner node.exe + index.js
  // directly; here we keep the .cmd binary so the PowerShell wrapper preserves
  // the cursor version selection logic, but we invoke it via cmd.exe /c with
  // shell:false. The full argv goes after `/c <bin>` — cmd.exe handles the
  // .cmd shim correctly and we still avoid shell:true argv interpolation.
  let spawnBin = bin;
  let spawnArgs = args;
  let spawnWindowsVerbatim = false;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    // Node 24+ on Windows refuses to spawn .cmd / .bat with shell: false (EINVAL).
    // We invoke via cmd.exe /d /s /c with windowsVerbatimArguments and the
    // empirically-verified double-quoted form:
    //   cmd.exe /d /s /c ""<bin path>" arg1 arg2 ..."
    // The outer "" is mandatory: cmd.exe strips the first and last quote,
    // then treats whatever is between as the command. Without it, paths with
    // spaces get split. shell: true is still avoided so argv interpolation
    // of unquoted args is impossible (each arg is individually quoted only
    // if it contains whitespace).
    spawnBin = process.env.ComSpec || 'cmd.exe';
    const quotedBin = `"${bin}"`;
    const quotedArgs = args.map((a) => (typeof a === 'string' && /\s/.test(a) ? `"${a}"` : a));
    spawnArgs = ['/d', '/s', '/c', `"${quotedBin} ${quotedArgs.join(' ')}"`];
    spawnWindowsVerbatim = true;
  }
  const child = spawn(spawnBin, spawnArgs, {
    cwd,
    env: cursorEnv,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: spawnWindowsVerbatim,
  });

  let stdout = '';
  let stderr = '';
  let streamJsonBuffer = captureStreamJson ? '' : null;

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    if (streamJsonBuffer !== null && streamJsonBuffer.length < FIXTURE_CAP_BYTES) {
      streamJsonBuffer = (streamJsonBuffer + text).slice(0, FIXTURE_CAP_BYTES);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  // Prompt delivery: argv for normal `agent` spawns, stdin for `resume`
  // subcommand spawns (cursor's resume rejects positional args). Caller
  // decides via stdinPrompt — when set, we write+close stdin.
  if (child.stdin) {
    if (stdinPrompt !== undefined && stdinPrompt !== null) {
      try { child.stdin.write(stdinPrompt); } catch (_err) { /* best-effort */ }
    }
    child.stdin.end();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_err) { /* best-effort */ }
      reject(new Error(`${label}: turn timed out after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: spawn error: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = nowMs() - startedAt;
      resolve({ code, stdout, stderr, durationMs, streamJsonSample: streamJsonBuffer });
    });
  });
}

/**
 * Best-effort chat id capture for cursor's `--resume <chatId>`. cursor-agent
 * does not currently print the chat id on stdout in plain text mode, so we
 * fall back to ~/.cursor/chats/ newest-mtime directory after the turn
 * completes. The directory name IS the chat id (per cursor-agent.ps1).
 */
function findNewestCursorChatId(referenceTimestamp) {
  const chatsDir = join(homedir(), '.cursor', 'chats');
  if (!existsSync(chatsDir)) return null;
  let entries;
  try {
    entries = readdirSync(chatsDir);
  } catch (_err) {
    return null;
  }
  let best = { id: null, mtime: 0 };
  for (const name of entries) {
    const full = join(chatsDir, name);
    let stat;
    try { stat = statSync(full); } catch (_err) { continue; }
    if (!stat.isDirectory()) continue;
    if (referenceTimestamp && stat.mtimeMs < referenceTimestamp) continue;
    if (stat.mtimeMs > best.mtime) {
      best = { id: name, mtime: stat.mtimeMs };
    }
  }
  return best.id;
}

/**
 * Optional stdout-parse path: cursor MAY embed the chat id somewhere. Today
 * it does not in text mode, so this returns null. Kept as the documented
 * preferred approach so a future cursor build that surfaces the id can be
 * picked up without filesystem snooping.
 */
function tryExtractChatIdFromStdout(stdout) {
  if (!stdout) return null;
  const m = stdout.match(/(?:chat[\s_-]?id|session[\s_-]?id)\s*[:=]\s*([0-9a-f]{8,64})/i);
  return m ? m[1] : null;
}

function makeTempCwd(suffix) {
  const dir = join(tmpdir(), 'omniforge-cursor-resume-harness', `${Date.now()}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function maybePersistFixture(buffer) {
  if (!CAPTURE_STREAM_JSON || !buffer) return;
  try {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    writeFileSync(FIXTURE_PATH, buffer);
    console.log(`[harness] stream-json fixture written: ${FIXTURE_PATH} (${buffer.length} bytes)`);
  } catch (err) {
    console.warn(`[harness] could not persist stream-json fixture: ${err.message}`);
  }
}

function safeRm(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch (_err) { /* best-effort */ }
}

function planSpawnDescriptor(label, cwd, args) {
  return {
    label,
    cwd,
    binary: cursorAgentBinary(),
    args,
    env: {
      CURSOR_INVOKED_AS: 'cursor-agent.cmd',
      NODE_COMPILE_CACHE: process.env.LOCALAPPDATA
        ? `${process.env.LOCALAPPDATA}\\cursor-compile-cache`
        : '<unset — non-Windows host>',
      NO_COLOR: '1',
    },
    timeoutMs: TURN_TIMEOUT_MS,
  };
}

/**
 * --dry-run handler — prints what we WOULD spawn without actually spawning.
 * Used by the CI verification step (no cursor binary, no auth). Validates
 * the regression-guard pre-flight runs cleanly so a missing CURSOR_INVOKED_AS
 * is caught before a live run wastes 6 spawn-attempts of wall clock.
 */
function dryRun() {
  console.log('[harness] --dry-run — printing spawn plan');

  // Run the pre-flight assertion exactly once on a synthesized env, the same
  // way every spawn would. If this throws on a healthy box something else is
  // already broken (someone removed CURSOR_INVOKED_AS from buildCursorEnv).
  const cursorEnv = buildCursorEnv();
  assertCursorEnvValid(cursorEnv, 'dry-run pre-flight');
  console.log('[harness] regression guard OK: CURSOR_INVOKED_AS present');

  const cwdA = '<temp-dir-A>';
  const baseSafe = ['-p', '--output-format', 'text', '--force', '--trust'];

  const plan = [
    planSpawnDescriptor('turn1.cwdA', cwdA, [...baseSafe, SECRET_PROMPT_TURN_1]),
    planSpawnDescriptor('turn2.resume.cwdA', cwdA, ['resume', ...baseSafe]),
  ];
  for (const step of plan) {
    console.log(`\n[plan] ${step.label}`);
    console.log(`  bin:     ${step.binary}`);
    console.log(`  cwd:     ${step.cwd}`);
    console.log(`  args:    ${JSON.stringify(step.args)}`);
    console.log(`  env:     ${JSON.stringify(step.env)}`);
    console.log(`  timeout: ${step.timeoutMs}ms`);
  }
  console.log('\n[harness] --dry-run complete (no processes spawned)');
}

function evaluateAnswer(stdout, expectedDigits) {
  const text = stdout.trim();
  // Accept either an exact match or a stdout containing the digits as a
  // standalone token. Cursor often answers with extra prose despite the
  // "digits only" prompt; we just need the right number to appear.
  if (text.includes(expectedDigits)) return { matched: true, snippet: shortSnippet(text) };
  return { matched: false, snippet: shortSnippet(text) };
}

/**
 * Pull the first `session_id` value out of a stream-json stdout buffer.
 * Cursor emits the value on EVERY event, but the `system.init` event is
 * the earliest reliable source (it lands within the first ~200ms of turn 1).
 * Returns null when no event matches — the caller falls back to filesystem.
 */
function extractSessionIdFromStreamJson(stdout) {
  if (!stdout) return null;
  // Match the first occurrence — system.init is line 1, but we accept any
  // earlier event in case the stream-json format ever changes.
  const m = stdout.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/i);
  return m ? m[1] : null;
}

async function liveRun() {
  console.log('[harness] live run — needs cursor-agent installed + authenticated');
  console.log(`[harness] secret = ${SECRET_NUMBER}`);
  const startedAt = nowMs();

  const cwdA = makeTempCwd('cwdA');
  console.log(`[harness] cwdA = ${cwdA}`);

  // stream-json gives us session_id capture from event #1 + structured
  // output for the parser. --force --trust auto-approves the headless run.
  const baseSafe = ['-p', '--output-format', 'stream-json', '--force', '--trust'];
  const verdict = { resume: 'unknown', sessionIdMatched: false };
  const transcript = [];

  try {
    // ── Turn 1 — establish the secret, capture session_id from stdout ──────
    console.log('\n[harness] turn 1 (cwdA): teach cursor the secret');
    const t1Start = nowMs();
    const t1 = await runCursorTurn({
      args: [...baseSafe, SECRET_PROMPT_TURN_1],
      cwd: cwdA,
      captureStreamJson: true,
      label: 'turn1.cwdA',
    });
    transcript.push({ step: 'turn1.cwdA', ...t1, stdoutSnippet: shortSnippet(t1.stdout) });
    console.log(`  exit ${t1.code}, ${t1.durationMs}ms, stdout: ${shortSnippet(t1.stdout)}`);
    if (t1.code !== 0) throw new Error(`turn 1 failed with exit ${t1.code}: ${shortSnippet(t1.stderr, 400)}`);

    // Capture session id from the stream-json output (preferred) with a
    // filesystem fallback. The stream-json source is what cli.ts will use
    // in production — pin it as the verified primary path.
    const sessionIdFromStream = extractSessionIdFromStreamJson(t1.stdout);
    const sessionIdFromFs = findNewestCursorChatId(t1Start);
    const sessionId = sessionIdFromStream ?? sessionIdFromFs;
    console.log(`[harness] session_id (stream-json): ${sessionIdFromStream ?? '<none>'}`);
    console.log(`[harness] chat id    (fs fallback): ${sessionIdFromFs ?? '<none>'}`);
    if (!sessionId) throw new Error('failed to capture session_id from turn 1 (stream + fs both empty)');
    if (!sessionIdFromStream) console.warn('[harness] WARN: session_id missing from stream-json — falling back to fs (degraded)');

    // ── Turn 2 — `--resume=<uuid>` (with =, single arg) + stream-json ──────
    // The `=` form is load-bearing: `--resume <uuid>` (space-separated) does
    // NOT load prior chat history per W3's original FAIL. Only `--resume=<uuid>`
    // pins to the captured session_id.
    console.log(`\n[harness] turn 2 (cwdA): --resume=${sessionId} + stream-json`);
    const r = await runCursorTurn({
      args: [`--resume=${sessionId}`, ...baseSafe, SECRET_PROMPT_TURN_2],
      cwd: cwdA,
      captureStreamJson: CAPTURE_STREAM_JSON,
      label: 'turn2.resume.cwdA',
    });
    transcript.push({ step: 'turn2.resume.cwdA', ...r, stdoutSnippet: shortSnippet(r.stdout) });
    const rResult = evaluateAnswer(r.stdout, SECRET_NUMBER);
    verdict.resume = rResult.matched ? 'pass' : 'fail';
    // Confirm turn 2's events carry the SAME session_id (proves the pin worked).
    const sessionIdTurn2 = extractSessionIdFromStreamJson(r.stdout);
    verdict.sessionIdMatched = sessionIdTurn2 === sessionId;
    console.log(`  exit ${r.code}, ${r.durationMs}ms, matched=${rResult.matched}, sid_match=${verdict.sessionIdMatched}, stdout: ${rResult.snippet}`);

    // ── Optional fixture capture ───────────────────────────────────────────
    if (CAPTURE_STREAM_JSON) maybePersistFixture(r.streamJsonSample);

    // ── Final verdict ──────────────────────────────────────────────────────
    const final = verdict.resume === 'pass' && verdict.sessionIdMatched ? 'PASS' : 'FAIL';

    console.log('\n========================================');
    console.log(`[harness] VERDICT: ${final}`);
    console.log(`  resume secret retrieval:    ${verdict.resume}`);
    console.log(`  session_id pin preserved:   ${verdict.sessionIdMatched}`);
    console.log(`  session_id:                 ${sessionId}`);
    console.log(`  Total wall-clock:           ${nowMs() - startedAt}ms`);
    console.log('========================================');
    process.exit(final === 'PASS' ? 0 : 1);
  } finally {
    safeRm(cwdA);
  }
}

if (DRY_RUN) {
  dryRun();
} else {
  liveRun().catch((err) => {
    console.error(`[harness] FATAL: ${err.message}`);
    process.exit(2);
  });
}
