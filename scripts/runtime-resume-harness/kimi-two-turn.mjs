#!/usr/bin/env node
/**
 * Kimi two-turn resume harness (Wave 2 / Track 8A.3 — standalone proof script).
 *
 * Spawns the `kimi` CLI headless twice:
 *   Turn 1: Tells Kimi to remember the number 47, captures the session_id
 *           emitted in the stream-json output (or, if absent, falls back to
 *           the `-r <uuid>` we passed in).
 *   Turn 2: Resumes the session via `-r <sessionId>` and asks Kimi
 *           what the number was. Validates the answer contains "47".
 *
 * NOTE on flag-name correctness (verified 2026-05-10):
 *   kimi-cli 1.34.x accepts `-r <ID>` to pre-assign / resume a session id.
 *   The `--session <id>` longform is documented in --help but the SHORT form
 *   `-r` is the contract Omniforge uses across CLIs (matches claude --resume
 *   semantics most closely). We use `-r` in the args list and the safety
 *   assertion confirms no `--yolo` / `--yes` / `-y` leakage.
 *
 * Writes a redacted markdown artifact to
 *   _artifacts/runtime-resume-harness/kimi-<timestamp>.md
 *
 * IMPORTANT: this script does NOT touch src/runtime/process-pool.ts,
 * src/executors/cli.ts, or any other production runtime/executor code.
 * It is a standalone proof harness exercised by Wave 2 of Track 8A.3.
 *
 * Architect Agent E directive: cli.ts `case 'kimi'` MUST NOT be modified
 * until this harness PASSes 5/5 across two kimi versions. This script
 * provides ONLY the harness + workspace-boundary defensive checks.
 *
 * Detected `kimi` CLI version when this script was authored: 1.34.0.
 *
 * Flags discovered via `kimi --help` (kimi-cli 1.34.0):
 *   --print                       non-interactive mode (warning: implicitly
 *                                 adds --yolo server-side; we never pass
 *                                 --yolo explicitly and rely on the
 *                                 workspace-boundary diff to catch any
 *                                 unwanted writes)
 *   --output-format stream-json   structured JSONL events on stdout
 *                                 (must be combined with --print)
 *   --input-format text           prompt is delivered via stdin (default)
 *   --session <id> | -S <id> | -r turn 1: pre-assign session id;
 *                                 turn 2: resume that session id
 *   --continue | -C               continue last session for the cwd
 *                                 (used as fallback if --session resume
 *                                 fails — but kimi 1.34 has --session, so
 *                                 we use that primary path)
 *   -w / --work-dir               working directory (we set this to the
 *                                 ephemeral mkdtemp dir for sandboxing)
 *   -p / --prompt                 alternative to stdin; we use stdin
 *
 * Safety asserts (mandatory):
 *   1. We MUST NOT pass `--yolo` (or `--yes` / `--dangerously-skip-permissions`)
 *      explicitly. A pre-spawn assertion throws if any of these strings
 *      appear in our args list.
 *   2. We snapshot files in cwd before turn 1 and again after turn 2; any
 *      created files in cwd during a read-only "remember 47" probe are
 *      reported as artifact warnings.
 *   3. We walk REPO_ROOT/src for any new files created during the harness
 *      window. If ANY are found → verdict = WORKSPACE_LEAK (CRITICAL).
 *   4. Inside cwd we check for shadow-tree pattern (kimi creating a fake
 *      `src/`, `apps/`, `scripts/`, `docs/` to mimic the host project).
 *      If found → verdict = WORKSPACE_SHADOW_TREE (CRITICAL).
 *
 * Cross-dir secondary mode (--cross-dir):
 *   Runs turn 1 in cwd_A and turn 2 in cwd_B (different mkdtemp dirs).
 *   Verifies that resume preserves conversation context but writes are
 *   scoped to cwd_B (and that nothing leaks to cwd_A or REPO_ROOT/src).
 *
 * Usage:
 *   node scripts/runtime-resume-harness/kimi-two-turn.mjs
 *   node scripts/runtime-resume-harness/kimi-two-turn.mjs --dry-run
 *   node scripts/runtime-resume-harness/kimi-two-turn.mjs --cross-dir
 *
 * Exit codes:
 *   0 success (turn 2 contains "47" AND no workspace leak)
 *   1 failure (timeout, parse error, missing sessionId, wrong answer,
 *              workspace leak, or shadow-tree pattern)
 */

