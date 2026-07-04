// Surfaces `omniforge_replay_persona_version` MCP tool over HTTP for dashboard-v2.
//
// Route:
//   POST /api/dashboard/personas/replay-version
//   { persona_id, version, input, workspace? }
//
// Returns the parsed JSON object the tool emits (replayed_output, live_output, diff, …).

import type { ServerResponse, IncomingMessage } from 'node:http';
import { replayPersonaVersionTool } from '../tools/replay_persona_version.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readJsonBody } from './_shared.js';

async function handleReplayPersonaVersion(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    badRequest(res, (err as Error).message);
    return;
  }
  try {
    const raw = await replayPersonaVersionTool(body);
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

export const dashboardPersonaReplayRouter: Router = async (req, url, res) => {
  if (req.method === 'POST' && url.pathname === '/api/dashboard/personas/replay-version') {
    await handleReplayPersonaVersion(req, res);
    return true;
  }
  return false;
};
