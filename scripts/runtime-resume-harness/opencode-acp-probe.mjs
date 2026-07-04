#!/usr/bin/env node
/**
 * opencode ACP stdio probe (Wave 1 / Task 8B.1.ACP).
 *
 * Spawns `opencode acp` with stdio, implements a minimal ACP JSON-RPC 2.0
 * client over line-delimited JSON, and runs the lifecycle:
 *
 *   initialize        -> capture protocolVersion + agentCapabilities
 *   session/new       -> capture sessionId
 *   session/prompt    -> trigger an LLM round-trip
 *   session/update*   -> stream notifications captured
 *   session/cancel    -> sent after first 1-2 updates, observe propagation
 *   session/end (best-effort) + close stdin -> verify clean exit
 *
 * Writes a redacted markdown artifact to
 *   _artifacts/runtime-resume-harness/opencode-acp-<timestamp>.md
 *
 * IMPORTANT: this script is standalone — it does NOT import anything from the
 * Aurora `src/` tree. Its purpose is to ground-truth the actual JSON-RPC
 * methods opencode uses so Wave 3 can rewrite `src/runtime/adapters/acp.ts`.
 *
 * Usage:
 *   node scripts/runtime-resume-harness/opencode-acp-probe.mjs
 *   node scripts/runtime-resume-harness/opencode-acp-probe.mjs --debug
 *   node scripts/runtime-resume-harness/opencode-acp-probe.mjs --no-cancel
 *
 * Exit codes:
 *   0  initialize + session/new + at least one inbound message succeeded
 *   1  spawn error, transport error, or no protocol roundtrip observed
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve, dirname, delimiter as PATH_DELIM } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, platform } from 'node:os';

const IS_WIN = platform() === 'win32';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const ARGV = new Set(process.argv.slice(2));
const DEBUG = ARGV.has('--debug') || process.env.OMNIFORGE_ACP_DEBUG === '1';
const SKIP_CANCEL = ARGV.has('--no-cancel');

const OPENCODE_BIN = process.env.OMNIFORGE_OPENCODE_BIN || 'opencode';
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Resolve the actual binary path by walking PATH ourselves and probing
 * platform-specific extensions. Returns either an absolute path (preferred)
 * or the bare name (which we'll then have to spawn via shell on Windows).
 */
function resolveOpencodeBinary(name) {
  if (name.includes('/') || name.includes('\\')) {
    // explicit path; trust it
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
      } catch { /* not present — keep looking */ }
    }
  }
  // fallback — let spawn try (will likely ENOENT, but record it)
  return { path: name, useShell: IS_WIN };
}

const INITIALIZE_TIMEOUT_MS = 15_000;
const SESSION_NEW_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 30_000;
const POST_CANCEL_GRACE_MS = 4_000;
const ARTIFACT_MAX_BYTES = 16 * 1024;
const TRIVIAL_PROMPT = 'Reply with exactly the two characters: OK';

// --------------------------------------------------------------------------
// debug logger -> stderr (never persisted)
// --------------------------------------------------------------------------
function dbg(...args) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  process.stderr.write(`[acp-probe ${ts}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
}

// --------------------------------------------------------------------------
// redaction helpers
// --------------------------------------------------------------------------
function redactSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return '(none)';
  if (sessionId.length <= 8) return `${sessionId}...`;
  return `${sessionId.slice(0, 8)}...`;
}

function scrubSecrets(str) {
  if (!str || typeof str !== 'string') return '';
  let out = str;
  out = out.replace(/\b(sk|pk|anthropic|bearer)[-_a-z]*[-_=:]?[A-Za-z0-9_-]{16,}\b/gi, '(value redacted)');
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '(value redacted)');
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (m) => (m.length >= 40 ? '(value redacted)' : m));
  return out;
}

function truncateField(value, maxLen = 200) {
  if (value === null || value === undefined) return value;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const cleaned = scrubSecrets(s);
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen)}...(truncated ${cleaned.length - maxLen} chars)`;
}

function topLevelKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).sort();
}

function shapeSample(obj, maxLen = 180) {
  try {
    const json = JSON.stringify(obj);
    return truncateField(json, maxLen);
  } catch {
    return '(non-serializable)';
  }
}