import { spawn } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has('--dry-run');
const CROSS_DIR = ARGV.has('--cross-dir');

const TURN_TIMEOUT_MS = 90_000; // kimi can be slower to first token than claude
const VERSION_TIMEOUT_MS = 10_000;
const ARTIFACT_MAX_BYTES = 8 * 1024;
const KIMI_BIN = process.env.OMNIFORGE_KIMI_BIN || 'kimi';

const TURN_1_PROMPT = 'Remember the number 47. Reply with just OK.';
const TURN_2_PROMPT = 'What was the number? Reply with just the digits.';

// Names of directories that, if created INSIDE cwd by kimi, would indicate a
// shadow-tree pattern (kimi mimicking the host project structure inside the
// sandbox — D-H2.073 escalation pattern).
const SHADOW_TREE_NAMES = new Set(['src', 'apps', 'scripts', 'docs', 'node_modules']);

// Flags that MUST NOT be present in our args list. `--print` implicitly adds
// `--yolo` server-side in kimi 1.34; that is a kimi behavior we cannot avoid
// without losing non-interactive output. We never pass `--yolo` ourselves,
// and the workspace-boundary diff is the actual safety net.
const FORBIDDEN_EXPLICIT_FLAGS = new Set([
  '--yolo',
  '--yes',
  '-y',
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
]);

/**
 * Pre-spawn assertion: kill the run before fork if any forbidden flag leaked
 * into the args list. This is the safety regression guard required by the
 * task spec.
 */
function assertNoForbiddenFlags(args, label) {
  for (const a of args) {
    if (FORBIDDEN_EXPLICIT_FLAGS.has(a)) {
      throw new Error(
        `[kimi-two-turn] safety regression in ${label}: forbidden flag ${a} in args ${JSON.stringify(args)}`
      );
    }
  }
}

/**
 * Truncate a sessionId for redacted artifact output.
 */
function redactSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '(none)';
  if (sessionId.length <= 8) return `${sessionId}...`;
  return `${sessionId.slice(0, 8)}...`;
}

/**
 * Best-effort scrub of any string that might contain a token, key, or secret.
 */
function scrubSecrets(str) {
  if (!str || typeof str !== 'string') return '';
  let out = str;
  out = out.replace(/\b(sk|pk|anthropic|moonshot|kimi|bearer)[-_a-z]*[-_=:]?[A-Za-z0-9_-]{16,}\b/gi, '(value redacted)');
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '(value redacted)');
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (m) => (m.length >= 40 ? '(value redacted)' : m));
  return out;
}

/**
 * Truncate-and-clean a model response for artifact embedding.
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
 * Recursively walk a directory and return a Map<relativePath, mtimeMs>.
 * Used to snapshot a workspace before/after spawn so we can diff for leaks.
 *
 * - Skips symlinks (we don't follow them — they could escape the sandbox).
 * - Caps walk depth at 8 to avoid runaway recursion if kimi creates a deep tree.
 * - Caps total entries at 50_000; if exceeded, returns a sentinel marker.
 */
