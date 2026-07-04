// Sprint 4 (D-H2.066): split http-server.ts (was 2430 LOC) into focused
// routers under src/mcp/routes/. This file now only handles:
//   - bootstrap (port bind, version stamping, daemon token resolution)
//   - auth gate (timing-safe Bearer / cookie / query-token)
//   - router chain (in priority order)
//   - 60s background schedule tick timer
//   - graceful shutdown
//
// Routes — preserved from pre-split:
//   GET  /health                       (no auth)  status + version + uptime + last_schedule_tick
//   GET  /favicon.ico                  (no auth)  204
//   POST /webhooks/:slug               (no auth)  HMAC-signed receive (signature is the auth)
//   GET  /dashboard, /dashboard/styles.css, /dashboard/app.js, /dashboard/assets/*  (Bearer)
//   GET  /api/dashboard/{summary,dags,models,model-catalog,config,planner-sessions,triggers}  (Bearer)
//   POST /api/dashboard/{config,workspaces,planner-sessions,admin/clear,dags/*}  (Bearer)
//   PATCH workspaces/:name, planner-sessions/:id  (Bearer)
//   POST /api/dashboard/triggers/{schedules,schedules/tick,webhooks,webhooks/:id/rotate-secret}  (Bearer)
//   PATCH /api/dashboard/triggers/{schedules,webhooks}/:id  (Bearer)
//   GET/PATCH/POST /api/dashboard/workflows/:id/*, .../tasks/:tid/*  (Bearer)
//   POST /actor/{register,heartbeat,unregister}, /workflow/:id/cancel  (Bearer)
//   POST /gate/:id/resolve  (Bearer + actor_token)
//   GET  /events/workflow/:id, /events/gates  (Bearer)
//   POST /stream/llm  (Bearer + actor_token + per-actor rate limit)
//   GET  /mcp/sse, GET /mcp/tools/list, POST /mcp/messages  (Bearer)
//
// Bind: 127.0.0.1 only. Auth: timing-safe Bearer compare + cookie + query.
// Heartbeat: SSE comment frame every 15s. Cleanup: req.on('close') unsubscribes everywhere.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { healthRouter } from './routes/health.js';
import { dashboardStaticRouter } from './routes/dashboard-static.js';
import { dashboardDataRouter } from './routes/dashboard-data.js';
import { dashboardWorkflowOpsRouter } from './routes/dashboard-workflow-ops.js';
import { setupConfigRouter } from './routes/setup-config.js';
import {
  dashboardTriggersHttpRouter,
  publicWebhookRouter,
  scheduleTickHistory,
  SCHEDULE_TICK_MAX_PER_WINDOW,
  SCHEDULE_TICK_WINDOW_MS,
} from './routes/dashboard-triggers-http.js';
import { actorRouter } from './routes/actor.js';
import { sseRouter } from './routes/sse.js';
import { mcpTransportRouter } from './routes/mcp-transport.js';
import { cliTailRouter } from './routes/cli-tail.js';
import { createDecomposerMetricsRouter } from './routes/decomposer-metrics.js';
import { dashboardSecretsRouter } from './routes/dashboard-secrets.js';
import { dashboardVaultRouter } from './routes/dashboard-vault.js';
import { dashboardPatternsRouter } from './routes/dashboard-patterns.js';
import { dashboardCostPreviewRouter } from './routes/dashboard-cost-preview.js';
import { dashboardBuilderRouter } from './routes/dashboard-builder.js';
import { dashboardPersonaReplayRouter } from './routes/dashboard-persona-replay.js';
import { dashboardPersonaMetricsRouter } from './routes/dashboard-persona-metrics.js';
import { dashboardPermissionRouter } from './routes/dashboard-permission.js';
import { dashboardAuditRouter } from './routes/dashboard-audit.js';
import { dashboardAdvisorsRouter } from './routes/dashboard-advisors.js';
import { dashboardGatesRouter } from './routes/dashboard-gates.js';
import { dashboardRulesRouter } from './routes/dashboard-rules.js';
import { dashboardVersionedDefsRouter } from './routes/dashboard-versioned-defs.js';
import { dashboardNotificationsRouter } from './routes/dashboard-notifications.js';
import { dashboardExternalMcpRouter } from './routes/dashboard-external-mcp.js';
import { omnirouteHealthRouter } from './routes/dashboard-omniroute-health.js';
import { omnirouteCostRouter } from './routes/dashboard-omniroute-cost.js';
import { monitoringRouter } from './routes/dashboard-monitoring.js';
import { monitoringBasicRouter } from './routes/monitoring.js';
import { telegramWebhookRouter } from './routes/telegram-webhook.js';
import { dashboardMetaWorkflowsRouter } from './routes/dashboard-meta-workflows.js';
import { dashboardEvalsRouter } from './routes/dashboard-evals.js';
import { dashboardTracesRouter } from './routes/dashboard-traces.js';
import { hydrateAutoTagOverridesFromDb } from './routes/dashboard-data.js';
import { runDashboardScheduleTickOnce } from './routes/_schedule-tick.js';
import { emitTaskHungEvents, expireTimedOutRunningTasksFromDefaultDb } from '../scheduler/tick.js';
import {
  writeDaemonHeartbeat,
  DAEMON_HEARTBEAT_INTERVAL_MS,
} from '../db/daemon-heartbeat.js';
import {
  ACTOR_TOKEN_TTL_MS,
  actorRegistry,
  llmStreamsByActor,
  MAX_LLM_STREAMS_PER_ACTOR,
} from './routes/_actor-registry.js';
import { eventBroker } from './event-broker.js';
import type { RouteContext, Router } from './routes/types.js';
import { unauthorized } from './routes/_shared.js';
import { VALID_WORKSPACE_RE } from '../utils/workspace.js';
import { readSettings, writeSettings } from '../utils/settings-file.js';
import { refreshHealthStatus } from '../v2/omniroute-bridge/health-cache.js';

