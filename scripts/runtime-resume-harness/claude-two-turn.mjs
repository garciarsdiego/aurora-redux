#!/usr/bin/env node
/**
 * Claude two-turn resume harness (Wave 2.1 / F2-2 — standalone proof script).
 *
 * Spawns the `claude` CLI headless twice:
 *   Turn 1: Tells Claude to remember the number 47, captures the sessionId
 *           emitted in the stream-json output.
 *   Turn 2: Resumes the session via `--resume <sessionId>` and asks Claude
 *           what the number was. Validates the answer contains "47".
 *
 * Writes a redacted markdown artifact to
 *   _artifacts/runtime-resume-harness/claude-<timestamp>.md
 *
 * IMPORTANT: this script does NOT touch src/runtime/process-pool.ts or any
 * other production runtime code. It is a standalone proof harness exercised
 * by Wave 2.3 of the calm-torvalds plan.
 *
 * Detected `claude` CLI version when this script was authored: 2.1.131.
 * Flags used (verified via `claude --help`):
 *   --print                     non-interactive output
 *   --output-format stream-json structured JSONL events on stdout
 *   --verbose                   required to enable stream-json with --print
 *   --session-id <uuid>         set an explicit UUID for the turn 1 session
 *   --resume <sessionId>        resume the session for turn 2
 *
 * No bypass / dangerous flags are used (the entire point is to prove safety).
 *
 * Usage:
 *   node scripts/runtime-resume-harness/claude-two-turn.mjs
 *   node scripts/runtime-resume-harness/claude-two-turn.mjs --dry-run
 *
 * Exit codes:
 *   0 success (turn 2 response contains "47")
 *   1 failure (timeout, parse error, missing sessionId, wrong answer, etc.)
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has('--dry-run');

const TURN_TIMEOUT_MS = 60_000;
const ARTIFACT_MAX_BYTES = 8 * 1024;
const CLAUDE_BIN = process.env.OMNIFORGE_CLAUDE_BIN || 'claude';

const TURN_1_PROMPT = 'Remember the number 47. Reply with just OK.';
const TURN_2_PROMPT = 'What was the number? Reply with just the digits.';

/**
 * Truncate a sessionId for redacted artifact output.
 * Returns the first 8 characters followed by "..." or "(none)".
 */
function redactSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '(none)';
  if (sessionId.length <= 8) return `${sessionId}...`;
  return `${sessionId.slice(0, 8)}...`;
}

/**
 * Best-effort scrub of any string that might contain a token, key, or secret.
 * Replaces long alphanumeric runs with `(value redacted)` placeholders.
 */
function scrubSecrets(str) {
  if (!str || typeof str !== 'string') return '';
  let out = str;
  // sk-…, pk-…, anthropic-…, bearer-…, hex >= 24, base64-ish >= 40
  out = out.replace(/\b(sk|pk|anthropic|bearer)[-_a-z]*[-_=:]?[A-Za-z0-9_-]{16,}\b/gi, '(value redacted)');
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '(value redacted)');
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (m) => (m.length >= 40 ? '(value redacted)' : m));
  return out;
}

/**
 * Truncate-and-clean a model response for artifact embedding.
 * Strips control chars, scrubs secrets, hard-caps to 400 chars.
 */
function cleanResponse(str) {
  if (!str) return '(empty)';
  let out = String(str);
  out = out.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  out = scrubSecrets(out);
  if (out.length > 400) out = `${out.slice(0, 400)}...(truncated)`;
  return out.trim() || '(empty)';
}

/**
 * Spawn `claude` and return a promise that resolves with { stdout, stderr, code, timedOut }.
 *
 * - shell: false (no shell metacharacter expansion).
 * - cwd: passed in by caller (a fresh mkdtemp directory).
 * - timeout enforced manually so we can capture stdout up to the kill point.
 */
function runClaude({ args, prompt, cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(CLAUDE_BIN, args, {
      shell: false,
      cwd,
      env: { ...process.env, CLAUDE_CODE_NONINTERACTIVE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, signal, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));

    if (prompt !== undefined && child.stdin) {
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (err) {
        stderr += `\n[stdin write error] ${err && err.message ? err.message : String(err)}`;
      }
    }
  });
}

/**
 * Parse stream-json output line-by-line, looking for the session_id.
 * Stream-json events look like:
 *   {"type":"system","subtype":"init","session_id":"…"}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}, "session_id":"…"}
 * Returns { sessionId, assistantText } where either may be null.
 */
