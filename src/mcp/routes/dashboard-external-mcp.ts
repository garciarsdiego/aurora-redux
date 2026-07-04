// Mission 5, B3: External MCP server CRUD endpoints.
//
// Manages rows in the `external_mcp_servers` table (migration 048), which
// lets operators register stdio or HTTP-SSE MCP servers that Omniforge
// proxies to the LLM during task execution.
//
// All routes are Bearer-auth gated by http-server.ts upstream.
//
// Routes:
//   GET    /api/dashboard/external-mcp/servers             — list all servers
//   POST   /api/dashboard/external-mcp/servers             — add a server
//   PATCH  /api/dashboard/external-mcp/servers/:nameOrId   — update fields
//   DELETE /api/dashboard/external-mcp/servers/:nameOrId   — remove a server
//   POST   /api/dashboard/external-mcp/servers/:nameOrId/toggle — toggle active
//   GET    /api/dashboard/external-mcp/tools               — list tools from active servers

import type { IncomingMessage, ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  listServers,
  addServer,
  updateServer,
  deleteServer,
  setServerActive,
  getServer,
} from '../../v2/external-mcp/registry.js';
import { ExternalMcpManager } from '../../v2/external-mcp/client.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from './_shared.js';

// ── Path patterns ─────────────────────────────────────────────────────────────

const SERVERS_BASE = '/api/dashboard/external-mcp/servers';
const TOOLS_PATH = '/api/dashboard/external-mcp/tools';

// Matches /api/dashboard/external-mcp/servers/:nameOrId
const SERVER_ITEM_RE = /^\/api\/dashboard\/external-mcp\/servers\/([^/]+)$/;
// Matches /api/dashboard/external-mcp/servers/:nameOrId/toggle
const SERVER_TOGGLE_RE = /^\/api\/dashboard\/external-mcp\/servers\/([^/]+)\/toggle$/;

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleList(res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const servers = listServers(db);
    jsonOk(res, { servers });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }

  const db = initDb(getDbPath());
  try {
    const server = addServer(db, rawBody as Record<string, unknown>);
    jsonOk(res, { server }, 201);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleUpdate(
  nameOrId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }

  const db = initDb(getDbPath());
  try {
    const server = updateServer(db, nameOrId, rawBody as Record<string, unknown>);
    jsonOk(res, { server });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) {
      notFound(res, msg);
      return;
    }
    badRequest(res, msg);
  } finally {
    db.close();
  }
}

function handleDelete(nameOrId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const ok = deleteServer(db, nameOrId);
    if (!ok) {
      notFound(res, `External MCP server not found: ${nameOrId}`);
      return;
    }
    jsonOk(res, { deleted: true, nameOrId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) {
      notFound(res, msg);
      return;
    }
    badRequest(res, msg);
  } finally {
    db.close();
  }
}

async function handleToggle(
  nameOrId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(req);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
    return;
  }

  const input = rawBody as Record<string, unknown>;
  if (typeof input['active'] !== 'boolean') {
    badRequest(res, 'body must include `active` (boolean)');
    return;
  }

  const db = initDb(getDbPath());
  try {
    setServerActive(db, nameOrId, input['active']);
    const server = getServer(db, nameOrId);
    if (!server) {
      notFound(res, `External MCP server not found: ${nameOrId}`);
      return;
    }
    jsonOk(res, { server });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) {
      notFound(res, msg);
      return;
    }
    badRequest(res, msg);
  } finally {
    db.close();
  }
}

async function handleListTools(res: ServerResponse): Promise<void> {
  try {
    const manager = ExternalMcpManager.getInstance();
    const tools = await manager.listAllTools();
    jsonOk(res, { tools });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

// ── Router export ─────────────────────────────────────────────────────────────

export const dashboardExternalMcpRouter: Router = async (req, url, res) => {
  // GET /api/dashboard/external-mcp/servers — list
  if (req.method === 'GET' && url.pathname === SERVERS_BASE) {
    handleList(res);
    return true;
  }

  // POST /api/dashboard/external-mcp/servers — add
  if (req.method === 'POST' && url.pathname === SERVERS_BASE) {
    await handleAdd(req, res);
    return true;
  }

  // GET /api/dashboard/external-mcp/tools — list tools from active servers
  if (req.method === 'GET' && url.pathname === TOOLS_PATH) {
    await handleListTools(res);
    return true;
  }

  // POST /api/dashboard/external-mcp/servers/:nameOrId/toggle
  const toggleMatch = url.pathname.match(SERVER_TOGGLE_RE);
  if (toggleMatch && req.method === 'POST') {
    const nameOrId = decodeURIComponent(toggleMatch[1] ?? '');
    if (!nameOrId) return false;
    await handleToggle(nameOrId, req, res);
    return true;
  }

  // PATCH or DELETE /api/dashboard/external-mcp/servers/:nameOrId
  const itemMatch = url.pathname.match(SERVER_ITEM_RE);
  if (itemMatch) {
    const nameOrId = decodeURIComponent(itemMatch[1] ?? '');
    if (!nameOrId) return false;

    if (req.method === 'PATCH') {
      await handleUpdate(nameOrId, req, res);
      return true;
    }

    if (req.method === 'DELETE') {
      handleDelete(nameOrId, res);
      return true;
    }
  }

  return false;
};
