#!/usr/bin/env node
/**
 * opencode serve HTTP API probe (Wave 1 / Task 8B.1.HTTP — standalone proof script).
 *
 * Spawns `opencode serve --port <free> --hostname 127.0.0.1` in an isolated
 * tmpdir, waits for the listener to come up, then probes the HTTP API:
 *   - discovery: /, /openapi.json, /docs
 *   - session lifecycle: GET /session, POST /session, POST /session/:id/message,
 *     POST /session/:id/cancel, DELETE /session/:id
 *
 * The point of this script is *protocol verification*, not real LLM execution.
 * If the message endpoint returns a 401/4xx because no provider auth is
 * configured in the ephemeral cwd, that still counts as a successful probe:
 * we observed the request shape, the response shape, and the auth contract.
 *
 * Writes a redacted markdown artifact to:
 *   _artifacts/runtime-resume-harness/opencode-serve-<timestamp>.md
 *
 * IMPORTANT: this script does NOT touch any production runtime code. It is a
 * standalone proof harness used by Wave 1 of the calm-torvalds plan.
 *
 * Verified opencode CLI version when authored: 1.14.46.
 *
 * Usage:
 *   node scripts/runtime-resume-harness/opencode-serve-probe.mjs
 *   node scripts/runtime-resume-harness/opencode-serve-probe.mjs --dry-run
 *
 * Exit codes:
 *   0  protocol probe succeeded (server came up, at least the discovery
 *      endpoints + session list responded; message/cancel/delete are best
 *      effort because they may need auth)
 *   1  protocol probe failed (server never came up, or the readiness signal
 *      timed out, or the very first HTTP call failed)
 *
 * The script ALWAYS attempts to SIGTERM/SIGKILL the spawned opencode process
 * and rm the tmpdir, even on error paths.
 */

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, platform as osPlatform } from 'node:os';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { delimiter as PATH_DELIM } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has('--dry-run');

const READY_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 8_000;
const SIGTERM_GRACE_MS = 10_000;
const ARTIFACT_MAX_BYTES = 12 * 1024;
const OPENCODE_BIN = process.env.OMNIFORGE_OPENCODE_BIN || 'opencode';

/**
 * Resolve the actual command + args we should hand to spawn() so that we can
 * keep `shell: false` (defense in depth — no shell metacharacter expansion).
 *
 * On Windows, npm installs CLIs as a `.cmd` shim that internally re-invokes
 * node against a JS entry. As of Node 22 we can't spawn `.cmd` directly with
 * `shell: false` (CVE-2024-27980 mitigation). So:
 *   1) Try the user-provided binary on PATH.
 *   2) If it's a `.cmd`/`.bat`, parse the shim to find the underlying
 *      `node_modules/.../bin/<name>` JS path and invoke `node` against it.
 *   3) If we can't find a JS entry, fall back to `cmd.exe /c <bin>` which
 *      is still safe because we never interpolate user input into the args.
 *
 * Returns { command, prefixArgs } that should be combined with the caller's
 * args list, e.g. spawn(command, [...prefixArgs, ...userArgs]).
 */
function resolveSpawnTarget(binaryName) {
  // Allow absolute path override (OMNIFORGE_OPENCODE_BIN=/full/path).
  if (isAbsolute(binaryName) && existsSync(binaryName)) {
    return resolveShimToNode(binaryName);
  }

  const isWin = osPlatform() === 'win32';
  const candidates = [];
  const pathDirs = (process.env.PATH || process.env.Path || '').split(PATH_DELIM).filter(Boolean);

  if (isWin) {
    // Windows: only PATHEXT-listed extensions are executable. Skip the bare
    // (extension-less) name — npm ships a POSIX shim there which Node
    // cannot spawn natively. Prefer .CMD / .BAT (the actual shims).
    const pathExt = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter(Boolean);
    for (const dir of pathDirs) {
      for (const ext of pathExt) {
        const candidate = join(dir, binaryName + ext);
        try {
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            candidates.push(candidate);
          }
        } catch { /* ignore */ }
      }
    }
  } else {
    for (const dir of pathDirs) {
      const candidate = join(dir, binaryName);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          candidates.push(candidate);
        }
      } catch { /* ignore */ }
    }
  }

  if (candidates.length === 0) {
    // Let spawn fail naturally with ENOENT — the error handler captures it.
    return { command: binaryName, prefixArgs: [] };
  }

  return resolveShimToNode(candidates[0]);
}