export function resolveHttpPort(): number {
  const raw = process.env.OMNIFORGE_DAEMON_PORT?.trim();
  if (!raw) return 20129;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return 20129;
  return parsed;
}

export const HTTP_PORT = resolveHttpPort();
export const API_VERSION = 1;

const SERVER_START_MS = Date.now();

// Router para servir o dashboard HTML de monitoramento básico
function createMonitoringDashboardRouter(): Router {
  return async (req: IncomingMessage, url: URL, res: ServerResponse, ctx: RouteContext) => {
    if (req.method !== 'GET' || url.pathname !== '/monitoring-dashboard') {
      return false;
    }

    try {
      const dashboardPath = path.join(__dirname, 'monitoring-dashboard.html');
      if (!existsSync(dashboardPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Monitoring dashboard not found');
        return true;
      }

      const content = readFileSync(dashboardPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
      return true;
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error loading monitoring dashboard');
      return true;
    }
  };
}

// ── Version stamping ──────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface VersionInfo { version: string; commit?: string; }

function readVersion(): VersionInfo {
  const candidates = [
    path.resolve(__dirname, 'version.json'),
    path.resolve(__dirname, '..', 'version.json'),
    path.resolve(process.cwd(), 'dist', 'version.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const c of candidates) {
    try {
      const raw = readFileSync(c, 'utf8');
      const parsed = JSON.parse(raw) as VersionInfo;
      if (parsed && typeof parsed.version === 'string') {
        return { version: parsed.version, commit: parsed.commit };
      }
    } catch { /* try next */ }
  }
  return { version: '0.0.0-unknown' };
}

// ── Daemon token resolution ───────────────────────────────────────────────

export function resolveToken(dataDir: string): string {
  // 1. Explicit environment override — highest priority.
  if (process.env.OMNIFORGE_DAEMON_TOKEN) return process.env.OMNIFORGE_DAEMON_TOKEN;

  // 2. Persisted user-level settings (~/.omniforge/settings.json).
  const settingsToken = readSettings().daemon_token;
  if (settingsToken) return settingsToken;

  // 3. Legacy per-project data file (data/daemon-token.txt).
  // This is the authoritative per-project store — written on first run and never
  // promoted to the global settings file to avoid cross-project token contamination
  // when multiple Omniforge instances share the same home directory.
  const tokenFile = path.join(dataDir, 'daemon-token.txt');
  if (!existsSync(tokenFile)) {
    // 4. Generate a new token and persist it to the per-project data file only.
    const token = randomBytes(32).toString('hex');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tokenFile, token, { mode: 0o600 });
    process.stderr.write(`[daemon] Token generated → ${tokenFile}\n`);
    process.stderr.write('[daemon] Token value withheld from logs. Copy it from the token file if needed.\n');
  }
  return readFileSync(tokenFile, 'utf8').trim();
}

// ── Auth gate (timing-safe Bearer + cookie + query-token) ──────────────────

// Constant-time compare regardless of input length. Earlier impl returned early
// on length mismatch, leaking token length via timing. Pattern: pad incoming to
// expected length, always run timingSafeEqual, AND a separate length check
// (length compare is fast and produces only the boolean — never the content).
function constantTimeTokenCompare(incoming: string, expected: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const incomingBuf = Buffer.from(incoming);
  const padded = Buffer.alloc(expectedBuf.length);
  incomingBuf.copy(padded, 0, 0, expectedBuf.length);
  const contentEq = timingSafeEqual(padded, expectedBuf);
  const lengthEq = incomingBuf.length === expectedBuf.length;
  return contentEq && lengthEq;
}

function tokenMatches(authHeader: string, expectedToken: string): boolean {
  return constantTimeTokenCompare(authHeader, `Bearer ${expectedToken}`);
}

function rawTokenMatches(rawToken: string, expectedToken: string): boolean {
  return constantTimeTokenCompare(rawToken, expectedToken);
}

function daemonAuthDisabledForLocalRequest(req: IncomingMessage): boolean {
  const mode = (process.env.OMNIFORGE_DAEMON_AUTH ?? '').trim().toLowerCase();
  if (!['off', 'false', 'disabled', 'none'].includes(mode)) return false;
  const remote = req.socket.remoteAddress ?? '';
  return remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1';
}

function requestAuthorized(req: IncomingMessage, url: URL, expectedToken: string): boolean {
  if (daemonAuthDisabledForLocalRequest(req)) return true;
  const auth = (req.headers['authorization'] as string | undefined) ?? '';
  if (tokenMatches(auth, expectedToken)) return true;
  const queryToken = url.searchParams.get('token') ?? '';
  if (queryToken.length > 0 && rawTokenMatches(queryToken, expectedToken)) return true;
  const cookie = (req.headers['cookie'] as string | undefined) ?? '';
  const cookieToken = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('omniforge_daemon_token='))
    ?.slice('omniforge_daemon_token='.length) ?? '';
  return cookieToken.length > 0 && rawTokenMatches(cookieToken, expectedToken);
}

// ── Server bootstrap ──────────────────────────────────────────────────────

export type ShutdownFn = () => Promise<void>;

export async function startHttpMcpServer(dataDir: string, port = resolveHttpPort()): Promise<ShutdownFn> {
  const token = resolveToken(dataDir);
  const version = readVersion();
  const transports = new Map<string, SSEServerTransport>();
  const dashboardRetryExecutions = new Map<string, Promise<void>>();

  // Wave 2.B: hydrate dashboard-managed auto-tag overrides from daemon_state
  // so resolveAutoTag (called inside Omniroute requests) sees the persisted
  // value before the first /api/dashboard/config GET. Best-effort — the
  // daemon must boot even if the table is empty or the DB lacks the
  // migration (older installs).
  try {
    const { initDb } = await import('../db/client.js');
    const { getDbPath } = await import('../utils/config.js');
    const db = initDb(getDbPath());
    try {
      hydrateAutoTagOverridesFromDb(db);
    } finally {
      db.close();
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] auto-tag overrides hydration skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // Camada C: ensure every workspace without an explicit `software_target`
  // has a usable default project_root. Provisions
  // `data/workspaces/<name>/project/` (mkdir + git init + initial commit) and
  // patches the workspace metadata so cli_spawn workers always land in a
  // git-able cwd. Runs once per daemon boot — idempotent + best-effort.
  try {
    const { initDb } = await import('../db/client.js');
    const { getDbPath } = await import('../utils/config.js');
    const { ensureGitInitialized } = await import('../utils/git-worktree.js');
    const db = initDb(getDbPath());
    try {
      const existingRows = db.prepare(
        `SELECT name, metadata_json FROM dashboard_workspaces`,
      ).all() as Array<{ name: string; metadata_json: string | null }>;
      const implicitRows = db.prepare(
        `SELECT DISTINCT workspace AS name
           FROM workflows
          WHERE workspace IS NOT NULL AND workspace != ''`,
      ).all() as Array<{ name: string }>;
      const workspaceNames = new Set<string>(['internal']);
      for (const row of existingRows) workspaceNames.add(row.name);
      for (const row of implicitRows) workspaceNames.add(row.name);
      const rowsByName = new Map(existingRows.map((row) => [row.name, row]));
      const rows = Array.from(workspaceNames)
        .filter((name) => VALID_WORKSPACE_RE.test(name))
        .map((name) => rowsByName.get(name) ?? { name, metadata_json: null });
      for (const row of rows) {
        let metadata: Record<string, unknown> = {};
        try {
          if (row.metadata_json) {
            const parsed = JSON.parse(row.metadata_json) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              metadata = parsed as Record<string, unknown>;
            }
          }
        } catch { /* malformed metadata — treat as empty */ }
        const existingTarget = metadata['software_target'];
        const hasProjectRoot =
          existingTarget &&
          typeof existingTarget === 'object' &&
          typeof (existingTarget as { project_root?: unknown }).project_root === 'string' &&
          ((existingTarget as { project_root?: string }).project_root ?? '').length > 0;
        if (hasProjectRoot) {
          // Workspace is already configured — make sure it is git-able.
          const root = (existingTarget as { project_root: string }).project_root;
          ensureGitInitialized(root);
          continue;
        }
        // Provision a default project_root inside the daemon data dir.
        const defaultRoot = path.resolve(dataDir, 'workspaces', row.name, 'project');
        if (ensureGitInitialized(defaultRoot) === null) continue;
        const nextTarget = {
          ...(typeof existingTarget === 'object' && existingTarget !== null
            ? (existingTarget as Record<string, unknown>)
            : {}),
          project_root: defaultRoot,
        };
        const nextMetadata = { ...metadata, software_target: nextTarget };
        db.prepare(
          `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET metadata_json = excluded.metadata_json`,
        ).run(row.name, Date.now(), 'daemon-bootstrap', JSON.stringify(nextMetadata));
      }
    } finally {
      db.close();
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] workspace project_root bootstrap skipped: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const ctx: RouteContext = {
    token,
    port,
    version,
    serverStartMs: SERVER_START_MS,
    mcpTransports: transports,
    dashboardRetryExecutions,
  };

  // Pre-auth routers (run before Bearer gate). Order matters: health first
  // so /health stays cheap; webhook second so external callers reach it
  // without auth (HMAC-signed body is the auth); telegram webhook third for
  // HITL gate button callbacks (authenticated via webhook secret in path).
  const preAuthRouters: Router[] = [
    healthRouter,
    publicWebhookRouter,
    telegramWebhookRouter,
  ];

  // Post-auth routers (Bearer/cookie/query token required). Order is by
  // expected hit frequency (dashboard data is hottest, MCP transport least).
  const postAuthRouters: Router[] = [
    dashboardStaticRouter,
    setupConfigRouter,
    dashboardDataRouter,
    dashboardWorkflowOpsRouter,
    dashboardSecretsRouter,
    dashboardVaultRouter,
    dashboardPatternsRouter,
    dashboardCostPreviewRouter,
    dashboardBuilderRouter,
    dashboardPersonaReplayRouter,
    dashboardPersonaMetricsRouter,
    dashboardPermissionRouter,
    dashboardAuditRouter,
    dashboardAdvisorsRouter,
    dashboardGatesRouter,
    dashboardRulesRouter,
    dashboardVersionedDefsRouter,
    dashboardNotificationsRouter,
    dashboardExternalMcpRouter,
    omnirouteHealthRouter,
omnirouteCostRouter,
    monitoringRouter,
    monitoringBasicRouter,
    createMonitoringDashboardRouter(),
    dashboardTriggersHttpRouter,
    dashboardMetaWorkflowsRouter,
    dashboardEvalsRouter,
    dashboardTracesRouter,
    actorRouter,
    sseRouter,
    cliTailRouter,
    createDecomposerMetricsRouter(),
    mcpTransportRouter,
  ];

  async function runRouterChain(
    routers: Router[],
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
  ): Promise<boolean> {
    for (const router of routers) {
      const handled = await router(req, url, res, ctx);
      if (handled) return true;
    }
    return false;
  }

  // Sprint 9: Security Hardening - Restrictive CORS configuration
  // Server binds to 127.0.0.1 only, so restrict CORS to localhost origins
  function getCorsHeaders(origin: string | undefined): Record<string, string> {
    // Allow localhost origins for development
    const allowedOrigins = [
      'http://localhost:20129',
      'http://127.0.0.1:20129',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ];

    const isAllowed = origin && allowedOrigins.includes(origin);

    return {
      'Access-Control-Allow-Origin': isAllowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    };
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    const corsHeaders = getCorsHeaders(origin);

    // CORS preflight — must be before any auth check
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Inject CORS headers into every response
    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);

    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, `http://127.0.0.1:${port}`);

    // Pre-auth chain (health, public webhook)
    if (await runRouterChain(preAuthRouters, req, url, res)) return;

    // Sprint 3.1 (D-H2.066, F-SEC-2): all subsequent routes require Bearer.
    // Includes dashboard static assets — was previously leaking UI version.
    if (!requestAuthorized(req, url, token)) { unauthorized(res); return; }

    // Post-auth chain
    if (await runRouterChain(postAuthRouters, req, url, res)) return;

    // 404 fallthrough
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', resolve);
  });

  // ── Background daemon heartbeat (F3-2, every 5s) ───────────────────────
  // Writes daemon_state['daemon_alive'] = {pid, alive_at}. Independent of the
  // 60s schedule tick so /health can surface daemon liveness even when
  // schedules are disabled or stalled. One write/5s on a single-row upsert
  // is negligible (≈0.05% of an i/o-bound daemon).
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const { initDb } = await import('../db/client.js');
        const { getDbPath } = await import('../utils/config.js');
        const db = initDb(getDbPath());
        try {
          writeDaemonHeartbeat(db);
        } finally {
          db.close();
        }
      } catch (err) {
        process.stderr.write(
          `[daemon] heartbeat write failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    })();
  }, DAEMON_HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  // Fire one heartbeat immediately so /health is healthy from t=0 (otherwise
  // the first 5 seconds after boot show a missing row, indistinguishable
  // from a daemon that never ticked).
  try {
    const { initDb } = await import('../db/client.js');
    const { getDbPath } = await import('../utils/config.js');
    const db = initDb(getDbPath());
    try {
      writeDaemonHeartbeat(db);
    } finally {
      db.close();
    }
  } catch (err) {
    process.stderr.write(
      `[daemon] initial heartbeat write failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  // ── Background schedule tick (every 60s) ────────────────────────────────
  let scheduleTickInFlight = false;
  const scheduleTickTimer = setInterval(() => {
    if (scheduleTickInFlight) return;
    scheduleTickInFlight = true;

    // Emit task_hung events for stale heartbeats (Cluster B t5)
    try {
      const hung = emitTaskHungEvents();
      if (hung.emitted > 0) {
        process.stderr.write(`[daemon] task_hung emitted for ${hung.emitted} task(s)\n`);
      }
      const expired = expireTimedOutRunningTasksFromDefaultDb();
      if (expired.expired.length > 0) {
        process.stderr.write(`[daemon] task_lease_expired failed ${expired.expired.length} task(s)\n`);
      }
    } catch (err) {
      process.stderr.write(`[daemon] task liveness tick failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }

    void runDashboardScheduleTickOnce()
      .catch((err) => {
        process.stderr.write(`[daemon] schedule tick failed: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        scheduleTickInFlight = false;
      });
  }, 60_000);
  scheduleTickTimer.unref();

  // ── Background OmniRoute health refresh (every 5 minutes) ───────────────
  // Refreshes health status from OmniRoute to keep cache current
  // for failover decisions and dashboard visualization
  const HEALTH_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  let healthRefreshInFlight = false;
  
  const healthRefreshTimer = setInterval(() => {
    if (healthRefreshInFlight) return;
    healthRefreshInFlight = true;

    void refreshHealthStatus()
      .then((result) => {
        if (result.ok) {
          process.stderr.write(`[daemon] OmniRoute health refreshed successfully\n`);
        } else {
          process.stderr.write(`[daemon] OmniRoute health refresh failed: ${result.error}\n`);
        }
      })
      .catch((err) => {
        process.stderr.write(`[daemon] OmniRoute health refresh error: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        healthRefreshInFlight = false;
      });
  }, HEALTH_REFRESH_INTERVAL_MS);
  healthRefreshTimer.unref();
  
  // Initial health refresh on startup
  void refreshHealthStatus().catch((err) => {
    process.stderr.write(`[daemon] Initial OmniRoute health refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });

  process.stderr.write(`[daemon] HTTP MCP server listening on http://127.0.0.1:${port}\n`);
  const authDisabled = (process.env.OMNIFORGE_DAEMON_AUTH ?? '').trim().toLowerCase() === 'off';
  const authLabel = authDisabled ? 'local auth disabled' : 'Bearer auth';
  // Security (Wave 5B Issue #5): make the bypass loud. When OMNIFORGE_DAEMON_AUTH=off
  // is set, every endpoint (advisors, workflows, vault, gates) accepts requests
  // from any process on the local machine without a token. Surface this with a
  // banner so the operator notices.
  if (authDisabled) {
    process.stderr.write('[daemon] ⚠️  WARNING: OMNIFORGE_DAEMON_AUTH=off — Bearer auth DISABLED for loopback requests. All endpoints reachable without a token. Unset this env to re-enable.\n');
  }
  process.stderr.write(`[daemon] SSE:    GET  /mcp/sse           (${authLabel})\n`);
  process.stderr.write(`[daemon] Tools:  GET  /mcp/tools/list    (${authLabel})\n`);
  process.stderr.write(`[daemon] Health: GET  /health            (no auth)\n`);
  process.stderr.write(`[daemon] UI:     GET  /dashboard         (${authLabel})\n`);
  process.stderr.write(`[daemon] REPL:   POST /actor/register | /workflow/:id/cancel | /gate/:id/resolve\n`);
  process.stderr.write(`[daemon] SSE:    GET  /events/workflow/:id | /events/gates    POST /stream/llm\n`);

  return async () => {
    clearInterval(scheduleTickTimer);
    clearInterval(heartbeatTimer);
    for (const t of transports.values()) {
      await t.close().catch(() => {});
    }
    actorRegistry.clear();
    llmStreamsByActor.clear();
    eventBroker.reset();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
}

// Test-only exports for repl-routes.test.ts internal verification.
// Re-exported from routers' shared modules to preserve back-compat.
export const __testing__ = {
  actorRegistry,
  llmStreamsByActor,
  ACTOR_TOKEN_TTL_MS,
  MAX_LLM_STREAMS_PER_ACTOR,
  scheduleTickHistory,
  SCHEDULE_TICK_MAX_PER_WINDOW,
  SCHEDULE_TICK_WINDOW_MS,
};
