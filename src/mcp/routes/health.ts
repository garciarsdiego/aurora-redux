// Sprint 4.2 (D-H2.066): /health and /favicon.ico routes.
//
// Both are PUBLIC (no auth required). /health is used by daemon polling
// (status indicators, omniforge doctor) and exposes uptime + version +
// last_schedule_tick (Sprint 2.6 observability).
//
// /favicon.ico returns 204 to silence the browser default request.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDaemonState } from '../../db/persist.js';
import { readDaemonHeartbeat } from '../../db/daemon-heartbeat.js';
import { getDbPath } from '../../utils/config.js';
import type { RouteContext, Router } from './types.js';
import { API_VERSION } from './_shared.js';

function handleHealth(res: ServerResponse, ctx: RouteContext): void {
  // Sprint 2.6 (D-H2.066, F-REL-2): expose schedule_tick observability so the
  // operator can see the daemon background loop is healthy without parsing
  // stderr. age_ms = how long since the last tick fired (NaN if never).
  //
  // F3-2 also exposes alive_at_age_ms (heartbeat age) so the operator can
  // distinguish a healthy daemon (age < ~10s) from a wedged or dead one
  // (age unbounded). Heartbeat ticks at 5s; schedule tick at 60s — they
  // serve different purposes and may diverge.
  let scheduleTick: Record<string, unknown> | null = null;
  let aliveAtAgeMs: number | null = null;
  try {
    const db = initDb(getDbPath());
    try {
      const entry = getDaemonState(db, 'schedule_tick');
      if (entry) {
        scheduleTick = {
          ...entry.value,
          updated_at: entry.updated_at,
          age_ms: entry.updated_at > 0 ? Date.now() - entry.updated_at : null,
        };
      }
      const heartbeat = readDaemonHeartbeat(db);
      aliveAtAgeMs = heartbeat ? heartbeat.age_ms : null;
    } finally {
      db.close();
    }
  } catch (err) {
    scheduleTick = {
      status: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
    aliveAtAgeMs = null;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'X-Omniforge-Api-Version': String(API_VERSION),
  });
  res.end(JSON.stringify({
    status: 'ok',
    version: ctx.version.version,
    commit: ctx.version.commit ?? null,
    uptime_ms: Date.now() - ctx.serverStartMs,
    port: ctx.port,
    api_version: API_VERSION,
    last_schedule_tick: scheduleTick,
    alive_at_age_ms: aliveAtAgeMs,
  }));
}

export const healthRouter: Router = async (req, url, res, ctx) => {
  if (req.method === 'GET' && url.pathname === '/health') {
    handleHealth(res, ctx);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/favicon.ico') {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }
  return false;
};
