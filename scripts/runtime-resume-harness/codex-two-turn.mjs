#!/usr/bin/env node
/**
 * Codex two-turn resume harness (Wave 2 / Task 8A.1 — standalone proof script).
 *
 * Spawns the `codex` CLI headless twice:
 *   Turn 1: Tells Codex to remember the number 47, captures the sessionId
 *           emitted in the JSONL output (`session_id`/`conversation_id`/
 *           `thread_id` keys, possibly nested under `payload`/`session`).
 *   Turn 2: Resumes the session via `codex exec resume <sessionId> <prompt>`
 *           and asks Codex what the number was. Validates the answer
 *           contains "47".
 *
 * Writes a redacted markdown artifact to
 *   _artifacts/runtime-resume-harness/codex-<timestamp>.md
 *
 * IMPORTANT: this script does NOT touch src/runtime/* production runtime
 * code. It is a standalone proof harness exercised by Wave 3 of the
 * runtime-resume initiative. Wave 3 will mark capabilities `verified`
 * after this harness produces a passing real run.
 *
 * Detected `codex` CLI version when this script was authored: codex-cli 0.128.0
 * (verified live via `codex --version` on Windows 11 PowerShell on 2026-05-09).
 *
 * Flags used (verified via `codex exec --help` and `codex exec resume --help`):
 *   exec                                            non-interactive subcommand
 *   exec resume <SESSION_ID> [PROMPT]               resume a previous session
 *   --json                                          print events to stdout as JSONL
 *   --skip-git-repo-check                           allow running outside a git repo
 *   --ephemeral                                     do not persist session files to
 *                                                   disk (resume itself still works
 *                                                   intra-process via the stream id)
 *   -m, --model <MODEL>                             optional explicit model
 *   -o, --output-last-message <FILE>                optional last-message dump
 *
 * NOTE on flag-name correctness vs. the architect's design doc (DEVIATIONS):
 *   - The flag is `--json` (NOT `--output-format json`); confirmed in
 *     `codex exec --help`. The harness uses `--json` accordingly.
 *   - Resume is the subcommand form `codex exec resume <SESSION_ID> [PROMPT]`
 *     (NOT a `--resume <id>` flag). The harness uses the subcommand form.
 *   - There is no `--session-id` analog of Claude Code's. We must capture
 *     whatever sessionId the CLI emits in turn 1's JSONL stream and replay
 *     that exact value in turn 2. If turn 1 emits no id, the harness fails
 *     loudly rather than fabricating one.
 *
 * No bypass / dangerous flags are used by default in the harness — the
 * production code path (cli.ts) keeps `--dangerously-bypass-approvals-and-
 * sandbox` and `--ignore-user-config` because Omniforge externally sandboxes
 * the daemon. The harness here is a SAFETY proof, so it stays minimal.
 *
 * Usage:
 *   node scripts/runtime-resume-harness/codex-two-turn.mjs
 *   node scripts/runtime-resume-harness/codex-two-turn.mjs --dry-run
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has('--dry-run');

const TURN_TIMEOUT_MS = 60_000;
const ARTIFACT_MAX_BYTES = 8 * 1024;
const CODEX_BIN = process.env.OMNIFORGE_CODEX_BIN || 'codex';

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
  out = out.replace(/\b(sk|pk|anthropic|bearer|openai|cdx)[-_a-z]*[-_=:]?[A-Za-z0-9_-]{16,}\b/gi, '(value redacted)');
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
 * Spawn `codex` and return a promise that resolves with { stdout, stderr, code, timedOut }.
 *
 * - shell: false (no shell metacharacter expansion).
 * - cwd: passed in by caller (a fresh mkdtemp directory).
 * - timeout enforced manually so we can capture stdout up to the kill point.
 */
