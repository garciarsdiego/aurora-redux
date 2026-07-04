// Sprint 4.1 (D-H2.066): foundation types for future http-server.ts split.
//
// http-server.ts currently routes 47+ endpoints in a single switch chain
// (~2275 LOC pre-split). The full split (Sprints 4.2-4.8) factors handlers
// into per-category routers behind the contract below. Each router exports
// `register(req, url, res, ctx) => Promise<boolean>` — returns true if the
// route was handled (response written), false if the next router should try.
//
// As of Sprint 4.1 only this types file exists. Routers extracted
// incrementally in dedicated future session — see docs/PLANO-CURADO-SPRINTS.md
// § Sprint 4 status.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

/**
 * Context passed to every router. Captures shared state that handlers need
 * but should NOT each construct themselves (token, port, version, etc.).
 */
export interface RouteContext {
  /** Daemon Bearer token (constant-time compared by auth gate, then passed
   *  to webhook secret encryption / decryption). */
  token: string;
  /** Port the daemon is listening on; needed for /health response and for
   *  log lines that reference the local URL. */
  port: number;
  /** Resolved version info from dist/version.json (or package.json fallback);
   *  exposed in /health and in X-Omniforge-Api-Version contracts. */
  version: { version: string; commit?: string };
  /** ms since the server bootstrapped — for /health.uptime_ms. */
  serverStartMs: number;
  /** MCP SSE transports keyed by sessionId — owned by mcp-transport router. */
  mcpTransports: Map<string, SSEServerTransport>;
  /** Track in-flight dashboard task retries (workflow_id -> running promise)
   *  to prevent double-execution. Owned by workflow-ops router. */
  dashboardRetryExecutions: Map<string, Promise<void>>;
}

/**
 * Router contract: returns true if the route was matched and the response
 * was written; false if the next router (or 404 fallthrough) should run.
 *
 * Routers MUST NOT throw uncaught — the http-server top-level catch is
 * deliberately minimal. Wrap handler errors and call badRequest / etc.
 */
export type Router = (
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<boolean>;