function snapshotDir(rootPath, { maxDepth = 8, maxEntries = 50_000 } = {}) {
  /** @type {Map<string, number>} */
  const map = new Map();
  if (!existsSync(rootPath)) return map;
  let truncated = false;
  /** @param {string} dirAbs @param {number} depth @param {string} relPrefix */
  const walk = (dirAbs, depth, relPrefix) => {
    if (truncated) return;
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (truncated) return;
      if (map.size >= maxEntries) {
        truncated = true;
        return;
      }
      const childAbs = join(dirAbs, ent.name);
      const childRel = relPrefix ? `${relPrefix}${sep}${ent.name}` : ent.name;
      // Skip symlinks: don't follow, don't count.
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        // Note the directory itself with a sentinel mtime of -1 so the diff
        // catches new dirs even if no files inside them get tracked.
        try {
          const st = statSync(childAbs);
          map.set(`${childRel}${sep}`, st.mtimeMs);
        } catch {
          map.set(`${childRel}${sep}`, -1);
        }
        walk(childAbs, depth + 1, childRel);
      } else if (ent.isFile()) {
        try {
          const st = statSync(childAbs);
          map.set(childRel, st.mtimeMs);
        } catch {
          map.set(childRel, -1);
        }
      }
    }
  };
  walk(rootPath, 0, '');
  if (truncated) {
    map.set('__TRUNCATED__', -1);
  }
  return map;
}

/**
 * Diff two snapshots and return { created, modified } as arrays of relative paths.
 * - "created" = present in `after` but not in `before`.
 * - "modified" = present in both, mtimeMs changed.
 */
function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  for (const [k, v] of after) {
    if (k === '__TRUNCATED__') continue;
    if (!before.has(k)) {
      created.push(k);
    } else {
      const prev = before.get(k);
      if (prev !== v && v !== -1 && prev !== -1) modified.push(k);
    }
  }
  return { created, modified };
}

/**
 * Check `created` paths inside cwd for shadow-tree pattern (top-level dirs
 * matching SHADOW_TREE_NAMES).
 */
function detectShadowTree(createdPaths) {
  const hits = [];
  for (const p of createdPaths) {
    // Normalize to forward slash for consistent split, take first segment.
    const first = p.replace(/\\/g, '/').split('/')[0];
    if (SHADOW_TREE_NAMES.has(first)) {
      if (!hits.includes(first)) hits.push(first);
    }
  }
  return hits;
}

/**
 * Spawn `kimi` and return a promise that resolves with { stdout, stderr, code, timedOut, startedAt, finishedAt }.
 *
 * - shell: false (no shell metacharacter expansion).
 * - cwd: passed in by caller.
 * - timeout enforced manually so we can capture stdout up to the kill point.
 */
function runKimi({ args, prompt, cwd, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(KIMI_BIN, args, {
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
      const finishedAt = Date.now();
      resolvePromise({ stdout, stderr, code, signal, timedOut, startedAt, finishedAt });
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
 * Parse stream-json output line-by-line, looking for a session_id and any
 * assistant text blocks. kimi-cli stream-json is undocumented in the help
 * text, so we use a defensive parser that accepts several possible shapes:
 *   {"type":"system","session_id":"…"}
 *   {"type":"session","id":"…"}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"assistant","text":"…"}
 *   {"type":"message","role":"assistant","content":"…"}
 *   {"type":"result","result":"…"}
 * Any line that fails JSON.parse is appended verbatim to a `rawText` buffer
 * so the caller can still grep for "47" if the output turns out to be plain
 * text after all.
 */
function parseStreamJson(stdout) {
  let sessionId = null;
  const assistantChunks = [];
  let sawAnyJson = false;
  const lines = stdout.split(/\r?\n/);
  const rawText = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      rawText.push(line);
      continue;
    }
    sawAnyJson = true;
    if (!sessionId) {
      if (typeof evt.session_id === 'string') sessionId = evt.session_id;
      else if (evt.type === 'session' && typeof evt.id === 'string') sessionId = evt.id;
      else if (typeof evt.sessionId === 'string') sessionId = evt.sessionId;
    }
    // Several possible assistant-text shapes:
    if (evt.type === 'assistant') {
      if (typeof evt.text === 'string') assistantChunks.push(evt.text);
      if (evt.message && Array.isArray(evt.message.content)) {
        for (const block of evt.message.content) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            assistantChunks.push(block.text);
          }
        }
      }
    }
    if (evt.type === 'message' && evt.role === 'assistant' && typeof evt.content === 'string') {
      assistantChunks.push(evt.content);
    }
    if (evt.type === 'result' && typeof evt.result === 'string') {
      assistantChunks.push(evt.result);
    }
    if (evt.type === 'text' && typeof evt.text === 'string') {
      assistantChunks.push(evt.text);
    }
  }
  return {
    sessionId,
    assistantText: assistantChunks.join('').trim(),
    sawAnyJson,
    rawText: rawText.join('\n'),
  };
}