/**
 * If the resolved binary is a Windows .cmd/.bat shim that re-invokes node
 * against a JS file, return a (node, [jsPath]) pair instead. Otherwise
 * return the binary as-is (for .exe or POSIX shells).
 */
function resolveShimToNode(binaryPath) {
  const lower = binaryPath.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) {
    return { command: binaryPath, prefixArgs: [] };
  }
  let shimText = '';
  try {
    shimText = readFileSync(binaryPath, 'utf8');
  } catch {
    return { command: binaryPath, prefixArgs: [] };
  }
  // Look for the JS path the shim invokes. Common npm shim line:
  //   "%_prog%"  "%dp0%\node_modules\opencode-ai\bin\opencode" %*
  const jsMatch = shimText.match(/"%dp0%\\?([^"]+\/bin\/[^"]+|[^"]+\\bin\\[^"]+)"/i)
                || shimText.match(/"%~dp0([^"]+)"\s+%\*/i);
  if (!jsMatch) {
    return { command: binaryPath, prefixArgs: [] };
  }
  const relRaw = jsMatch[1].replace(/\//g, '\\');
  const jsAbs = join(dirname(binaryPath), relRaw);
  if (!existsSync(jsAbs)) {
    return { command: binaryPath, prefixArgs: [] };
  }
  return { command: process.execPath, prefixArgs: [jsAbs] };
}

const SPAWN_TARGET = resolveSpawnTarget(OPENCODE_BIN);

/**
 * Find a free TCP port by binding to port 0, reading the chosen port,
 * then closing the listener. There is a small TOCTOU window between the
 * close and the opencode bind, but it's acceptable for a probe.
 */
function pickFreePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', (err) => rej(err));
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((closeErr) => {
        if (closeErr) rej(closeErr);
        else res(port);
      });
    });
  });
}

/**
 * Best-effort scrub of secrets in any string we might write to the artifact.
 * Replaces long alphanumeric runs that look like keys/tokens with placeholders.
 */
function scrubSecrets(input) {
  if (!input || typeof input !== 'string') return '';
  let out = input;
  // 1. Common secret prefixes followed by an opaque token.
  out = out.replace(/\b(sk|pk|anthropic|bearer|opencode|oc)[-_a-z]*[-_=:]?[A-Za-z0-9_-]{16,}\b/gi, '(value redacted)');
  // 2. Opencode session/message ids: ses_xxx / msg_xxx / part_xxx — mask all but first 8 chars.
  out = out.replace(/\b((?:ses|msg|prt|part|run|tsk|task)_[A-Za-z0-9]{4,})\b/g, (_m, id) => `${id.slice(0, 8)}...`);
  // 3. Long hex runs.
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, '(value redacted)');
  // 4. Long base64-ish runs.
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, (m) => (m.length >= 40 ? '(value redacted)' : m));
  return out;
}

/**
 * Heuristic: many web frameworks return a SPA index.html for unknown routes.
 * If multiple discovery probes share the same body length AND content-type
 * is text/html, label them as "SPA fallback" instead of pretending the
 * endpoint exists.
 */
function annotateSpaFallback(probes) {
  const htmlBodies = probes.filter((p) =>
    typeof p.status === 'number'
    && p.status === 200
    && (p.headers['content-type'] || '').toLowerCase().includes('text/html')
    && p.bodyShape && p.bodyShape.kind === 'text'
  );
  const lenCount = new Map();
  for (const p of htmlBodies) {
    const len = p.bodyShape.length;
    lenCount.set(len, (lenCount.get(len) || 0) + 1);
  }
  for (const p of htmlBodies) {
    const len = p.bodyShape.length;
    if ((lenCount.get(len) || 0) >= 2) {
      p.spaFallback = true;
    }
  }
}

/**
 * Truncate a long string for safe artifact embedding, stripping control chars.
 */
function trunc(str, max = 200) {
  if (str === null || str === undefined) return '(none)';
  let s = typeof str === 'string' ? str : JSON.stringify(str);
  s = s.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  s = scrubSecrets(s);
  if (s.length > max) s = `${s.slice(0, max)}...`;
  return s;
}

/**
 * Truncate a sessionId or any opaque id to the first 8 chars.
 */
function redactId(id) {
  if (!id || typeof id !== 'string') return '(none)';
  if (id.length <= 8) return `${id}...`;
  return `${id.slice(0, 8)}...`;
}

/**
 * Walk a JSON-ish value and return a shallow shape report:
 *   - object → { keys: [...], sample: '<first key value redacted/truncated>' }
 *   - array  → { length, itemKeys: [...] }   (peek at first item)
 *   - scalar → typeof
 * Never recurses past depth 2 to keep the artifact tiny.
 */
