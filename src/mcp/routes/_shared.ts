// Sprint 4 (D-H2.066): shared helpers for routers extracted from http-server.ts.
//
// All response helpers, body parsers and SSE primitives live here so each
// router file can be self-contained (no cross-router imports).
//
// Kept isomorphic with the originals from http-server.ts to make the split
// purely mechanical (no behavior change).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';

export const API_VERSION = 1;

// ── Security Headers (Sprint 9 Security Hardening) ───────────────────────
//
// Standard security headers to protect against common web vulnerabilities.
// Applied to all HTTP responses for defense-in-depth.

export const SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
} as const;

// ── Constant-time token compare ───────────────────────────────────────────
//
// Shared with http-server.ts (originally defined there). Exported so router
// modules can avoid the O(1)-hash short-circuit in Map.get(token) and
// instead iterate with a constant-time compare per candidate. This is
// material when the attacker can submit many tokens (e.g. SSE actor auth
// surface from http://127.0.0.1) — Map.get leaks tiny timing signals via
// V8 hash bucket distribution, while timingSafeEqual takes a fixed amount
// of time relative to byte length.
//
// O(n) iteration is acceptable for single-operator workloads (<10 actors).
export function constantTimeTokenCompare(incoming: string, expected: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const incomingBuf = Buffer.from(incoming);
  const padded = Buffer.alloc(expectedBuf.length);
  incomingBuf.copy(padded, 0, 0, expectedBuf.length);
  const contentEq = timingSafeEqual(padded, expectedBuf);
  const lengthEq = incomingBuf.length === expectedBuf.length;
  return contentEq && lengthEq;
}

// ── Response helpers ──────────────────────────────────────────────────────

export function unauthorized(res: ServerResponse): void {
  if (!res.headersSent) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      ...SECURITY_HEADERS,
    });
  }
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

export function notFound(res: ServerResponse, msg = 'Not found'): void {
  if (!res.headersSent) {
    res.writeHead(404, {
      'Content-Type': 'application/json',
      ...SECURITY_HEADERS,
    });
  }
  res.end(JSON.stringify({ error: msg }));
}

export function badRequest(res: ServerResponse, msg: string, extra?: Record<string, unknown>): void {
  res.writeHead(400, {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify({ error: msg, ...(extra ?? {}) }));
}

export function jsonOk(res: ServerResponse, body: object, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(body));
}

export function textOk(
  res: ServerResponse,
  body: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Omniforge-Api-Version': String(API_VERSION),
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'",
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

export const DASHBOARD_REACT_CSP =
  "default-src 'self'; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'";

export function binaryOk(
  res: ServerResponse,
  body: Buffer,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Omniforge-Api-Version': String(API_VERSION),
    'Content-Security-Policy': DASHBOARD_REACT_CSP,
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

// ── Body parsers (256 KB cap defends against buffer-bomb DoS) ─────────────

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.length > 256 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (buf.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Sprint F4 (file upload): plan + single-task endpoints accept up to 5 MB
// of attachments (base64-inflated to ~7 MB). The default 256 KB cap would
// reject every request that includes more than a single tiny text file,
// so these endpoints opt into a higher 8 MB cap here. The cap STAYS in
// the same per-request body parser — we don't widen the global default
// because every other endpoint should keep the tight cap.
//
// Defense-in-depth: even at 8 MB this is still a buffer-bomb upper bound.
// The Zod schema (DashboardAttachmentsListSchema) re-validates the
// per-attachment caps after parse, so a single 8 MB request body that
// declares a 50 KB file gets rejected fast.
export const LARGE_BODY_CAP_BYTES = 8 * 1024 * 1024;

export async function readLargeJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.length > LARGE_BODY_CAP_BYTES) {
        reject(new Error('payload too large (max 8 MB for attachment-bearing endpoints)'));
      }
    });
    req.on('end', () => {
      if (buf.length === 0) { resolve({}); return; }
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * Reads the JSON body and answers 400 (badRequest) when it is invalid or too
 * large. Returns `undefined` once the 400 response has been written — the
 * sentinel is unambiguous because readJsonBody can never resolve `undefined`
 * (JSON.parse cannot produce it; an empty body resolves to `{}`).
 */
export async function readBodyOr400(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

export async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.length > 256 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

// ── SSE helpers ───────────────────────────────────────────────────────────

export const SSE_HEARTBEAT_MS = 15_000;

export function setSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Omniforge-Api-Version': String(API_VERSION),
    ...SECURITY_HEADERS,
  });
  if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as unknown as { flushHeaders: () => void }).flushHeaders();
  }
}

export function sendSseEvent(
  res: ServerResponse,
  eventType: string,
  data: unknown,
  id?: number | string,
): void {
  if (res.writableEnded) return;
  let payload = '';
  if (id !== undefined) payload += `id: ${id}\n`;
  payload += `event: ${eventType}\n`;
  payload += `data: ${JSON.stringify(data)}\n\n`;
  res.write(payload);
}

export function sendSseHeartbeat(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.write(`: ping ${Date.now()}\n\n`);
}

/**
 * Wires the SSE lifecycle boilerplate shared by every SSE endpoint: the
 * heartbeat interval (unref'd so it never keeps the process alive), plus the
 * `close`/`error` listeners on both req and res. `onCleanup` runs exactly
 * once — the returned cleanup is idempotent so callers can also invoke it
 * from their own finally blocks.
 */
export function wireSseLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  onCleanup?: () => void,
): () => void {
  const heartbeat = setInterval(() => sendSseHeartbeat(res), SSE_HEARTBEAT_MS);
  if (typeof (heartbeat as unknown as { unref?: () => void }).unref === 'function') {
    (heartbeat as unknown as { unref: () => void }).unref();
  }
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    if (onCleanup) onCleanup();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  return cleanup;
}

// Sprint 3.7 (D-H2.066, F-REL-6): log SSE cleanup errors instead of silencing.
export function safeEndSse(res: ServerResponse): void {
  if (!res.writableEnded) {
    try { res.end(); } catch (endErr) {
      process.stderr.write(`[daemon] SSE res.end failed: ${endErr instanceof Error ? endErr.message : String(endErr)}\n`);
      try { res.destroy(); } catch { /* destroy on already-destroyed is fine */ }
    }
  }
}

// ── DB lifecycle helper ───────────────────────────────────────────────────
//
// The 'const db = initDb(getDbPath()); try { ... } catch (err) {
// badRequest(...) } finally { db.close() }' shape is repeated throughout the
// router package. withDb / withDbAsync centralize it: open the db, run `fn`,
// report any thrown error via badRequest (same
// `err instanceof Error ? err.message : String(err)` idiom every call site
// already used), and always close the db in a finally. Behavior-preserving —
// callers just move their try-body into the callback.

export function withDb(res: ServerResponse, fn: (db: ReturnType<typeof initDb>) => void): void {
  const db = initDb(getDbPath());
  try {
    fn(db);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

export async function withDbAsync(
  res: ServerResponse,
  fn: (db: ReturnType<typeof initDb>) => Promise<void>,
): Promise<void> {
  const db = initDb(getDbPath());
  try {
    await fn(db);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// ── JSON parse helper ─────────────────────────────────────────────────────

export function safeJsonParse(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return {}; }
}