/**
 * Replace any UUID-looking token in an args array with a redacted form.
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
    '# Kimi two-turn resume harness — artifact',
    '',
    `- timestamp (UTC): ${report.timestamp}`,
    `- kimi binary: ${KIMI_BIN}`,
    `- detected version: ${report.detectedVersion || '(not captured)'}`,
    `- working directory turn 1 (ephemeral): ${report.cwdA}`,
    `- working directory turn 2 (ephemeral): ${report.cwdB}`,
    `- mode: ${report.crossDir ? 'cross-dir' : 'same-dir'}`,
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
    `- saw stream-json events: ${report.turn1SawJson ? 'yes' : 'no (output may have been plain text)'}`,
    '',
    '## Turn 2',
    '',
    `- prompt: ${JSON.stringify(report.turn2Prompt)}`,
    `- spawn exit code: ${report.turn2ExitCode}`,
    `- timed out: ${report.turn2TimedOut ? 'yes' : 'no'}`,
    `- saw stream-json events: ${report.turn2SawJson ? 'yes' : 'no (output may have been plain text)'}`,
    `- response (redacted, truncated): ${JSON.stringify(report.turn2Response)}`,
    `- contains "47": ${report.containsAnswer ? 'yes' : 'no'}`,
    '',
    '## Workspace boundary checks (D-H2.073 mitigation)',
    '',
    `- cwd_A files created during turn 1: ${report.cwdAFilesCreated.length} ${report.cwdAFilesCreated.length === 0 ? '(clean)' : ''}`,
    report.cwdAFilesCreated.length > 0
      ? `  - sample (max 10): ${JSON.stringify(report.cwdAFilesCreated.slice(0, 10))}`
      : '',
    `- cwd_B files created during turn 2: ${report.cwdBFilesCreated.length} ${report.cwdBFilesCreated.length === 0 ? '(clean)' : ''}`,
    report.cwdBFilesCreated.length > 0
      ? `  - sample (max 10): ${JSON.stringify(report.cwdBFilesCreated.slice(0, 10))}`
      : '',
    `- shadow-tree dirs detected in any cwd: ${report.shadowTreeHits.length === 0 ? '(none)' : JSON.stringify(report.shadowTreeHits)}`,
    `- new files in REPO_ROOT/src during harness window: ${report.repoSrcLeaks.length === 0 ? '(none — clean)' : JSON.stringify(report.repoSrcLeaks)}`,
    `- modified files in REPO_ROOT/src during harness window: ${report.repoSrcModified.length === 0 ? '(none — clean)' : JSON.stringify(report.repoSrcModified)}`,
    '',
    '## Notes',
    '',
    report.notes.length === 0 ? '(none)' : report.notes.map((n) => `- ${n}`).join('\n'),
    '',
  ].filter((l) => l !== '');
  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > ARTIFACT_MAX_BYTES) {
    const slice = Buffer.from(body, 'utf8').subarray(0, ARTIFACT_MAX_BYTES - 32).toString('utf8');
    body = `${slice}\n\n...(artifact truncated to 8 KB)\n`;
  }
  return body;
}

/**
 * Dry run: print the plan without spawning anything. Still produces an
 * artifact so we can verify the redaction path.
 */
