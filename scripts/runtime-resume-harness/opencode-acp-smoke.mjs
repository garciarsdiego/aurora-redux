#!/usr/bin/env node
/**
 * Wave D — opencode ACP smoke (standalone end-to-end).
 *
 * Proves the end-to-end path Aurora's `runOpencodeViaAcp` will take in
 * production:
 *
 *   spawn(opencode acp --cwd <tmp>) → AcpStdioClient (inline)
 *     ├── initialize
 *     ├── session/new                     → opaque sessionId
 *     ├── session/prompt "Reply with exactly OK"
 *     │     └── session/update notifications captured
 *     ├── session/close
 *     └── child.stdin.end() + SIGTERM grace + SIGKILL fallback
 *
 * Writes a redacted markdown artifact to
 *   _artifacts/runtime-resume-harness/opencode-acp-smoke-<timestamp>.md
 *
 * Standalone: imports nothing from Aurora's `src/` tree. Mirrors
 * `scripts/runtime-resume-harness/opencode-acp-probe.mjs` so when this passes,
 * the Wave C adapter MUST work (it speaks the same wire format).
 *
 * Usage:
 *   node scripts/runtime-resume-harness/opencode-acp-smoke.mjs            # live opencode
 *   node scripts/runtime-resume-harness/opencode-acp-smoke.mjs --dry-run  # exit 0 without spawn
 *   node scripts/runtime-resume-harness/opencode-acp-smoke.mjs --debug
 *
 * Env:
 *   OMNIFORGE_OPENCODE_BIN     — opencode binary (default 'opencode')
 *   OMNIFORGE_OPENCODE_MODEL   — provider/model passed in session/new
 *
 * Exit:
 *   0  initialize + session/new + session/prompt + at least one notification + clean shutdown
 *   1  any failure
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname, delimiter as PATH_DELIM } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, platform } from 'node:os';

// ─── Constants ───────────────────────────────────────────────────────────────

const IS_WIN = platform() === 'win32';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const ARGV = new Set(process.argv.slice(2));
const DEBUG = ARGV.has('--debug') || process.env.OMNIFORGE_ACP_SMOKE_DEBUG === '1';
const DRY_RUN = ARGV.has('--dry-run');

const OPENCODE_BIN = process.env.OMNIFORGE_OPENCODE_BIN || 'opencode';
const TRIVIAL_PROMPT = 'Reply with exactly the two characters: OK';

const INITIALIZE_TIMEOUT_MS = 15_000;
const SESSION_NEW_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 4_000;
const ARTIFACT_MAX_BYTES = 16 * 1024;

// ─── Logging / redaction ─────────────────────────────────────────────────────

function dbg(...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  process.stderr.write(`[acp-smoke ${ts}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

function scrubSecrets(str) {
  if (typeof str !== 'string' || !str) return '';
  let out = str;
  out = out.replace(/\b(sk|pk|anthropic|bearer)[-_a-z]*[-_=:]?[A-Za-z0-9_-]{16,}\b/gi, '(value redacted)');
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '(value redacted)');
  return out;
}

function redactSessionId(id) {
  if (!id || typeof id !== 'string') return '(none)';
  return id.length <= 8 ? `${id}...` : `${id.slice(0, 8)}...`;
}

function truncate(value, maxLen = 200) {
  if (value === null || value === undefined) return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const cleaned = scrubSecrets(s);
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen)}...(truncated ${cleaned.length - maxLen} chars)`;
}

// ─── Bin resolution ──────────────────────────────────────────────────────────

function resolveOpencodeBinary(name) {
  if (name.includes('/') || name.includes('\\')) {
    return { path: name, useShell: IS_WIN && /\.cmd$|\.bat$/i.test(name) };
  }
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(PATH_DELIM).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`);
      try {
        const st = statSync(candidate);
        if (st.isFile()) {
          return { path: candidate, useShell: IS_WIN && /\.cmd$|\.bat$/i.test(candidate) };
        }
      } catch { /* not present */ }
    }
  }
  return { path: name, useShell: IS_WIN };
}

// ─── Inline ACP JSON-RPC client (mirrors scripts/runtime-resume-harness/opencode-acp-probe.mjs) ─

class InlineAcpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.responses = [];
    this.requestsToServer = [];
    this.stdoutBuffer = '';
    this.stderrChunks = [];
    this.closed = false;
    this.handlers = new Set();

    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrChunks.push(chunk);
      if (DEBUG) dbg('stderr', truncate(chunk.toString('utf8'), 240));
    });
    child.on('close', (code, signal) => {
      this.closed = true;
      this.exitCode = code;
      this.exitSignal = signal;
      for (const [id, p] of this.pending) {
        p.reject(new Error(`acp client closed before response (method=${p.method}, id=${id}, code=${code})`));
      }
      this.pending.clear();
    });
    child.on('error', (err) => {
      this.closed = true;
      this.spawnError = err;
      for (const [id, p] of this.pending) {
        p.reject(new Error(`acp client errored: ${err.message} (method=${p.method}, id=${id})`));
      }
      this.pending.clear();
    });
  }

  onNotification(fn) {
    this.handlers.add(fn);
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      this._handleLine(trimmed);
    }
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.jsonrpc !== '2.0') return;
    const receivedAt = Date.now();
    const hasId = 'id' in msg && msg.id !== null && msg.id !== undefined;
    const hasMethod = typeof msg.method === 'string';

    if (hasId && !hasMethod) {
      const pend = this.pending.get(msg.id);
      if (pend) {
        const latencyMs = receivedAt - pend.sentAt;
        this.responses.push({ id: msg.id, method: pend.method, result: msg.result, error: msg.error, receivedAt, latencyMs });
        this.pending.delete(msg.id);
        if (msg.error) pend.reject(Object.assign(new Error('jsonrpc error'), { jsonRpcError: msg.error }));
        else pend.resolve(msg.result);
      }
      return;
    }
    if (hasMethod && !hasId) {
      this.notifications.push({ method: msg.method, params: msg.params, receivedAt });
      for (const h of this.handlers) { try { h(msg); } catch { /* ignore */ } }
      return;
    }
    if (hasMethod && hasId) {
      this.requestsToServer.push({ method: msg.method, params: msg.params, id: msg.id, receivedAt });
      // Auto-reject any server-to-client request — smoke does not grant permissions.
      this._writeRaw({
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { type: 'cancelled' }, allowed: false, granted: false },
      });
    }
  }

  _writeRaw(obj) {
    if (this.closed) return;
    const line = `${JSON.stringify(obj)}\n`;
    try {
      this.child.stdin.write(line);
      if (DEBUG) dbg('outbound', truncate(JSON.stringify(obj), 240));
    } catch (err) {
      dbg('write failed', err.message);
    }
  }

  request(method, params, timeoutMs = INITIALIZE_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error(`cannot request ${method} — client closed`));
    const id = this.nextId++;
    const sentAt = Date.now();
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rejectP(new Error(`request timeout for ${method} after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        method,
        sentAt,
        resolve: (v) => { clearTimeout(timer); resolveP(v); },
        reject: (e) => { clearTimeout(timer); rejectP(e); },
      });
      this._writeRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this._writeRaw({ jsonrpc: '2.0', method, params });
  }
}

// ─── Smoke flow ──────────────────────────────────────────────────────────────

async function runSmoke() {
  const startedAt = Date.now();
  const tmpDir = mkdtempSync(join(tmpdir(), 'opencode-acp-smoke-'));
  dbg('temp cwd', tmpDir);

  if (DRY_RUN) {
    return {
      tmpDir,
      startedAt,
      endedAt: Date.now(),
      verdict: 'DRY_RUN',
      observations: { dryRun: true },
      stderr: '',
      notifications: 0,
      responses: 0,
      sessionId: null,
      promptResult: null,
    };
  }

  const resolved = resolveOpencodeBinary(OPENCODE_BIN);
  dbg('resolved', resolved.path, 'useShell=', resolved.useShell);

  const child = spawn(resolved.path, ['acp', '--cwd', tmpDir], {
    shell: resolved.useShell,
    cwd: tmpDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });

  const client = new InlineAcpClient(child);
  const observations = {
    initializeOK: false,
    initializeError: null,
    sessionId: null,
    sessionNewError: null,
    promptResult: null,
    promptError: null,
    closeError: null,
    notificationsObserved: [],
  };

  client.onNotification((notif) => {
    if (typeof notif.method === 'string' && notif.method.startsWith('session/')) {
      observations.notificationsObserved.push({
        method: notif.method,
        sample: truncate(JSON.stringify(notif.params ?? {}), 160),
      });
    }
  });

  let smokeError = null;
  try {
    // 1. initialize
    try {
      const initResult = await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'aurora-acp-smoke', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, INITIALIZE_TIMEOUT_MS);
      observations.initializeOK = true;
      observations.initializeResult = {
        protocolVersion: initResult?.protocolVersion ?? null,
        agentInfo: initResult?.agentInfo ?? null,
      };
      dbg('initialize OK');
    } catch (err) {
      observations.initializeError = err.jsonRpcError ?? { message: err.message };
      smokeError = `initialize failed: ${err.message}`;
    }

    // 2. session/new
    if (!smokeError) {
      try {
        const newResult = await client.request('session/new', {
          cwd: tmpDir,
          mcpServers: [],
        }, SESSION_NEW_TIMEOUT_MS);
        observations.sessionId = newResult?.sessionId ?? null;
        if (!observations.sessionId) {
          smokeError = 'session/new returned no sessionId';
        } else {
          dbg('session/new OK', redactSessionId(observations.sessionId));
        }
      } catch (err) {
        observations.sessionNewError = err.jsonRpcError ?? { message: err.message };
        smokeError = `session/new failed: ${err.message}`;
      }
    }

    // 3. session/prompt — accumulate text from notifications + the response.
    if (!smokeError && observations.sessionId) {
      let assistantBuffer = '';
      client.onNotification((notif) => {
        if (notif?.method !== 'session/update') return;
        const update = notif.params?.update ?? {};
        const kind = update.sessionUpdate ?? update.type;
        if (kind === 'message_chunk' && typeof update.text === 'string') {
          assistantBuffer += update.text;
        }
      });
      try {
        const promptResult = await client.request('session/prompt', {
          sessionId: observations.sessionId,
          prompt: [{ type: 'text', text: TRIVIAL_PROMPT }],
        }, PROMPT_TIMEOUT_MS);
        observations.promptResult = {
          stopReason: promptResult?.stopReason ?? 'unknown',
          usage: promptResult?.usage ?? null,
          accumulatedTextSample: truncate(assistantBuffer, 240),
          accumulatedChars: assistantBuffer.length,
        };
        dbg('session/prompt OK', observations.promptResult.stopReason);
      } catch (err) {
        observations.promptError = err.jsonRpcError ?? { message: err.message };
        smokeError = `session/prompt failed: ${err.message}`;
      }
    }

    // 4. session/close
    if (observations.sessionId) {
      try {
        await client.request('session/close', { sessionId: observations.sessionId }, CLOSE_TIMEOUT_MS);
      } catch (err) {
        observations.closeError = err.jsonRpcError ?? { message: err.message };
      }
    }
  } finally {
    // 5. graceful shutdown
    try { child.stdin.end(); } catch { /* ignore */ }
    await Promise.race([
      new Promise((resolveP) => child.once('close', resolveP)),
      new Promise((resolveP) => setTimeout(resolveP, SHUTDOWN_GRACE_MS)),
    ]);
    if (!client.closed) {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      await Promise.race([
        new Promise((resolveP) => child.once('close', resolveP)),
        new Promise((resolveP) => setTimeout(resolveP, 2_000)),
      ]);
    }
    if (!client.closed) {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }

  const verdict = smokeError ? 'FAIL'
    : (observations.initializeOK && observations.sessionId && observations.promptResult ? 'PASS' : 'PARTIAL');

  return {
    tmpDir,
    startedAt,
    endedAt: Date.now(),
    verdict,
    smokeError,
    observations,
    stderr: Buffer.concat(client.stderrChunks).toString('utf8'),
    notifications: client.notifications.length,
    responses: client.responses.length,
    sessionId: observations.sessionId,
    promptResult: observations.promptResult,
  };
}

// ─── Artifact ────────────────────────────────────────────────────────────────

function buildArtifact(smoke) {
  const lines = [];
  lines.push('# opencode ACP smoke (Wave D) — artifact');
  lines.push('');
  lines.push(`- timestamp (UTC): ${new Date(smoke.startedAt).toISOString()}`);
  lines.push(`- verdict: **${smoke.verdict}**`);
  lines.push(`- duration: ${smoke.endedAt - smoke.startedAt} ms`);
  lines.push(`- working directory (ephemeral, redacted): ${smoke.tmpDir.replace(/^.*[\\/]/, '<tmp>/')}`);
  if (smoke.smokeError) lines.push(`- smoke error: ${truncate(smoke.smokeError, 200)}`);
  lines.push('');

  if (smoke.verdict === 'DRY_RUN') {
    lines.push('## Dry-run');
    lines.push('');
    lines.push('No live opencode subprocess spawned. Module loads cleanly and the temp cwd was created/destroyed.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('## Lifecycle observations');
  lines.push('');
  lines.push(`- initialize OK: ${smoke.observations.initializeOK ? 'yes' : 'no'}`);
  if (smoke.observations.initializeError) {
    lines.push(`- initialize error: \`${truncate(JSON.stringify(smoke.observations.initializeError), 200)}\``);
  }
  lines.push(`- sessionId captured: ${smoke.observations.sessionId ? 'yes' : 'no'} (${redactSessionId(smoke.observations.sessionId)})`);
  if (smoke.observations.sessionNewError) {
    lines.push(`- session/new error: \`${truncate(JSON.stringify(smoke.observations.sessionNewError), 200)}\``);
  }
  if (smoke.observations.promptResult) {
    lines.push(`- prompt stopReason: ${smoke.observations.promptResult.stopReason}`);
    lines.push(`- accumulated chars: ${smoke.observations.promptResult.accumulatedChars}`);
    lines.push(`- prompt sample (redacted, capped): \`${(smoke.observations.promptResult.accumulatedTextSample || '').replace(/`/g, '\\`')}\``);
  } else if (smoke.observations.promptError) {
    lines.push(`- prompt error: \`${truncate(JSON.stringify(smoke.observations.promptError), 200)}\``);
  }
  if (smoke.observations.closeError) {
    lines.push(`- session/close error: \`${truncate(JSON.stringify(smoke.observations.closeError), 200)}\``);
  }
  lines.push('');
  lines.push(`- inbound notifications: ${smoke.notifications}`);
  lines.push(`- inbound responses: ${smoke.responses}`);
  lines.push('');

  if (smoke.observations.notificationsObserved?.length) {
    lines.push('## Notifications observed');
    lines.push('');
    lines.push('| method | sample |');
    lines.push('|---|---|');
    for (const notif of smoke.observations.notificationsObserved.slice(0, 10)) {
      lines.push(`| \`${notif.method}\` | \`${(notif.sample || '').replace(/\|/g, '\\|')}\` |`);
    }
    if (smoke.observations.notificationsObserved.length > 10) {
      lines.push(`| ... | (${smoke.observations.notificationsObserved.length - 10} more truncated) |`);
    }
    lines.push('');
  }

  lines.push('## Stderr (scrubbed, capped 600 chars)');
  lines.push('');
  lines.push('```');
  lines.push(truncate(smoke.stderr.trim() || '(empty)', 600));
  lines.push('```');
  lines.push('');

  let body = lines.join('\n');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > ARTIFACT_MAX_BYTES) {
    const slice = Buffer.from(body, 'utf8').subarray(0, ARTIFACT_MAX_BYTES - 64).toString('utf8');
    body = `${slice}\n\n...(artifact truncated to 16 KB cap)\n`;
  }
  return body;
}

// ─── Entry ───────────────────────────────────────────────────────────────────

async function main() {
  let smoke;
  try {
    smoke = await runSmoke();
  } catch (err) {
    process.stderr.write(`[acp-smoke] unhandled error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const timestamp = new Date(smoke.startedAt).toISOString().replace(/[:.]/g, '-');
  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `opencode-acp-smoke-${timestamp}${DRY_RUN ? '-dryrun' : ''}.md`);
  writeFileSync(artifactPath, buildArtifact(smoke), 'utf8');

  try {
    rmSync(smoke.tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[acp-smoke] tmp cleanup failed: ${err && err.message ? err.message : String(err)}\n`);
  }

  const exitCode = smoke.verdict === 'PASS' || smoke.verdict === 'DRY_RUN' ? 0 : 1;
  process.stdout.write(
    `[acp-smoke] verdict=${smoke.verdict} sessionId=${redactSessionId(smoke.sessionId)} ` +
    `notifications=${smoke.notifications} responses=${smoke.responses} ` +
    `artifact=${artifactPath}\n`,
  );
  process.exit(exitCode);
}

await main();