function parseStreamJson(stdout) {
  let sessionId = null;
  const assistantChunks = [];
  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (!sessionId && typeof evt.session_id === 'string') {
      sessionId = evt.session_id;
    }
    if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
      for (const block of evt.message.content) {
        if (block && block.type === 'text' && typeof block.text === 'string') {
          assistantChunks.push(block.text);
        }
      }
    }
    // result event (terminal) carries the final text in some versions
    if (evt.type === 'result' && typeof evt.result === 'string') {
      assistantChunks.push(evt.result);
    }
  }
  return { sessionId, assistantText: assistantChunks.join('').trim() };
}

/**
 * Replace any UUID-looking token in an args array with a redacted form,
 * so the artifact never contains a full sessionId even in the "Flags used" block.
 */
function redactArgs(args) {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return args.map((a) => (typeof a === 'string' && uuidRe.test(a) ? `${a.slice(0, 8)}...` : a));
}

/**
 * Build an artifact section, capping it within ARTIFACT_MAX_BYTES.
 */
function buildArtifact(report) {
  const lines = [
    '# Claude two-turn resume harness — artifact',
    '',
    `- timestamp (UTC): ${report.timestamp}`,
    `- claude binary: ${CLAUDE_BIN}`,
    `- detected version: ${report.detectedVersion || '(not captured)'}`,
    `- working directory (ephemeral): ${report.cwd}`,
    `- dry run: ${report.dryRun ? 'yes' : 'no'}`,
    `- verdict: **${report.verdict}**`,
    '',
    '## Flags used (sessionId redacted)',
    '',
    '```',
    `turn 1: ${redactArgs(report.turn1Args).join(' ')}`,
    `turn 2: ${redactArgs(report.turn2Args).join(' ')}`,
    '```',
    '',
    '## Turn 1',
    '',
    `- prompt: ${JSON.stringify(report.turn1Prompt)}`,
    `- session id (redacted): ${redactSessionId(report.sessionId)}`,
    `- spawn exit code: ${report.turn1ExitCode}`,
    `- timed out: ${report.turn1TimedOut ? 'yes' : 'no'}`,
    '',
    '## Turn 2',
    '',
    `- prompt: ${JSON.stringify(report.turn2Prompt)}`,
    `- spawn exit code: ${report.turn2ExitCode}`,
    `- timed out: ${report.turn2TimedOut ? 'yes' : 'no'}`,
    `- response (redacted, truncated): ${JSON.stringify(report.turn2Response)}`,
    `- contains "47": ${report.containsAnswer ? 'yes' : 'no'}`,
    '',
    '## Notes',
    '',
    report.notes.length === 0 ? '(none)' : report.notes.map((n) => `- ${n}`).join('\n'),
    '',
  ];
  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > ARTIFACT_MAX_BYTES) {
    const slice = Buffer.from(body, 'utf8').subarray(0, ARTIFACT_MAX_BYTES - 32).toString('utf8');
    body = `${slice}\n\n...(artifact truncated to 8 KB)\n`;
  }
  return body;
}

/**
 * Dry run: print the plan without spawning anything.
 * Still produces an artifact so we can verify the redaction path.
 */
async function runDry() {
  const sessionId = randomUUID();
  const cwd = mkdtempSync(join(tmpdir(), 'claude-harness-dry-'));
  const turn1Args = ['--print', '--verbose', '--output-format', 'stream-json', '--session-id', sessionId];
  const turn2Args = ['--print', '--verbose', '--output-format', 'stream-json', '--resume', sessionId];
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `claude-${timestamp}-dryrun.md`);

  const report = {
    timestamp,
    detectedVersion: '2.1.131 (dry run — not actually invoked)',
    cwd,
    dryRun: true,
    verdict: 'DRY-RUN (no spawn)',
    turn1Args,
    turn2Args,
    turn1Prompt: TURN_1_PROMPT,
    turn2Prompt: TURN_2_PROMPT,
    sessionId,
    turn1ExitCode: '(n/a)',
    turn1TimedOut: false,
    turn2ExitCode: '(n/a)',
    turn2TimedOut: false,
    turn2Response: '(n/a — dry run)',
    containsAnswer: false,
    notes: [
      'Dry run: no claude process was spawned.',
      'Real run would write turn 1 prompt to stdin, parse stream-json events for session_id, kill the process, then resume.',
      'No --dangerously-skip-permissions, --yolo, or other bypass flags are used.',
    ],
  };

  writeFileSync(artifactPath, buildArtifact(report), 'utf8');
  process.stdout.write(`[dry-run] artifact written: ${artifactPath}\n`);
  return 0;
}