// --------------------------------------------------------------------------
// JSON-RPC 2.0 client over stdio (line-delimited JSON)
// --------------------------------------------------------------------------
class AcpStdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, method, sentAt }
    this.notifications = []; // { method, params, receivedAt }
    this.responses = []; // { id, result?, error?, receivedAt, latencyMs, method }
    this.requestsToServer = []; // requests the server sent us (id present, method present)
    this.allInbound = []; // raw record of every parsed inbound message
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.closed = false;
    this.handlers = new Set(); // notification listeners

    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.stderrBuffer += text;
      if (DEBUG) dbg('stderr-chunk', truncateField(text, 240));
    });
    child.on('close', (code, signal) => {
      this.closed = true;
      this.exitCode = code;
      this.exitSignal = signal;
      // reject any still-pending requests
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
    // line-delimited JSON: split on \n, keep last partial line in buffer
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
    try {
      msg = JSON.parse(line);
    } catch (err) {
      dbg('non-json line on stdout (truncated):', truncateField(line, 200));
      return;
    }
    if (!msg || typeof msg !== 'object') {
      dbg('inbound was not a JSON object:', truncateField(line, 200));
      return;
    }
    if (msg.jsonrpc !== '2.0') {
      dbg('inbound missing jsonrpc 2.0:', truncateField(JSON.stringify(msg), 200));
      // still record for debugging
    }
    const receivedAt = Date.now();
    this.allInbound.push({ receivedAt, msg });
    dbg('inbound', truncateField(JSON.stringify(msg), 240));

    // Response (id present, no method)
    if ('id' in msg && msg.id !== null && msg.id !== undefined && !('method' in msg && typeof msg.method === 'string')) {
      const pend = this.pending.get(msg.id);
      if (pend) {
        const latencyMs = receivedAt - pend.sentAt;
        this.responses.push({
          id: msg.id,
          method: pend.method,
          result: msg.result,
          error: msg.error,
          receivedAt,
          latencyMs,
        });
        this.pending.delete(msg.id);
        if (msg.error) pend.reject(Object.assign(new Error('jsonrpc error'), { jsonRpcError: msg.error }));
        else pend.resolve(msg.result);
      } else {
        dbg('response for unknown id', msg.id);
      }
      return;
    }

    // Notification (method present, no id)
    if (typeof msg.method === 'string' && (msg.id === undefined || msg.id === null)) {
      this.notifications.push({ method: msg.method, params: msg.params, receivedAt });
      for (const h of this.handlers) {
        try { h(msg); } catch (err) { dbg('notif handler threw', err.message); }
      }
      return;
    }

    // Server-to-client request (method + id present)
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      this.requestsToServer.push({ method: msg.method, params: msg.params, id: msg.id, receivedAt });
      // Auto-reply with a minimal "we don't support that" / generic deny so
      // opencode doesn't hang waiting for us. We never auto-grant permissions.
      this._autoReplyToServerRequest(msg);
      return;
    }

    dbg('unrecognized inbound shape (kept in allInbound only)');
  }

  _autoReplyToServerRequest(req) {
    // Heuristic: if the method name contains "permission" or "grant" or "request",
    // deny gracefully. Otherwise return a best-effort success-shaped null result.
    const denyish = /permission|grant|approve|confirm|consent/i.test(req.method);
    let reply;
    if (denyish) {
      reply = {
        jsonrpc: '2.0',
        id: req.id,
        // ACP convention seems to be `{ outcome: "cancelled" | "selected" }` —
        // but we don't actually know yet. Provide both shapes safely:
        result: { outcome: { type: 'cancelled' }, allowed: false, granted: false },
      };
    } else {
      reply = {
        jsonrpc: '2.0',
        id: req.id,
        // generic "not implemented by client" as a structured error so opencode
        // can surface it instead of hanging.
        error: {
          code: -32601,
          message: `client probe does not implement ${req.method}`,
        },
      };
    }
    this._writeRaw(reply);
  }

  _writeRaw(obj) {
    if (this.closed) {
      dbg('skip write — client closed', obj.method ?? `(response ${obj.id})`);
      return;
    }
    const line = `${JSON.stringify(obj)}\n`;
    try {
      this.child.stdin.write(line);
      dbg('outbound', truncateField(JSON.stringify(obj), 240));
    } catch (err) {
      dbg('write failed', err.message);
    }
  }

  request(method, params, timeoutMs = 15_000) {
    if (this.closed) return Promise.reject(new Error(`cannot request ${method} — client closed`));
    const id = this.nextId++;
    const sentAt = Date.now();
    const msg = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rejectP(new Error(`request timeout for ${method} after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      const wrap = {
        method,
        sentAt,
        resolve: (v) => { clearTimeout(timer); resolveP(v); },
        reject: (e) => { clearTimeout(timer); rejectP(e); },
      };
      this.pending.set(id, wrap);
      this._writeRaw(msg);
    });
  }

  notify(method, params) {
    this._writeRaw({ jsonrpc: '2.0', method, params });
  }
}

// --------------------------------------------------------------------------
// version capture (separate spawn, short-lived)
// --------------------------------------------------------------------------
function captureVersion(resolvedBin) {
  return new Promise((resolveP) => {
    const child = spawn(resolvedBin.path, ['--version'], {
      shell: resolvedBin.useShell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolveP('(version probe timeout)'); }, 5_000);
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    child.on('close', () => {
      clearTimeout(timer);
      const v = (out || err).trim().split(/\r?\n/)[0]?.slice(0, 80) || '(unknown)';
      resolveP(v);
    });
    child.on('error', () => { clearTimeout(timer); resolveP('(version probe error)'); });
  });
}

// --------------------------------------------------------------------------
// ACP method-name candidates
// The spec at agentclientprotocol.com indicates camelCase conventions like:
//   initialize / session/new / session/prompt / session/update / session/cancel
// (some implementations may use the dotted form e.g. session.new). We send
// the spec form first; if the server ERRORs with method-not-found (-32601)
// we will record that and not retry — the goal is to capture EXACT shapes.
// --------------------------------------------------------------------------
const SPEC_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
};

// --------------------------------------------------------------------------
// main probe sequence
// --------------------------------------------------------------------------
async function runProbe() {
  const startedAt = Date.now();
  const tmpDir = mkdtempSync(join(tmpdir(), 'opencode-acp-probe-'));
  dbg('temp cwd', tmpDir);

  const resolvedBin = resolveOpencodeBinary(OPENCODE_BIN);
  dbg('resolved binary', resolvedBin.path, 'useShell=', resolvedBin.useShell);

  const opencodeVersion = await captureVersion(resolvedBin);
  dbg('opencode version', opencodeVersion);

  // Spawn opencode acp. We do NOT pass --print-logs so stderr stays quiet
  // (or only emits whatever opencode writes by default). Stdout must be the
  // pristine JSON-RPC channel.
  const child = spawn(resolvedBin.path, ['acp', '--cwd', tmpDir], {
    shell: resolvedBin.useShell,
    cwd: tmpDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1' },
  });

  // Hard upper bound on the entire probe.
  const overallKill = setTimeout(() => {
    dbg('overall probe timeout reached, sending SIGKILL');
    try { child.kill('SIGKILL'); } catch {}
  }, PROBE_TIMEOUT_MS);

  const client = new AcpStdioClient(child);

  // metrics
  const metrics = {
    spawnedAt: startedAt,
    initializeStart: null,
    initializeEnd: null,
    sessionNewStart: null,
    sessionNewEnd: null,
    promptSentAt: null,
    firstUpdateAt: null,
    cancelSentAt: null,
    streamStoppedAt: null,
    completionAt: null,
    exitAt: null,
  };

  const observations = {
    initializeResult: null,
    initializeError: null,
    sessionNewResult: null,
    sessionNewError: null,
    sessionId: null,
    promptResult: null,
    promptError: null,
    cancelResult: null,
    cancelError: null,
    methodErrors: [], // method-not-found etc
  };

  let probeError = null;

  // ---- STEP 1: initialize -----------------------------------------------
  try {
    metrics.initializeStart = Date.now();
    // Per ACP spec the client passes its protocolVersion + clientCapabilities.
    // We declare minimum-viable client capabilities: no fs read/write, no terminal.
    const initParams = {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: 'aurora-acp-probe',
        version: '0.1.0',
      },
    };
    const result = await client.request(SPEC_METHODS.initialize, initParams, INITIALIZE_TIMEOUT_MS);
    metrics.initializeEnd = Date.now();
    observations.initializeResult = result;
    dbg('initialize OK');
  } catch (err) {
    metrics.initializeEnd = Date.now();
    observations.initializeError = err.jsonRpcError ?? { message: err.message };
    probeError = `initialize failed: ${err.message}`;
    dbg('initialize failed', err.message);
  }

  // ---- STEP 2: session/new ----------------------------------------------
  // We try several variants in sequence to learn what opencode expects:
  //   variant A: { cwd, mcpServers: [] }  (per ACP spec)
  //   variant B: variant A + model        (opencode-specific extension we discovered)
  // Each attempt's response is captured in observations.sessionNewAttempts[].
  observations.sessionNewAttempts = [];
  const optionalModel = process.env.OMNIFORGE_OPENCODE_MODEL || null;
  const variants = [
    { label: 'spec-shape', params: { cwd: tmpDir, mcpServers: [] } },
  ];
  if (optionalModel) {
    variants.push({ label: 'with-model-env', params: { cwd: tmpDir, mcpServers: [], model: optionalModel } });
  }
  if (!probeError) {
    metrics.sessionNewStart = Date.now();
    for (const variant of variants) {
      try {
        const result = await client.request(SPEC_METHODS.sessionNew, variant.params, SESSION_NEW_TIMEOUT_MS);
        observations.sessionNewAttempts.push({ label: variant.label, ok: true, sample: shapeSample(result, 240) });
        observations.sessionNewResult = result;
        if (result && typeof result === 'object') {
          observations.sessionId = result.sessionId ?? result.session_id ?? result.id ?? null;
        }
        dbg('session/new OK via', variant.label, 'sessionId=', redactSessionId(observations.sessionId));
        break;
      } catch (err) {
        const e = err.jsonRpcError ?? { message: err.message };
        observations.sessionNewAttempts.push({ label: variant.label, ok: false, error: e });
        dbg('session/new', variant.label, 'failed:', truncateField(JSON.stringify(e), 200));
      }
    }
    metrics.sessionNewEnd = Date.now();
    if (!observations.sessionId) {
      observations.sessionNewError = observations.sessionNewAttempts[observations.sessionNewAttempts.length - 1]?.error ?? null;
      probeError = probeError ?? `session/new failed (last error: ${truncateField(JSON.stringify(observations.sessionNewError), 160)})`;
    }
  }

  // ---- STEP 3: session/prompt + collect updates -------------------------
  // Notification listener tracks first update for time-to-first-update metric.
  client.onNotification((notif) => {
    if (typeof notif.method === 'string' && notif.method.startsWith('session/')) {
      if (metrics.firstUpdateAt === null) {
        metrics.firstUpdateAt = Date.now();
        dbg('first session/* notification', notif.method);
      }
    }
  });

  if (!probeError && observations.sessionId) {
    try {
      metrics.promptSentAt = Date.now();
      const promptParams = {
        sessionId: observations.sessionId,
        // ACP prompt content shape: array of content blocks. Use a single text block.
        prompt: [{ type: 'text', text: TRIVIAL_PROMPT }],
      };
      // Schedule a cancel after we see >=1 update OR after 6s, whichever first.
      let cancelScheduled = false;
      const trySchedule = () => {
        if (cancelScheduled || SKIP_CANCEL) return;
        cancelScheduled = true;
        setTimeout(async () => {
          if (probeError || !observations.sessionId) return;
          metrics.cancelSentAt = Date.now();
          dbg('sending session/cancel');
          try {
            // ACP spec lists cancel as a NOTIFICATION (no id); but some servers
            // accept it as a request. We send as notification, which is the
            // documented form.
            client.notify(SPEC_METHODS.sessionCancel, { sessionId: observations.sessionId });
            observations.cancelResult = '(notification — no response expected)';
          } catch (err) {
            observations.cancelError = { message: err.message };
            dbg('cancel send failed', err.message);
          }
        }, 200); // tiny grace so we observe cancel propagation cleanly
      };

      // arm a timer that fires regardless to prevent us hanging on a quiet stream
      const armTimer = setTimeout(trySchedule, 6_000);
      // arm a notification-driven trigger
      const earlyTrigger = (notif) => {
        if (typeof notif.method === 'string' && notif.method.startsWith('session/')) {
          trySchedule();
          client.handlers.delete(earlyTrigger);
        }
      };
      client.onNotification(earlyTrigger);

      const promptPromise = client.request(SPEC_METHODS.sessionPrompt, promptParams, PROMPT_TIMEOUT_MS);
      // We don't strictly need the prompt result — cancel may abort it. Race so we exit quickly.
      const result = await Promise.race([
        promptPromise.then((r) => ({ kind: 'completed', r })).catch((e) => ({ kind: 'errored', e })),
        new Promise((res) => setTimeout(() => res({ kind: 'graced' }), PROMPT_TIMEOUT_MS + POST_CANCEL_GRACE_MS)),
      ]);
      clearTimeout(armTimer);

      if (result.kind === 'completed') {
        metrics.completionAt = Date.now();
        observations.promptResult = result.r;
        dbg('session/prompt completed');
      } else if (result.kind === 'errored') {
        metrics.completionAt = Date.now();
        observations.promptError = result.e?.jsonRpcError ?? { message: result.e?.message ?? 'unknown' };
        dbg('session/prompt errored', result.e?.message);
      } else {
        dbg('session/prompt did not resolve within grace window');
      }

      // Determine when stream actually stopped: latest notification timestamp
      const lastNotif = client.notifications[client.notifications.length - 1];
      if (lastNotif) metrics.streamStoppedAt = lastNotif.receivedAt;

      // Give a short tail to flush any post-cancel updates
      await new Promise((res) => setTimeout(res, POST_CANCEL_GRACE_MS));
    } catch (err) {
      probeError = probeError ?? `session/prompt failed: ${err.message}`;
      observations.promptError = { message: err.message };
      dbg('session/prompt threw', err.message);
    }
  } else if (!observations.sessionId) {
    dbg('skipping prompt — no sessionId from session/new');
  }

  // ---- STEP 4: shutdown -------------------------------------------------
  // Try a graceful "session/end" notification then close stdin then SIGTERM then SIGKILL.
  try {
    if (observations.sessionId) {
      // Try a few graceful shutdown method names — at most one will be valid.
      // We send as notifications so we don't block on a response that may not come.
      client.notify('session/end', { sessionId: observations.sessionId });
    }
  } catch { /* best effort */ }

  try { child.stdin.end(); } catch { /* best effort */ }

  // SIGTERM grace
  await Promise.race([
    new Promise((res) => child.once('close', res)),
    new Promise((res) => setTimeout(res, 2_000)),
  ]);
  if (!client.closed) {
    dbg('SIGTERM');
    try { child.kill('SIGTERM'); } catch {}
    await Promise.race([
      new Promise((res) => child.once('close', res)),
      new Promise((res) => setTimeout(res, 2_000)),
    ]);
  }
  if (!client.closed) {
    dbg('SIGKILL');
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([
      new Promise((res) => child.once('close', res)),
      new Promise((res) => setTimeout(res, 2_000)),
    ]);
  }
  metrics.exitAt = Date.now();
  clearTimeout(overallKill);

  return { tmpDir, opencodeVersion, client, metrics, observations, probeError, startedAt };
}

// --------------------------------------------------------------------------
// artifact builder
// --------------------------------------------------------------------------
function buildArtifact(probe) {
  const { tmpDir, opencodeVersion, client, metrics, observations, probeError, startedAt } = probe;

  // Discovered method registry: every distinct method name we saw across
  // notifications + responses + server-to-client requests + errored outbound.
  const methodCounts = new Map();
  const recordMethod = (m, role) => {
    if (!m) return;
    const key = `${m} (${role})`;
    methodCounts.set(key, (methodCounts.get(key) ?? 0) + 1);
  };
  for (const n of client.notifications) recordMethod(n.method, 'inbound notification');
  for (const r of client.requestsToServer) recordMethod(r.method, 'server->client request');
  for (const r of client.responses) recordMethod(r.method, 'client->server response');
  // outbound notifications/requests we sent (only ones we know about)
  if (observations.initializeResult || observations.initializeError) recordMethod('initialize', 'outbound request');
  if (observations.sessionNewResult || observations.sessionNewError) recordMethod('session/new', 'outbound request');
  if (observations.promptResult || observations.promptError) recordMethod('session/prompt', 'outbound request');
  if (metrics.cancelSentAt) recordMethod('session/cancel', 'outbound notification');
  if (observations.sessionId) recordMethod('session/end', 'outbound notification (best-effort shutdown)');

  // Notification-method type registry: count + sample params keys
  const notifTypes = new Map();
  for (const n of client.notifications) {
    if (!notifTypes.has(n.method)) {
      notifTypes.set(n.method, { count: 0, sampleKeys: topLevelKeys(n.params), sample: shapeSample(n.params, 160) });
    }
    notifTypes.get(n.method).count += 1;
  }

  // latency derivations
  const initLatency = metrics.initializeEnd && metrics.initializeStart ? (metrics.initializeEnd - metrics.initializeStart) : null;
  const newLatency = metrics.sessionNewEnd && metrics.sessionNewStart ? (metrics.sessionNewEnd - metrics.sessionNewStart) : null;
  const ttfu = metrics.firstUpdateAt && metrics.promptSentAt ? (metrics.firstUpdateAt - metrics.promptSentAt) : null;
  const cancelToStop = metrics.streamStoppedAt && metrics.cancelSentAt ? (metrics.streamStoppedAt - metrics.cancelSentAt) : null;
  const totalDuration = metrics.exitAt - startedAt;

  // verdict tiers:
  //   PASS    — initialize OK + session/new OK + at least one notification
  //   PARTIAL — initialize OK + protocol roundtrip observed (responses or
  //             structured errors) but full session lifecycle blocked by
  //             environment (e.g. "No models available")
  //   FAIL    — initialize never returned a response
  const initOK = !!observations.initializeResult && !observations.initializeError;
  const newOK = !!observations.sessionId;
  const sawInbound = client.notifications.length > 0 || client.responses.length > 0;
  const verdict = (initOK && newOK && sawInbound) ? 'PASS' : (initOK && sawInbound ? 'PARTIAL' : 'FAIL');

  // Sample-redacted summaries
  const initSummary = observations.initializeResult ? {
    topLevelKeys: topLevelKeys(observations.initializeResult),
    sample: shapeSample(observations.initializeResult, 240),
  } : null;
  const newSummary = observations.sessionNewResult ? {
    topLevelKeys: topLevelKeys(observations.sessionNewResult),
    sample: shapeSample(observations.sessionNewResult, 240),
  } : null;
  const promptSummary = observations.promptResult ? {
    topLevelKeys: topLevelKeys(observations.promptResult),
    sample: shapeSample(observations.promptResult, 240),
  } : null;

  const lines = [];
  lines.push('# opencode ACP stdio probe — artifact');
  lines.push('');
  lines.push(`- timestamp (UTC): ${new Date(startedAt).toISOString()}`);
  lines.push(`- opencode version: ${opencodeVersion}`);
  lines.push(`- working directory (ephemeral, redacted): ${tmpDir.replace(/^.*[\\/]/, '<tmp>/')}`);
  lines.push(`- verdict: **${verdict}**`);
  lines.push(`- total wall-time: ${totalDuration} ms`);
  if (probeError) lines.push(`- probe error: ${truncateField(probeError, 200)}`);
  lines.push('');
  lines.push('## Lifecycle metrics');
  lines.push('');
  lines.push(`- initialize latency: ${initLatency ?? '(n/a)'} ms`);
  lines.push(`- session/new latency: ${newLatency ?? '(n/a)'} ms`);
  lines.push(`- time-to-first-update (after prompt): ${ttfu ?? '(no update observed)'} ms`);
  lines.push(`- cancel sent at offset: ${metrics.cancelSentAt ? `${metrics.cancelSentAt - startedAt} ms` : '(not sent — --no-cancel or no sessionId)'}`);
  lines.push(`- cancel-to-last-update gap: ${cancelToStop ?? '(n/a)'} ms`);
  lines.push(`- exit code: ${client.exitCode ?? '(unknown)'}`);
  lines.push(`- exit signal: ${client.exitSignal ?? '(none)'}`);
  lines.push('');
  lines.push('## Discovered method registry');
  lines.push('');
  lines.push('| method | role | occurrences |');
  lines.push('|---|---|---|');
  if (methodCounts.size === 0) {
    lines.push('| (none) | — | 0 |');
  } else {
    for (const [key, count] of [...methodCounts.entries()].sort()) {
      const [name, role] = key.split(' (');
      lines.push(`| \`${name}\` | ${(role ?? '').replace(/\)$/, '')} | ${count} |`);
    }
  }
  lines.push('');
  lines.push('## Inbound notification types (`session/update.*` and friends)');
  lines.push('');
  if (notifTypes.size === 0) {
    lines.push('(no inbound notifications observed)');
  } else {
    lines.push('| method | count | sample top-level keys | sample (redacted, capped) |');
    lines.push('|---|---|---|---|');
    for (const [name, info] of [...notifTypes.entries()].sort()) {
      lines.push(`| \`${name}\` | ${info.count} | ${info.sampleKeys.join(', ') || '(none)'} | \`${(info.sample || '').replace(/\|/g, '\\|')}\` |`);
    }
  }
  lines.push('');
  lines.push('## Per-method protocol log');
  lines.push('');
  lines.push('### initialize (outbound request)');
  lines.push(`- result captured: ${initOK ? 'yes' : 'no'}`);
  if (initSummary) {
    lines.push(`- top-level result keys: ${initSummary.topLevelKeys.join(', ')}`);
    lines.push(`- sample: \`${initSummary.sample}\``);
  }
  if (observations.initializeError) {
    lines.push(`- error: \`${truncateField(JSON.stringify(observations.initializeError), 200)}\``);
  }
  lines.push('');
  lines.push('### session/new (outbound request)');
  lines.push(`- sessionId captured: ${observations.sessionId ? 'yes' : 'no'}`);
  lines.push(`- sessionId (redacted): ${redactSessionId(observations.sessionId)}`);
  if (newSummary) {
    lines.push(`- top-level result keys: ${newSummary.topLevelKeys.join(', ')}`);
    lines.push(`- sample: \`${newSummary.sample}\``);
  }
  if (observations.sessionNewError) {
    lines.push(`- error: \`${truncateField(JSON.stringify(observations.sessionNewError), 200)}\``);
  }
  if (Array.isArray(observations.sessionNewAttempts) && observations.sessionNewAttempts.length > 0) {
    lines.push('- attempts:');
    for (const att of observations.sessionNewAttempts) {
      const status = att.ok ? 'OK' : `FAIL: ${truncateField(JSON.stringify(att.error), 140)}`;
      lines.push(`  - \`${att.label}\` -> ${status}`);
    }
  }
  lines.push('');
  lines.push('### session/prompt (outbound request)');
  if (promptSummary) {
    lines.push(`- top-level result keys: ${promptSummary.topLevelKeys.join(', ')}`);
    lines.push(`- sample: \`${promptSummary.sample}\``);
  } else if (observations.promptError) {
    lines.push(`- error: \`${truncateField(JSON.stringify(observations.promptError), 200)}\``);
  } else {
    lines.push('- no result captured (likely cancelled)');
  }
  lines.push('');
  lines.push('### session/cancel (outbound notification)');
  lines.push(`- sent: ${metrics.cancelSentAt ? 'yes' : 'no'}`);
  if (observations.cancelResult) lines.push(`- post-send observation: ${observations.cancelResult}`);
  if (observations.cancelError) lines.push(`- error: \`${truncateField(JSON.stringify(observations.cancelError), 200)}\``);
  lines.push('');
  lines.push('## Server-to-client requests');
  lines.push('');
  if (client.requestsToServer.length === 0) {
    lines.push('(none — opencode did not request anything from the client during this probe)');
  } else {
    lines.push('| method | params keys | sample | auto-reply |');
    lines.push('|---|---|---|---|');
    for (const r of client.requestsToServer.slice(0, 10)) {
      const denyish = /permission|grant|approve|confirm|consent/i.test(r.method);
      lines.push(`| \`${r.method}\` | ${topLevelKeys(r.params).join(', ') || '(none)'} | \`${shapeSample(r.params, 160).replace(/\|/g, '\\|')}\` | ${denyish ? 'denied (cancelled outcome)' : 'method-not-found stub'} |`);
    }
    if (client.requestsToServer.length > 10) {
      lines.push(`| ... | ... | ... | (${client.requestsToServer.length - 10} more truncated) |`);
    }
  }
  lines.push('');
  lines.push('## Stderr (scrubbed, capped 600 chars)');
  lines.push('');
  lines.push('```');
  lines.push(truncateField(client.stderrBuffer.trim() || '(empty)', 600));
  lines.push('```');
  lines.push('');
  lines.push('## Recommendations for Wave 3 ACP adapter');
  lines.push('');
  if (verdict === 'PASS') {
    lines.push('- ACP roundtrip confirmed: initialize + session/new + at least one inbound notification observed.');
    lines.push('- Recommend implementing the runtime adapter against the method names listed in the registry above; do NOT trust spec-only assumptions.');
    lines.push('- Treat session/cancel as a fire-and-forget notification; observe stream tail via `session/update.*` to detect stop.');
    lines.push('- Persist sessionId opaquely (treat as black-box string) — do not parse for structure.');
    lines.push('- For server-to-client requests (especially `session/request_permission`-shaped methods), the adapter MUST implement a real handler — auto-deny is only safe for probes.');
  } else if (verdict === 'PARTIAL') {
    lines.push('- initialize and JSON-RPC transport both work cleanly — adapter foundation is viable.');
    lines.push('- session/new returned a STRUCTURED ERROR (visible in the per-method log above), which is the GOOD KIND of failure: the protocol is responsive, an environmental requirement is missing.');
    lines.push('- Most common cause observed: opencode has no default model resolved in its merged config (`No models available` in `error.data.details`). Wave 3 should:');
    lines.push('  - require the adapter caller to supply a model in `session/new` params (extension over spec), OR');
    lines.push('  - ensure opencode\'s active config (`~/.config/opencode/opencode.json` or `~/.opencode/config.json`) declares a default `model` before spawn.');
    lines.push('- Re-run with `OMNIFORGE_OPENCODE_MODEL=<provider/id>` to see whether passing `model` in params unblocks `session/new`.');
    lines.push('- For the streaming/cancel half of the protocol, plan a follow-up live probe once a working model is in place (Wave 3 task).');
  } else {
    lines.push('- ACP probe FAILED before initialize completed. Treat ACP as **not viable** as a primary adapter for this opencode version until the failure mode is understood.');
    lines.push('- Either the ACP server is not registering on stdout, the spec method names diverge from what opencode exposes, or the version on this machine has a regression.');
    lines.push('- Recommend keeping `cli_spawn` text-pty as the primary path for opencode and gating ACP behind a feature flag.');
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push(`- inbound message count: ${client.allInbound.length}`);
  lines.push(`- inbound notifications: ${client.notifications.length}`);
  lines.push(`- inbound responses: ${client.responses.length}`);
  lines.push(`- server->client requests: ${client.requestsToServer.length}`);
  lines.push(`- closed cleanly (exit code 0): ${client.exitCode === 0 ? 'yes' : 'no'}`);
  lines.push('');

  let body = lines.join('\n');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > ARTIFACT_MAX_BYTES) {
    const slice = Buffer.from(body, 'utf8').subarray(0, ARTIFACT_MAX_BYTES - 64).toString('utf8');
    body = `${slice}\n\n...(artifact truncated to 16 KB cap)\n`;
  }
  return body;
}