function shapeOf(value, depth = 0) {
  if (value === null) return { kind: 'null' };
  if (value === undefined) return { kind: 'undefined' };
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      kind: 'array',
      length: value.length,
      itemShape: depth >= 2 ? '(depth-cap)' : (first === undefined ? '(empty)' : shapeOf(first, depth + 1)),
    };
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).slice(0, 12);
    return {
      kind: 'object',
      keys,
      keyCount: Object.keys(value).length,
    };
  }
  return { kind: typeof value, sample: trunc(String(value), 60) };
}

/**
 * Issue an HTTP request with a manual timeout, returning a normalized record.
 * Uses native fetch (Node 22). The response body is parsed as JSON when the
 * content-type signals JSON, otherwise read as text and truncated.
 */
async function httpProbe({ method, url, body, label }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
  const start = Date.now();
  let status = 0;
  let headers = {};
  let bodyOut = null;
  let bodyShape = null;
  let parseError = null;
  let networkError = null;
  try {
    const init = {
      method,
      signal: ac.signal,
      headers: { Accept: 'application/json, text/html;q=0.9, */*;q=0.5' },
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(url, init);
    status = res.status;
    headers = Object.fromEntries(res.headers.entries());
    const ct = (headers['content-type'] || '').toLowerCase();
    const text = await res.text();
    if (ct.includes('application/json') && text.length > 0) {
      try {
        bodyOut = JSON.parse(text);
        bodyShape = shapeOf(bodyOut);
      } catch (err) {
        parseError = err && err.message ? err.message : String(err);
        bodyOut = text;
      }
    } else {
      bodyOut = text;
      bodyShape = { kind: 'text', length: text.length };
    }
  } catch (err) {
    networkError = err && err.message ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - start;
  return {
    label,
    method,
    url,
    status,
    latencyMs,
    headers,
    bodyShape,
    bodyOut,
    parseError,
    networkError,
  };
}

/**
 * Spawn opencode serve and wait for the readiness signal in stdout/stderr.
 * Returns { child, readyMs } when the listener is up, or rejects on timeout.
 *
 * Readiness regex tolerates several known wordings observed across versions:
 *   - "listening on http://..."
 *   - "opencode running on ..."
 *   - bare "http://127.0.0.1:<port>"
 */
function startOpencodeServe({ port, cwd, log }) {
  return new Promise((resolveReady, rejectReady) => {
    const userArgs = ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--print-logs'];
    const args = [...SPAWN_TARGET.prefixArgs, ...userArgs];
    const child = spawn(SPAWN_TARGET.command, args, {
      shell: false,
      cwd,
      env: { ...process.env, OPENCODE_NO_TELEMETRY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows, detached:false is the default — we want to keep it so that
      // SIGTERM via .kill() targets just the opencode process.
    });

    const start = Date.now();
    let stdoutBuf = '';
    let stderrBuf = '';
    let resolved = false;

    const readyRe = new RegExp(
      String.raw`(listening on|server (?:started|listening|ready)|opencode running|http://127\.0\.0\.1:` + port + `)`,
      'i'
    );

    const maybeResolve = (origin, chunk) => {
      if (resolved) return;
      if (readyRe.test(chunk) || readyRe.test(stdoutBuf) || readyRe.test(stderrBuf)) {
        resolved = true;
        clearTimeout(timer);
        resolveReady({ child, readyMs: Date.now() - start, readyOrigin: origin });
      }
    };

    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      rejectReady(Object.assign(new Error('opencode serve readiness timeout'), {
        stdout: trunc(stdoutBuf, 400),
        stderr: trunc(stderrBuf, 400),
      }));
    }, READY_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stdoutBuf += s;
      log.push(`[stdout] ${trunc(s, 160)}`);
      maybeResolve('stdout', s);
    });
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrBuf += s;
      log.push(`[stderr] ${trunc(s, 160)}`);
      maybeResolve('stderr', s);
    });
    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      rejectReady(Object.assign(new Error(`spawn error: ${err.message}`), {
        stdout: trunc(stdoutBuf, 400),
        stderr: trunc(stderrBuf, 400),
      }));
    });
    child.on('exit', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      rejectReady(Object.assign(new Error(`opencode serve exited before ready (code=${code} signal=${signal})`), {
        stdout: trunc(stdoutBuf, 400),
        stderr: trunc(stderrBuf, 400),
      }));
    });
  });
}

