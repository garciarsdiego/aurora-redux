// Sprint post-audit B7.6 (2026-05-05): builder chat REST API for dashboard.
//
// Surfaces the existing `omniforge_builder_chat` MCP tool over HTTP so the
// dashboard can drive the conversational AI Builder without an MCP transport.
// All routes are Bearer-auth gated upstream.
//
// Route:
//   POST   /api/dashboard/builder/chat   { workspace, session_id, message }
//
// Returns the same envelope the MCP tool returns (reply, action, dag, …).
//
// Listing prior sessions is already covered by GET /api/dashboard/planner-sessions
// (in dashboard-data.ts) — no need to duplicate.

import type { ServerResponse, IncomingMessage } from 'node:http';
import { omniforge_builder_chat } from '../tools/builder_chat.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readJsonBody } from './_shared.js';

async function handleBuilderChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    badRequest(res, (err as Error).message);
    return;
  }
  try {
    const raw = await omniforge_builder_chat(body);
    // omniforge_builder_chat returns a JSON string envelope — re-parse so the
    // dashboard receives a real object (matches the rest of the dashboard API).
    let parsed: Record<string, unknown>;
    try {
      const decoded = JSON.parse(raw) as unknown;
      parsed = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : { raw };
    } catch {
      parsed = { raw };
    }
    jsonOk(res, parsed);
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  }
}

export const dashboardBuilderRouter: Router = async (req, url, res) => {
  if (req.method === 'POST' && url.pathname === '/api/dashboard/builder/chat') {
    await handleBuilderChat(req, res);
    return true;
  }
  return false;
};