// --------------------------------------------------------------------------
// entrypoint
// --------------------------------------------------------------------------
async function main() {
  if (!existsSync(REPO_ROOT)) {
    process.stderr.write(`[acp-probe] repo root not found: ${REPO_ROOT}\n`);
    process.exit(1);
  }

  let probe;
  try {
    probe = await runProbe();
  } catch (err) {
    process.stderr.write(`[acp-probe] unhandled error: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
  }

  // Write artifact
  const timestamp = new Date(probe.startedAt).toISOString().replace(/[:.]/g, '-');
  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `opencode-acp-${timestamp}.md`);
  writeFileSync(artifactPath, buildArtifact(probe), 'utf8');

  // Cleanup tmp
  try {
    rmSync(probe.tmpDir, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[acp-probe] tmp cleanup failed: ${err && err.message ? err.message : String(err)}\n`);
  }

  // Exit 0 = JSON-RPC protocol roundtrip observed (initialize + at least one
  // inbound message). Exit 1 = transport never came up. session/new failing
  // for environmental reasons (e.g. "No models available") is NOT a probe
  // failure — it is documented evidence captured into the artifact.
  const initOK = !!probe.observations.initializeResult && !probe.observations.initializeError;
  const sawInbound = probe.client.notifications.length > 0 || probe.client.responses.length > 0;
  const exitCode = (initOK && sawInbound) ? 0 : 1;
  const verdictLabel = exitCode === 0
    ? (probe.observations.sessionId ? 'PASS' : 'PARTIAL')
    : 'FAIL';

  process.stdout.write(
    `[acp-probe] verdict=${verdictLabel} ` +
    `methods=${probe.client.notifications.length}n+${probe.client.responses.length}r ` +
    `sessionId=${redactSessionId(probe.observations.sessionId)} ` +
    `artifact=${artifactPath}\n`
  );
  process.exit(exitCode);
}

await main();