/**
 * Live run: spawn turn 1, capture sessionId, spawn turn 2, validate.
 */
async function runLive() {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-harness-'));
  const explicitSessionId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const notes = [];
  let detectedVersion = '';

  // Capture version into the artifact for traceability.
  try {
    const v = await runClaude({ args: ['--version'], prompt: undefined, cwd, timeoutMs: 10_000 });
    detectedVersion = (v.stdout || v.stderr || '').toString().trim().slice(0, 120);
  } catch (err) {
    notes.push(`Failed to capture --version: ${err && err.message ? err.message : String(err)}`);
  }

  // ---- Turn 1 ----------------------------------------------------------
  const turn1Args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--session-id', explicitSessionId,
  ];
  const t1 = await runClaude({
    args: turn1Args,
    prompt: TURN_1_PROMPT,
    cwd,
    timeoutMs: TURN_TIMEOUT_MS,
  });

  const t1Parsed = parseStreamJson(t1.stdout);
  // Prefer the sessionId emitted by claude itself; fall back to explicit UUID.
  let sessionId = t1Parsed.sessionId || explicitSessionId;

  if (t1.timedOut) notes.push('Turn 1 timed out (60s).');
  if (t1.code !== 0) notes.push(`Turn 1 exited with code ${t1.code}.`);
  if (!t1Parsed.sessionId) {
    notes.push('Turn 1 stream-json did not contain a session_id event; falling back to the --session-id we passed.');
  }
  if (t1.stderr && t1.stderr.trim()) {
    notes.push(`Turn 1 stderr (scrubbed, capped 200): ${scrubSecrets(t1.stderr).slice(0, 200)}`);
  }

  // ---- Turn 2 ----------------------------------------------------------
  const turn2Args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--resume', sessionId,
  ];
  let t2 = { stdout: '', stderr: '', code: null, timedOut: false };
  let t2Parsed = { sessionId: null, assistantText: '' };
  if (!t1.timedOut && t1.code === 0) {
    t2 = await runClaude({
      args: turn2Args,
      prompt: TURN_2_PROMPT,
      cwd,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    t2Parsed = parseStreamJson(t2.stdout);
    if (t2.timedOut) notes.push('Turn 2 timed out (60s).');
    if (t2.code !== 0) notes.push(`Turn 2 exited with code ${t2.code}.`);
    if (t2.stderr && t2.stderr.trim()) {
      notes.push(`Turn 2 stderr (scrubbed, capped 200): ${scrubSecrets(t2.stderr).slice(0, 200)}`);
    }
  } else {
    notes.push('Turn 2 skipped because turn 1 failed.');
  }

  const turn2ResponseClean = cleanResponse(t2Parsed.assistantText || t2.stdout);
  const containsAnswer = /\b47\b/.test(t2Parsed.assistantText || '') || /\b47\b/.test(t2.stdout || '');
  const verdict = containsAnswer ? 'PASS' : 'FAIL';

  const report = {
    timestamp,
    detectedVersion: scrubSecrets(detectedVersion),
    cwd,
    dryRun: false,
    verdict,
    turn1Args,
    turn2Args,
    turn1Prompt: TURN_1_PROMPT,
    turn2Prompt: TURN_2_PROMPT,
    sessionId,
    turn1ExitCode: t1.code,
    turn1TimedOut: t1.timedOut,
    turn2ExitCode: t2.code,
    turn2TimedOut: t2.timedOut,
    turn2Response: turn2ResponseClean,
    containsAnswer,
    notes,
  };

  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `claude-${timestamp}.md`);
  writeFileSync(artifactPath, buildArtifact(report), 'utf8');

  process.stdout.write(
    `[claude-two-turn] verdict=${verdict} sessionId=${redactSessionId(sessionId)} artifact=${artifactPath}\n`
  );

  return containsAnswer ? 0 : 1;
}

async function main() {
  // Sanity: the artifact directory must be under _artifacts/ which is gitignored.
  const expectedRoot = join(REPO_ROOT, '_artifacts');
  if (!existsSync(REPO_ROOT)) {
    process.stderr.write(`[claude-two-turn] repo root not found: ${REPO_ROOT}\n`);
    process.exit(1);
  }
  // We only need to ensure the parent _artifacts dir is reachable; subdir is created on demand.
  void expectedRoot;

  try {
    const code = DRY_RUN ? await runDry() : await runLive();
    process.exit(code);
  } catch (err) {
    process.stderr.write(
      `[claude-two-turn] unhandled error: ${err && err.message ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

await main();