/**
 * Cleanly shut down the opencode child: SIGTERM, wait up to grace ms, then
 * SIGKILL. On Windows, .kill() with no signal sends a hard terminate.
 */
async function shutdownChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  const isWin = osPlatform() === 'win32';
  try {
    if (isWin) {
      // taskkill is safer for child of cmd shim, but spawn(opencode, ...,
      // shell:false) gives us a direct PID. SIGTERM gets translated to a
      // hard kill by Node on Windows anyway, but try graceful first.
      child.kill('SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* already gone */ }

  const exited = await new Promise((res) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res(false); } }, SIGTERM_GRACE_MS);
    child.once('exit', () => { if (!done) { done = true; clearTimeout(t); res(true); } });
  });
  if (!exited) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Capture opencode --version into the artifact for traceability.
 * Best-effort; never throws.
 */
function captureVersion() {
  return new Promise((res) => {
    const args = [...SPAWN_TARGET.prefixArgs, '--version'];
    const child = spawn(SPAWN_TARGET.command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const settle = (v) => { if (settled) return; settled = true; res(v); };
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { out += c.toString('utf8'); });
    child.on('error', (err) => settle(`(spawn error: ${trunc(err && err.message ? err.message : String(err), 60)})`));
    child.on('exit', () => settle(trunc(out.trim(), 80) || '(unknown)'));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } settle('(timed out)'); }, 5_000);
  });
}

/**
 * Build the redacted markdown artifact body, capping its size.
 */