function runCodex({ args, prompt, cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(CODEX_BIN, args, {
      shell: false,
      cwd,
      env: { ...process.env },
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
 * Walk a parsed JSONL event looking for a session id under any of the well-
 * known keys. Codex's `--json` stream wraps the actual payload under either
 *   { ts, payload: { session_id?, conversation_id?, thread_id?, session?{id} } }
 * or sometimes flat at the top level. We probe BOTH the envelope and the
 * payload, and also a nested `session` object if present, because the exact
 * shape varies between versions / events.
 */
function findSessionIdAnywhere(value) {
  if (!value || typeof value !== 'object') return null;
  const candidates = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId'];
  for (const key of candidates) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  // Nested containers like `session: { id }` / `conversation: { id }` /
  // `thread: { id }` — we accept a bare `id` here because the container name
  // disambiguates it from generic record ids.
  for (const containerKey of ['session', 'conversation', 'thread']) {
    const nested = value[containerKey];
    if (nested && typeof nested === 'object') {
      if (typeof nested.id === 'string' && nested.id) return nested.id;
      const found = findSessionIdAnywhere(nested);
      if (found) return found;
    }
  }
  // Generic recursion into envelope wrappers (payload / msg / info) which
  // don't disambiguate, so we don't accept a bare `id` from them.
  for (const nestKey of ['payload', 'msg', 'info']) {
    const nested = value[nestKey];
    if (nested && typeof nested === 'object') {
      const found = findSessionIdAnywhere(nested);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract the assistant message text from a Codex JSONL payload of the form:
 *   { ts, payload: { type: 'message', role: 'assistant', content: '...' | [...] } }
 * Tolerant of both string content and array-of-parts content.
 */
function extractAssistantText(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.type !== 'message') return null;
  if (payload.role !== 'assistant') return null;
  const content = payload.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text);
    }
    if (parts.length) return parts.join('');
  }
  return null;
}

/**
 * Parse JSONL output line-by-line. Returns:
 *   { sessionId: string|null, assistantText: string }
 *
 * Mirrors the codex tail parser at src/v2/cli-tail/parsers/codex.ts:42-53
 * for the envelope shape, but here we ALSO look for the session id (cli-tail
 * doesn't need it; the harness does so it can pass it to `exec resume`).
 */
function parseCodexJsonl(stdout) {
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
    if (!evt || typeof evt !== 'object') continue;

    if (!sessionId) {
      sessionId = findSessionIdAnywhere(evt);
    }

    // Codex envelope: { ts, payload: { ... } }; assistant text lives in payload.
    const payload = evt && typeof evt === 'object' && evt.payload && typeof evt.payload === 'object'
      ? evt.payload
      : evt;
    const text = extractAssistantText(payload);
    if (text) assistantChunks.push(text);
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
    '# Codex two-turn resume harness — artifact',
    '',
    `- timestamp (UTC): ${report.timestamp}`,
    `- codex binary: ${CODEX_BIN}`,
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
 * Build the argv used for turn 1 (initial `codex exec` invocation).
 *
 * EXPORTED for tests: harness arg construction must be assertable without a
 * real spawn. See tests/unit/runtime-resume-codex.test.ts.
 */
export function buildTurn1Args() {
  // NOTE 2026-05-11: removed `--ephemeral` from turn 1 because `codex exec
  // resume <session-id>` cannot find the rollout when `--ephemeral` is set.
  // The codex stderr reports: "thread/resume failed: no rollout found for
  // thread id ... (code -32600)". `exec resume` is a separate process so it
  // needs the persisted rollout file under ~/.codex/sessions/. The harness's
  // workspace-boundary check still runs in REPO_ROOT/src so cross-cwd writes
  // are caught; the persisted rollout is per-user and outside both cwds.
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
  ];
}

/**
 * Build the argv used for turn 2 (`codex exec resume <SESSION_ID>`).
 *
 * EXPORTED for tests. The prompt is delivered via stdin (Codex `exec resume`
 * supports `[PROMPT]` positionally OR via stdin; we keep it in stdin for
 * symmetry with the production cli.ts path).
 */
export function buildTurn2Args(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('buildTurn2Args requires a non-empty sessionId');
  }
  return [
    'exec',
    'resume',
    sessionId,
    '--json',
    '--skip-git-repo-check',
  ];
}

// Also export the pure parser so unit tests can run it on a sample envelope.
export { parseCodexJsonl };

/**
 * Dry run: print the plan without spawning anything.
 * Still produces an artifact so we can verify the redaction path.
 */
async function runDry() {
  // For dry run we use a placeholder UUID-ish string so the artifact's
  // "Flags used" line shows the redaction shape working as expected.
  const sessionId = '00000000-0000-4000-8000-000000000000';
  const cwd = mkdtempSync(join(tmpdir(), 'codex-harness-dry-'));
  const turn1Args = buildTurn1Args();
  const turn2Args = buildTurn2Args(sessionId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `codex-${timestamp}-dryrun.md`);

  const report = {
    timestamp,
    detectedVersion: 'codex-cli 0.128.0 (dry run — not actually invoked)',
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
      'Dry run: no codex process was spawned.',
      'Real run would write turn 1 prompt to stdin, parse JSONL events for session_id/conversation_id/thread_id, then `codex exec resume <id>` for turn 2.',
      'No --dangerously-bypass-approvals-and-sandbox or --ignore-user-config flags are used by the harness (they remain in the production cli.ts spawn path).',
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
  const cwd = mkdtempSync(join(tmpdir(), 'codex-harness-'));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const notes = [];
  let detectedVersion = '';

  // Capture version into the artifact for traceability.
  try {
    const v = await runCodex({ args: ['--version'], prompt: undefined, cwd, timeoutMs: 10_000 });
    detectedVersion = (v.stdout || v.stderr || '').toString().trim().slice(0, 120);
  } catch (err) {
    notes.push(`Failed to capture --version: ${err && err.message ? err.message : String(err)}`);
  }

  // ---- Turn 1 ----------------------------------------------------------
  const turn1Args = buildTurn1Args();
  const t1 = await runCodex({
    args: turn1Args,
    prompt: TURN_1_PROMPT,
    cwd,
    timeoutMs: TURN_TIMEOUT_MS,
  });

  const t1Parsed = parseCodexJsonl(t1.stdout);
  const sessionId = t1Parsed.sessionId;

  if (t1.timedOut) notes.push('Turn 1 timed out (60s).');
  if (t1.code !== 0) notes.push(`Turn 1 exited with code ${t1.code}.`);
  if (!sessionId) {
    notes.push('Turn 1 JSONL did not contain a session_id / conversation_id / thread_id event — cannot resume.');
  }
  if (t1.stderr && t1.stderr.trim()) {
    notes.push(`Turn 1 stderr (scrubbed, capped 200): ${scrubSecrets(t1.stderr).slice(0, 200)}`);
  }

  // ---- Turn 2 ----------------------------------------------------------
  let turn2Args = ['exec', 'resume', '(missing-session-id)', '--json', '--skip-git-repo-check'];
  let t2 = { stdout: '', stderr: '', code: null, timedOut: false };
  let t2Parsed = { sessionId: null, assistantText: '' };
  if (!t1.timedOut && t1.code === 0 && sessionId) {
    turn2Args = buildTurn2Args(sessionId);
    t2 = await runCodex({
      args: turn2Args,
      prompt: TURN_2_PROMPT,
      cwd,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    t2Parsed = parseCodexJsonl(t2.stdout);
    if (t2.timedOut) notes.push('Turn 2 timed out (60s).');
    if (t2.code !== 0) notes.push(`Turn 2 exited with code ${t2.code}.`);
    if (t2.stderr && t2.stderr.trim()) {
      notes.push(`Turn 2 stderr (scrubbed, capped 200): ${scrubSecrets(t2.stderr).slice(0, 200)}`);
    }
  } else {
    notes.push('Turn 2 skipped because turn 1 failed or did not yield a session id.');
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
  const artifactPath = join(artifactDir, `codex-${timestamp}.md`);
  writeFileSync(artifactPath, buildArtifact(report), 'utf8');

  process.stdout.write(
    `[codex-two-turn] verdict=${verdict} sessionId=${redactSessionId(sessionId)} artifact=${artifactPath}\n`
  );

  return containsAnswer ? 0 : 1;
}

async function main() {
  // Sanity: the artifact directory must be under _artifacts/ which is gitignored.
  const expectedRoot = join(REPO_ROOT, '_artifacts');
  if (!existsSync(REPO_ROOT)) {
    process.stderr.write(`[codex-two-turn] repo root not found: ${REPO_ROOT}\n`);
    process.exit(1);
  }
  void expectedRoot;

  try {
    const code = DRY_RUN ? await runDry() : await runLive();
    process.exit(code);
  } catch (err) {
    process.stderr.write(
      `[codex-two-turn] unhandled error: ${err && err.message ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

// Only auto-run when invoked as a script (not when imported by tests).
const isMainModule = (() => {
  try {
    const argv1 = process.argv[1] ? resolve(process.argv[1]) : '';
    return argv1 === resolve(__filename);
  } catch {
    return false;
  }
})();
if (isMainModule) {
  await main();
}