async function runDry() {
  const sessionId = randomUUID();
  const cwdA = mkdtempSync(join(tmpdir(), 'kimi-harness-dry-A-'));
  const cwdB = CROSS_DIR ? mkdtempSync(join(tmpdir(), 'kimi-harness-dry-B-')) : cwdA;
  const turn1Args = [
    '--print',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '-r', sessionId,
    '-w', cwdA,
  ];
  const turn2Args = [
    '--print',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '-r', sessionId,
    '-w', cwdB,
  ];

  // Honor the safety assertion even in dry-run so it'd fail fast if someone
  // refactored the args lists incorrectly.
  assertNoForbiddenFlags(turn1Args, 'turn 1 (dry-run)');
  assertNoForbiddenFlags(turn2Args, 'turn 2 (dry-run)');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `kimi-${timestamp}-dryrun.md`);

  const report = {
    timestamp,
    detectedVersion: '1.34.0 (dry run — not actually invoked)',
    cwdA,
    cwdB,
    crossDir: CROSS_DIR,
    dryRun: true,
    verdict: 'DRY-RUN (no spawn)',
    turn1Args,
    turn2Args,
    turn1Prompt: TURN_1_PROMPT,
    turn2Prompt: TURN_2_PROMPT,
    sessionId,
    turn1ExitCode: '(n/a)',
    turn1TimedOut: false,
    turn1SawJson: false,
    turn2ExitCode: '(n/a)',
    turn2TimedOut: false,
    turn2SawJson: false,
    turn2Response: '(n/a — dry run)',
    containsAnswer: false,
    cwdAFilesCreated: [],
    cwdBFilesCreated: [],
    shadowTreeHits: [],
    repoSrcLeaks: [],
    repoSrcModified: [],
    notes: [
      'Dry run: no kimi process was spawned.',
      'Real run would write turn 1 prompt to stdin, parse stream-json events for session_id, then resume via -r <id> for turn 2.',
      'No --yolo / --yes / -y / --dangerously-skip-permissions are passed explicitly. Note: kimi `--print` mode "implicitly adds --yolo" server-side per its --help; we cannot opt out without losing non-interactive output. Workspace-boundary diff is the safety net for that implicit behavior.',
      CROSS_DIR
        ? 'cross-dir mode: turn 1 in cwd_A, turn 2 in cwd_B (different mkdtemp dirs). Resume should preserve conversation context but writes scoped to cwd_B.'
        : 'same-dir mode: both turns in cwd_A.',
    ],
  };

  writeFileSync(artifactPath, buildArtifact(report), 'utf8');
  process.stdout.write(`[dry-run] artifact written: ${artifactPath}\n`);
  return 0;
}

/**
 * Live run: spawn turn 1, capture sessionId, spawn turn 2, validate, then
 * run all workspace-boundary checks.
 */