function buildArtifact(report) {
  const lines = [];
  lines.push('# opencode serve HTTP API probe — artifact');
  lines.push('');
  lines.push(`- timestamp (UTC): ${report.timestamp}`);
  lines.push(`- opencode binary: ${OPENCODE_BIN}`);
  lines.push(`- detected version: ${report.version}`);
  lines.push(`- ephemeral cwd: ${report.cwd}`);
  lines.push(`- chosen port: ${report.port}`);
  lines.push(`- ready origin: ${report.readyOrigin}`);
  lines.push(`- ready time (ms): ${report.readyMs}`);
  lines.push(`- dry run: ${report.dryRun ? 'yes' : 'no'}`);
  lines.push(`- verdict: **${report.verdict}**`);
  lines.push('');
  lines.push('## Discovered endpoints');
  lines.push('');
  if (report.probes.length === 0) {
    lines.push('(none — server failed to come up)');
  } else {
    lines.push('| label | method | status | latency (ms) | body shape | note |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of report.probes) {
      const shape = p.bodyShape ? p.bodyShape.kind + (p.bodyShape.keys ? ` keys=[${p.bodyShape.keys.slice(0,6).join(', ')}]` : (p.bodyShape.length !== undefined ? ` len=${p.bodyShape.length}` : '')) : '(none)';
      const note = p.spaFallback ? 'SPA fallback (no real route)' : '';
      lines.push(`| ${p.label} | ${p.method} | ${p.status || (p.networkError ? 'NET-ERR' : '?')} | ${p.latencyMs} | ${trunc(shape, 80)} | ${note} |`);
    }
  }
  lines.push('');
  lines.push('## Per-endpoint detail (redacted)');
  lines.push('');
  for (const p of report.probes) {
    lines.push(`### ${p.label} — \`${p.method} ${redactUrl(p.url)}\``);
    lines.push('');
    lines.push(`- status: ${p.status}`);
    lines.push(`- latency: ${p.latencyMs} ms`);
    if (p.networkError) lines.push(`- network error: ${trunc(p.networkError, 160)}`);
    if (p.parseError) lines.push(`- parse error: ${trunc(p.parseError, 160)}`);
    const ct = p.headers['content-type'] || '(unknown)';
    lines.push(`- content-type: ${trunc(ct, 80)}`);
    const auth = p.headers['www-authenticate'];
    if (auth) lines.push(`- www-authenticate: ${trunc(auth, 80)}`);
    if (p.bodyShape) {
      lines.push(`- body shape: \`${JSON.stringify(p.bodyShape)}\``);
    }
    lines.push('');
  }
  lines.push('## Auth observations');
  lines.push('');
  lines.push(report.authNote || '(no auth-related response observed)');
  lines.push('');
  lines.push('## Event / streaming observations');
  lines.push('');
  lines.push(report.eventNote || '(no streaming endpoint exercised in this probe)');
  lines.push('');
  lines.push('## Cancellation observations');
  lines.push('');
  lines.push(report.cancelNote || '(cancel endpoint not reached or returned no body)');
  lines.push('');
  lines.push('## Comparison-ready summary');
  lines.push('');
  if (report.latencies.length > 0) {
    const sorted = [...report.latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
    lines.push(`- HTTP samples: ${sorted.length}`);
    lines.push(`- latency P50 (ms): ${p50}`);
    lines.push(`- latency P95 (ms): ${p95}`);
    lines.push(`- latency min/max (ms): ${sorted[0]} / ${sorted[sorted.length - 1]}`);
  } else {
    lines.push('- (no successful HTTP samples to summarize)');
  }
  lines.push(`- cancel-to-effect classification: ${report.cancelClassification}`);
  lines.push(`- event richness: ${report.eventRichness}`);
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  if (report.notes.length === 0) lines.push('(none)');
  else for (const n of report.notes) lines.push(`- ${trunc(n, 200)}`);
  lines.push('');
  lines.push('## Spawn log tail (scrubbed, last 16 lines)');
  lines.push('');
  lines.push('```');
  const tail = report.log.slice(-16);
  for (const ln of tail) lines.push(scrubSecrets(ln));
  lines.push('```');
  lines.push('');

  let body = lines.join('\n');
  if (Buffer.byteLength(body, 'utf8') > ARTIFACT_MAX_BYTES) {
    const slice = Buffer.from(body, 'utf8').subarray(0, ARTIFACT_MAX_BYTES - 32).toString('utf8');
    body = `${slice}\n\n...(artifact truncated to 12 KB)\n`;
  }
  return body;
}

/**
 * Redact session-like ids appearing in URL paths (e.g. /session/abc1234567890 → /session/abc12345...).
 */
function redactUrl(url) {
  return url.replace(/\/(session|message|run|task)\/([A-Za-z0-9_-]{8,})/g, (_m, kind, id) => `/${kind}/${id.slice(0, 8)}...`);
}

/**
 * Dry run: don't spawn anything, but produce a representative artifact so
 * we can verify the redaction + path layout end-to-end.
 */
async function runDry() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `opencode-serve-${timestamp}-dryrun.md`);
  const fakePort = 49999;
  const fakeSession = 'sess_abc12345xyz67890PRETEND';
  const probes = [
    { label: 'discover-root', method: 'GET', url: `http://127.0.0.1:${fakePort}/`, status: 0, latencyMs: 0, headers: {}, bodyShape: { kind: 'text', length: 0 }, bodyOut: null, parseError: null, networkError: '(dry-run)' },
    { label: 'discover-openapi', method: 'GET', url: `http://127.0.0.1:${fakePort}/openapi.json`, status: 0, latencyMs: 0, headers: {}, bodyShape: null, bodyOut: null, parseError: null, networkError: '(dry-run)' },
    { label: 'session-list', method: 'GET', url: `http://127.0.0.1:${fakePort}/session`, status: 0, latencyMs: 0, headers: {}, bodyShape: null, bodyOut: null, parseError: null, networkError: '(dry-run)' },
    { label: 'session-create', method: 'POST', url: `http://127.0.0.1:${fakePort}/session`, status: 0, latencyMs: 0, headers: {}, bodyShape: null, bodyOut: null, parseError: null, networkError: '(dry-run)' },
    { label: 'session-message', method: 'POST', url: `http://127.0.0.1:${fakePort}/session/${fakeSession}/message`, status: 0, latencyMs: 0, headers: {}, bodyShape: null, bodyOut: null, parseError: null, networkError: '(dry-run)' },
    { label: 'session-cancel', method: 'POST', url: `http://127.0.0.1:${fakePort}/session/${fakeSession}/cancel`, status: 0, latencyMs: 0, headers: {}, bodyShape: null, bodyOut: null, parseError: null, networkError: '(dry-run)' },
    { label: 'session-delete', method: 'DELETE', url: `http://127.0.0.1:${fakePort}/session/${fakeSession}`, status: 0, latencyMs: 0, headers: {}, bodyShape: null, bodyOut: null, parseError: null, networkError: '(dry-run)' },
  ];
  const report = {
    timestamp,
    version: '1.14.46 (dry run — not spawned)',
    cwd: '(dry run)',
    port: fakePort,
    readyOrigin: '(dry run)',
    readyMs: 0,
    dryRun: true,
    verdict: 'DRY-RUN (no spawn)',
    probes,
    latencies: [],
    authNote: 'Dry run produced no real responses.',
    eventNote: 'Dry run produced no real responses.',
    cancelNote: 'Dry run produced no real responses.',
    cancelClassification: 'unknown (dry-run)',
    eventRichness: 'unknown (dry-run)',
    notes: [
      'No opencode process was spawned.',
      'No --dangerously-skip-permissions or other bypass flags are used by this script.',
    ],
    log: ['(dry-run, no spawn output)'],
  };
  writeFileSync(artifactPath, buildArtifact(report), 'utf8');
  process.stdout.write(`[dry-run] artifact written: ${artifactPath}\n`);
  return 0;
}

