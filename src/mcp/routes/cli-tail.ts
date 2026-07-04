// F8.6-3: SSE streaming route for CLI tail output.
// GET /api/dashboard/cli-tail/:workflowId/:taskId/stream
// Bearer-authenticated. Uses fs.watch to detect file changes and pushes
// new TailEvents to the client.

import * as fs from 'node:fs';
import type { Router } from './types.js';
import {
  unauthorized,
  setSseHeaders,
  sendSseEvent,
  sendSseHeartbeat,
  safeEndSse,
  SSE_HEARTBEAT_MS,
} from './_shared.js';
import { tailCliTool } from '../tools/tail_cli.js';

// Matches: /api/dashboard/cli-tail/<workflowId>/<taskId>/stream
const CLI_TAIL_RE = /^\/api\/dashboard\/cli-tail\/([^/]+)\/([^/]+)\/stream$/;

export const cliTailRouter: Router = async (req, url, res, ctx) => {
  const m = CLI_TAIL_RE.exec(url.pathname);
  if (!m || req.method !== 'GET') return false;

  const [, workflowId, taskId] = m;

  // Auth — M1 / Wave 1-E (A9): try credentials in this order:
  //   1. `Authorization: Bearer <token>` header — preferred for API clients
  //      that can set headers (fetch / curl / SDK code). Header avoids putting
  //      the token in URLs (no Referer leaks, no server-access-log leaks).
  //   2. `?token=` query param — fallback for EventSource (cannot set custom
  //      headers) and ad-hoc browser testing.
  //   3. `omniforge_daemon_token` cookie — for browser dashboard sessions
  //      that already round-tripped through dashboard-static cookie-redirect.
  // All three use timingSafeEqual under the hood (tokenOk).
  const auth = (req.headers['authorization'] as string | undefined) ?? '';
  const bearerToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const queryToken = url.searchParams.get('token') ?? '';
  const cookie = (req.headers['cookie'] as string | undefined) ?? '';
  const cookieToken = cookie
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('omniforge_daemon_token='))
    ?.slice('omniforge_daemon_token='.length) ?? '';

  function tokenOk(raw: string): boolean {
    if (!raw || raw.length === 0) return false;
    const exp = Buffer.from(ctx.token);
    const inc = Buffer.from(raw);
    if (inc.length !== exp.length) return false;
    let diff = 0;
    for (let i = 0; i < inc.length; i++) diff |= inc[i] ^ exp[i];
    return diff === 0;
  }

  const authorized =
    tokenOk(bearerToken) ||
    tokenOk(queryToken) ||
    tokenOk(cookieToken);

  if (!authorized) { unauthorized(res); return true; }

  setSseHeaders(res);

  // Send initial snapshot
  let lastSentIndex = 0;
  try {
    const result = await tailCliTool({ workflow_id: workflowId, task_id: taskId, since_event_id: 0, limit: 200 });
    if (result.events.length > 0) {
      for (let i = 0; i < result.events.length; i++) {
        sendSseEvent(res, 'tail_event', result.events[i], i);
      }
      lastSentIndex = result.events.length;
    }
    sendSseEvent(res, 'meta', { session_path: result.session_path, cli_id: result.cli_id, total_events: result.total_events });

    // If no session file found, end gracefully
    if (!result.session_path) {
      sendSseEvent(res, 'done', { reason: 'no_session' });
      safeEndSse(res);
      return true;
    }

    // Watch for changes
    const sessionPath = result.session_path;
    let watcher: fs.FSWatcher | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    function cleanup(): void {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (watcher) { try { watcher.close(); } catch { /* ignore */ } watcher = null; }
    }

    async function pushNew(): Promise<void> {
      if (res.writableEnded) { cleanup(); return; }
      try {
        const r = await tailCliTool({
          workflow_id: workflowId,
          task_id: taskId,
          since_event_id: lastSentIndex,
          limit: 100,
        });
        for (let i = 0; i < r.events.length; i++) {
          sendSseEvent(res, 'tail_event', r.events[i], lastSentIndex + i);
        }
        lastSentIndex += r.events.length;
      } catch {
        // Non-fatal: file may be temporarily unavailable
      }
    }

    try {
      watcher = fs.watch(sessionPath, () => { void pushNew(); });
    } catch {
      // fs.watch not available for this path — fall through to heartbeat only
    }

    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) { cleanup(); return; }
      sendSseHeartbeat(res);
      void pushNew();
    }, SSE_HEARTBEAT_MS);

    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('finish', cleanup);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.writableEnded) {
      sendSseEvent(res, 'error', { error: msg });
      safeEndSse(res);
    }
  }

  return true;
};