async function runLive() {
  const cwdA = mkdtempSync(join(tmpdir(), 'kimi-harness-A-'));
  const cwdB = CROSS_DIR ? mkdtempSync(join(tmpdir(), 'kimi-harness-B-')) : cwdA;
  const explicitSessionId = randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const notes = [];
  let detectedVersion = '';

  // ---- Snapshot REPO_ROOT/src BEFORE anything runs ---------------------
  // This gives us the baseline to compare against post-harness for the
  // workspace-leak check (D-H2.073 mitigation, MANDATORY).
  const repoSrcRoot = join(REPO_ROOT, 'src');
  const repoSrcBefore = snapshotDir(repoSrcRoot, { maxDepth: 12, maxEntries: 100_000 });
  if (repoSrcBefore.has('__TRUNCATED__')) {
    notes.push('REPO_ROOT/src snapshot was truncated at 100k entries; leak detection is partial.');
  }

  // ---- Capture version into the artifact for traceability --------------
  try {
    const v = await runKimi({ args: ['--version'], prompt: undefined, cwd: cwdA, timeoutMs: VERSION_TIMEOUT_MS });
    detectedVersion = (v.stdout || v.stderr || '').toString().trim().slice(0, 120);
  } catch (err) {
    notes.push(`Failed to capture --version: ${err && err.message ? err.message : String(err)}`);
  }

  // ---- Snapshot cwd_A BEFORE turn 1 ------------------------------------
  const cwdABefore = snapshotDir(cwdA);

  // ---- Turn 1 -----------------------------------------------------------
  const turn1Args = [
    '--print',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '-r', explicitSessionId,
    '-w', cwdA,
  ];
  assertNoForbiddenFlags(turn1Args, 'turn 1');

  const t1 = await runKimi({
    args: turn1Args,
    prompt: TURN_1_PROMPT,
    cwd: cwdA,
    timeoutMs: TURN_TIMEOUT_MS,
  });

  const t1Parsed = parseStreamJson(t1.stdout);
  let sessionId = t1Parsed.sessionId || explicitSessionId;

  if (t1.timedOut) notes.push('Turn 1 timed out (90s).');
  if (t1.code !== 0 && t1.code !== null) notes.push(`Turn 1 exited with code ${t1.code}.`);
  if (!t1Parsed.sessionId) {
    notes.push('Turn 1 stream-json did not contain a session_id event; falling back to the -r id we passed.');
  }
  if (!t1Parsed.sawAnyJson) {
    notes.push('Turn 1 produced no parseable JSON; harness will grep raw text for "47" as fallback.');
  }
  if (t1.stderr && t1.stderr.trim()) {
    notes.push(`Turn 1 stderr (scrubbed, capped 200): ${scrubSecrets(t1.stderr).slice(0, 200)}`);
  }

  // ---- Snapshot cwd_A AFTER turn 1 -------------------------------------
  const cwdAAfterT1 = snapshotDir(cwdA);
  const cwdABefore2 = CROSS_DIR ? snapshotDir(cwdB) : cwdAAfterT1;

  // ---- Turn 2 -----------------------------------------------------------
  const turn2Args = [
    '--print',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '-r', sessionId,
    '-w', cwdB,
  ];
  assertNoForbiddenFlags(turn2Args, 'turn 2');

  let t2 = { stdout: '', stderr: '', code: null, timedOut: false, startedAt: 0, finishedAt: 0 };
  let t2Parsed = { sessionId: null, assistantText: '', sawAnyJson: false, rawText: '' };
  if (!t1.timedOut && (t1.code === 0 || t1.code === null)) {
    t2 = await runKimi({
      args: turn2Args,
      prompt: TURN_2_PROMPT,
      cwd: cwdB,
      timeoutMs: TURN_TIMEOUT_MS,
    });
    t2Parsed = parseStreamJson(t2.stdout);
    if (t2.timedOut) notes.push('Turn 2 timed out (90s).');
    if (t2.code !== 0 && t2.code !== null) notes.push(`Turn 2 exited with code ${t2.code}.`);
    if (t2.stderr && t2.stderr.trim()) {
      notes.push(`Turn 2 stderr (scrubbed, capped 200): ${scrubSecrets(t2.stderr).slice(0, 200)}`);
    }
  } else {
    notes.push('Turn 2 skipped because turn 1 failed.');
  }

  // ---- Snapshot cwd_B AFTER turn 2 + REPO_ROOT/src AFTER everything ----
  const cwdBAfter = snapshotDir(cwdB);
  const repoSrcAfter = snapshotDir(repoSrcRoot, { maxDepth: 12, maxEntries: 100_000 });

  // ---- Workspace boundary diffs ----------------------------------------
  const cwdADiff = diffSnapshots(cwdABefore, cwdAAfterT1);
  const cwdBDiff = CROSS_DIR
    ? diffSnapshots(cwdABefore2, cwdBAfter)
    : diffSnapshots(cwdAAfterT1, cwdBAfter);
  const repoSrcDiff = diffSnapshots(repoSrcBefore, repoSrcAfter);

  const cwdAFilesCreated = cwdADiff.created.filter((p) => !p.endsWith(sep));
  const cwdBFilesCreated = cwdBDiff.created.filter((p) => !p.endsWith(sep));

  const shadowTreeHits = [
    ...detectShadowTree(cwdADiff.created),
    ...detectShadowTree(cwdBDiff.created),
  ].filter((v, i, arr) => arr.indexOf(v) === i);

  // For REPO_ROOT/src leaks, only count files created or modified during the
  // harness window (between t1.startedAt and t2.finishedAt). This avoids
  // false positives if some other process is touching src/ during the run.
  const harnessStart = t1.startedAt || Date.now() - 5 * 60_000;
  const harnessEnd = t2.finishedAt || Date.now();
  const repoSrcLeaks = repoSrcDiff.created.filter((p) => !p.endsWith(sep));
  const repoSrcModified = repoSrcDiff.modified.filter((p) => {
    const mt = repoSrcAfter.get(p);
    return typeof mt === 'number' && mt >= harnessStart && mt <= harnessEnd + 5_000;
  });

  // ---- Verdict ----------------------------------------------------------
  const turn2Combined = (t2Parsed.assistantText || '') + '\n' + (t2Parsed.rawText || '') + '\n' + (t2.stdout || '');
  const turn2ResponseClean = cleanResponse(t2Parsed.assistantText || t2Parsed.rawText || t2.stdout);
  const containsAnswer = /\b47\b/.test(turn2Combined);

  let verdict;
  if (repoSrcLeaks.length > 0 || repoSrcModified.length > 0) {
    verdict = 'WORKSPACE_LEAK';
  } else if (shadowTreeHits.length > 0) {
    verdict = 'WORKSPACE_SHADOW_TREE';
  } else if (containsAnswer) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL';
  }

  const report = {
    timestamp,
    detectedVersion: scrubSecrets(detectedVersion),
    cwdA,
    cwdB,
    crossDir: CROSS_DIR,
    dryRun: false,
    verdict,
    turn1Args,
    turn2Args,
    turn1Prompt: TURN_1_PROMPT,
    turn2Prompt: TURN_2_PROMPT,
    sessionId,
    turn1ExitCode: t1.code,
    turn1TimedOut: t1.timedOut,
    turn1SawJson: t1Parsed.sawAnyJson,
    turn2ExitCode: t2.code,
    turn2TimedOut: t2.timedOut,
    turn2SawJson: t2Parsed.sawAnyJson,
    turn2Response: turn2ResponseClean,
    containsAnswer,
    cwdAFilesCreated,
    cwdBFilesCreated,
    shadowTreeHits,
    repoSrcLeaks,
    repoSrcModified,
    notes,
  };

  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `kimi-${timestamp}.md`);
  writeFileSync(artifactPath, buildArtifact(report), 'utf8');

  process.stdout.write(
    `[kimi-two-turn] verdict=${verdict} sessionId=${redactSessionId(sessionId)} mode=${CROSS_DIR ? 'cross-dir' : 'same-dir'} artifact=${artifactPath}\n`
  );

  return verdict === 'PASS' ? 0 : 1;
}

async function main() {
  if (!existsSync(REPO_ROOT)) {
    process.stderr.write(`[kimi-two-turn] repo root not found: ${REPO_ROOT}\n`);
    process.exit(1);
  }

  try {
    const code = DRY_RUN ? await runDry() : await runLive();
    process.exit(code);
  } catch (err) {
    process.stderr.write(
      `[kimi-two-turn] unhandled error: ${err && err.message ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

await main();