/**
 * Live run: pick port, mkdtemp, spawn, wait ready, probe, cleanup.
 */
async function runLive() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cwd = mkdtempSync(join(tmpdir(), 'opencode-serve-probe-'));
  const log = [];
  const notes = [];
  let child = null;
  let port = 0;
  let readyMs = -1;
  let readyOrigin = '(unknown)';
  const probes = [];
  const latencies = [];
  let authNote = '';
  let eventNote = '';
  let cancelNote = '';
  let cancelClassification = 'untested';
  let eventRichness = 'untested';
  let verdict = 'FAIL';

  const version = await captureVersion();

  try {
    port = await pickFreePort();
    notes.push(`Picked free port ${port} via net.createServer().listen(0).`);

    const ready = await startOpencodeServe({ port, cwd, log });
    child = ready.child;
    readyMs = ready.readyMs;
    readyOrigin = ready.readyOrigin;
    notes.push(`opencode serve became ready in ${readyMs} ms (signal source: ${readyOrigin}).`);

    // Tiny grace period: some servers print "listening" before fully wiring routes.
    await sleep(150);

    const base = `http://127.0.0.1:${port}`;

    // --- Discovery ----------------------------------------------------
    const root = await httpProbe({ method: 'GET', url: `${base}/`, label: 'discover-root' });
    probes.push(root);
    if (typeof root.status === 'number' && root.status > 0) latencies.push(root.latencyMs);

    const openapi = await httpProbe({ method: 'GET', url: `${base}/openapi.json`, label: 'discover-openapi' });
    probes.push(openapi);
    if (typeof openapi.status === 'number' && openapi.status > 0) latencies.push(openapi.latencyMs);

    // Try alternate openapi paths if the first 404'd.
    if (openapi.status === 404 || openapi.networkError) {
      const alt = await httpProbe({ method: 'GET', url: `${base}/api/openapi.json`, label: 'discover-openapi-alt' });
      probes.push(alt);
      if (typeof alt.status === 'number' && alt.status > 0) latencies.push(alt.latencyMs);
    }

    const docs = await httpProbe({ method: 'GET', url: `${base}/docs`, label: 'discover-docs' });
    probes.push(docs);
    if (typeof docs.status === 'number' && docs.status > 0) latencies.push(docs.latencyMs);

    // Note any auth signal observed on discovery.
    for (const p of [root, openapi, docs]) {
      if (p.status === 401 || p.status === 403) {
        const wa = p.headers['www-authenticate'] || '(no www-authenticate header)';
        authNote = `Discovery returned ${p.status} on ${redactUrl(p.url)} — www-authenticate: ${trunc(wa, 80)}.`;
        break;
      }
    }
    if (!authNote) authNote = 'Discovery endpoints returned without 401/403 — server appears to allow anonymous discovery on 127.0.0.1.';

    // --- Session lifecycle -------------------------------------------
    const sessionList = await httpProbe({ method: 'GET', url: `${base}/session`, label: 'session-list' });
    probes.push(sessionList);
    if (typeof sessionList.status === 'number' && sessionList.status > 0) latencies.push(sessionList.latencyMs);

    const sessionCreate = await httpProbe({
      method: 'POST',
      url: `${base}/session`,
      body: { title: 'opencode-serve-probe', /* probe payload, no secrets */ },
      label: 'session-create',
    });
    probes.push(sessionCreate);
    if (typeof sessionCreate.status === 'number' && sessionCreate.status > 0) latencies.push(sessionCreate.latencyMs);

    // Extract a session id from the create response if shape allows.
    let sessionId = null;
    if (sessionCreate.bodyOut && typeof sessionCreate.bodyOut === 'object') {
      sessionId = sessionCreate.bodyOut.id || sessionCreate.bodyOut.sessionId || sessionCreate.bodyOut.session_id || null;
      if (sessionCreate.bodyOut.session && typeof sessionCreate.bodyOut.session === 'object') {
        sessionId = sessionId || sessionCreate.bodyOut.session.id;
      }
    }

    if (!sessionId) {
      // Try to fetch /session and read first item.
      const list = sessionList.bodyOut;
      if (Array.isArray(list) && list.length > 0 && list[0] && typeof list[0] === 'object') {
        sessionId = list[0].id || list[0].sessionId || null;
      } else if (list && typeof list === 'object' && Array.isArray(list.sessions) && list.sessions[0]) {
        sessionId = list.sessions[0].id || null;
      }
    }

    if (sessionId) {
      notes.push(`Session id captured (redacted): ${redactId(sessionId)}.`);
    } else {
      notes.push('Could not determine a session id from create/list responses; using placeholder for downstream probes.');
      sessionId = 'probe-placeholder-id';
    }

    // Send a minimal message — we don't care if it 4xxs because of missing
    // provider auth; we want the request/response shape.
    const sessionMessage = await httpProbe({
      method: 'POST',
      url: `${base}/session/${encodeURIComponent(sessionId)}/message`,
      body: {
        parts: [{ type: 'text', text: 'protocol-probe-only — please ignore' }],
      },
      label: 'session-message',
    });
    probes.push(sessionMessage);
    if (typeof sessionMessage.status === 'number' && sessionMessage.status > 0) latencies.push(sessionMessage.latencyMs);

    // Heuristic event-shape observation based on response content-type.
    const msgCt = (sessionMessage.headers['content-type'] || '').toLowerCase();
    if (msgCt.includes('text/event-stream')) {
      eventNote = 'POST /session/:id/message returned text/event-stream — opencode serve uses SSE for message streaming.';
      eventRichness = 'sse';
    } else if (msgCt.includes('application/x-ndjson') || msgCt.includes('application/jsonl')) {
      eventNote = 'POST /session/:id/message returned NDJSON — line-delimited streaming events.';
      eventRichness = 'ndjson';
    } else if (msgCt.includes('application/json')) {
      eventNote = 'POST /session/:id/message returned application/json (single response, not a stream). Streaming may live on a separate endpoint.';
      eventRichness = 'json (poll-style)';
    } else {
      eventNote = `POST /session/:id/message returned content-type ${trunc(msgCt || '(none)', 60)} — streaming shape unclear.`;
      eventRichness = 'unknown';
    }

    // Probe a likely event endpoint as a secondary observation.
    const eventStream = await httpProbe({
      method: 'GET',
      url: `${base}/event`,
      label: 'discover-event',
    });
    probes.push(eventStream);
    if (typeof eventStream.status === 'number' && eventStream.status > 0) latencies.push(eventStream.latencyMs);
    const evCt = (eventStream.headers['content-type'] || '').toLowerCase();
    if (evCt.includes('text/event-stream')) {
      eventNote += ' GET /event also exposes a server-wide SSE channel.';
      if (eventRichness === 'unknown' || eventRichness.startsWith('json')) eventRichness = 'sse (server-wide /event)';
    }

    // Cancel + delete.
    const cancelStart = Date.now();
    const sessionCancel = await httpProbe({
      method: 'POST',
      url: `${base}/session/${encodeURIComponent(sessionId)}/cancel`,
      body: {},
      label: 'session-cancel',
    });
    probes.push(sessionCancel);
    const cancelLatency = Date.now() - cancelStart;
    if (typeof sessionCancel.status === 'number' && sessionCancel.status > 0) latencies.push(sessionCancel.latencyMs);

    // Classify the primary /cancel result first.
    const cancelCt = (sessionCancel.headers['content-type'] || '').toLowerCase();
    const cancelLooksLikeSpa = cancelCt.includes('text/html');
    let cancelClassified = false;
    if (sessionCancel.status >= 200 && sessionCancel.status < 300 && !cancelLooksLikeSpa) {
      cancelNote = `POST /session/:id/cancel returned ${sessionCancel.status} in ${sessionCancel.latencyMs} ms (round-trip ${cancelLatency} ms).`;
      cancelClassification = sessionCancel.latencyMs < 250 ? 'immediate (<250ms ack)' : 'eventual (>=250ms ack)';
      cancelClassified = true;
    } else if (sessionCancel.status >= 200 && sessionCancel.status < 300 && cancelLooksLikeSpa) {
      cancelNote = 'POST /session/:id/cancel returned 200 with text/html — likely SPA fallback. Trying /abort next.';
      cancelClassification = 'spa-fallback (route likely missing under this name)';
    } else if (sessionCancel.status === 404) {
      cancelNote = 'POST /session/:id/cancel returned 404 — endpoint may not exist on this opencode build.';
      cancelClassification = 'endpoint-missing';
    } else {
      cancelNote = `POST /session/:id/cancel returned ${sessionCancel.status} — see per-endpoint detail.`;
      cancelClassification = `non-2xx-${sessionCancel.status}`;
    }

    // If the primary cancel didn't return a real success, probe the
    // alternate /abort verb. This is best-effort and never overrides a
    // confirmed real success on /cancel.
    if (!cancelClassified) {
      const sessionAbort = await httpProbe({
        method: 'POST',
        url: `${base}/session/${encodeURIComponent(sessionId)}/abort`,
        body: {},
        label: 'session-abort-alt',
      });
      probes.push(sessionAbort);
      if (typeof sessionAbort.status === 'number' && sessionAbort.status > 0) latencies.push(sessionAbort.latencyMs);
      const altCt = (sessionAbort.headers['content-type'] || '').toLowerCase();
      if (sessionAbort.status >= 200 && sessionAbort.status < 300 && !altCt.includes('text/html')) {
        cancelNote = `POST /session/:id/abort returned ${sessionAbort.status} in ${sessionAbort.latencyMs} ms — opencode appears to use /abort, not /cancel.`;
        cancelClassification = sessionAbort.latencyMs < 250 ? 'immediate (<250ms ack via /abort)' : 'eventual (>=250ms ack via /abort)';
      } else {
        cancelNote += ` Alternate POST /abort returned ${sessionAbort.status || 'NET-ERR'} (content-type: ${trunc(altCt || '(none)', 40)}).`;
      }
    }

    const sessionDelete = await httpProbe({
      method: 'DELETE',
      url: `${base}/session/${encodeURIComponent(sessionId)}`,
      label: 'session-delete',
    });
    probes.push(sessionDelete);
    if (typeof sessionDelete.status === 'number' && sessionDelete.status > 0) latencies.push(sessionDelete.latencyMs);

    // Annotate which probes are likely SPA fallback (HTML 200 with the same
    // body length across multiple routes — opencode's React SPA shell).
    annotateSpaFallback(probes);

    // Verdict: protocol probe is "PASS" if the server came up AND at least
    // one discovery or session-list call returned a real HTTP status.
    const anyRealResponse = probes.some((p) => typeof p.status === 'number' && p.status > 0);
    verdict = anyRealResponse ? 'PASS (protocol probe)' : 'FAIL (no HTTP response observed)';
  } catch (err) {
    notes.push(`Live run aborted: ${trunc(err && err.message ? err.message : String(err), 200)}`);
    if (err && err.stdout) notes.push(`Spawn stdout (capped 200): ${trunc(err.stdout, 200)}`);
    if (err && err.stderr) notes.push(`Spawn stderr (capped 200): ${trunc(err.stderr, 200)}`);
    verdict = 'FAIL (server did not come up)';
  } finally {
    // ALWAYS shutdown + rm tmpdir, no matter what.
    if (child) {
      try { await shutdownChild(child); }
      catch (e) { notes.push(`shutdown error: ${trunc(String(e), 120)}`); }
    }
    try {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (e) {
      notes.push(`tmpdir cleanup error: ${trunc(String(e), 120)}`);
    }
  }

  const timestampOut = timestamp;
  const report = {
    timestamp: timestampOut,
    version,
    cwd,
    port,
    readyOrigin,
    readyMs,
    dryRun: false,
    verdict,
    probes,
    latencies,
    authNote,
    eventNote,
    cancelNote,
    cancelClassification,
    eventRichness,
    notes,
    log,
  };

  const artifactDir = join(REPO_ROOT, '_artifacts', 'runtime-resume-harness');
  mkdirSync(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `opencode-serve-${timestampOut}.md`);
  writeFileSync(artifactPath, buildArtifact(report), 'utf8');

  process.stdout.write(
    `[opencode-serve-probe] verdict=${verdict} port=${port} samples=${latencies.length} artifact=${artifactPath}\n`
  );

  return verdict.startsWith('PASS') ? 0 : 1;
}

async function main() {
  if (!existsSync(REPO_ROOT)) {
    process.stderr.write(`[opencode-serve-probe] repo root not found: ${REPO_ROOT}\n`);
    process.exit(1);
  }
  try {
    const code = DRY_RUN ? await runDry() : await runLive();
    process.exit(code);
  } catch (err) {
    process.stderr.write(
      `[opencode-serve-probe] unhandled error: ${err && err.message ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

await main();
