// Onda 2 (post-validation): persona-vs-legacy metrics REST API.
//
// Surfaces aggregated `agent_started` / `agent_completed` / `agent_rejected`
// events + trace_spans data so the dashboard can render a
// "feature flag rollout" card. Bearer-auth gated upstream.
//
// Routes:
//   GET /api/dashboard/persona-metrics
//     ?workspace=<name>           (optional — share & per-persona stats span all workflows when absent)
//     &workflow_id=<wfId>         (optional — single-workflow drill-down)
//     &since_ms=<epoch_ms>        (optional — cutoff)
//
//   Returns: { share, stats[] }
//     share: PersonaVsLegacyShare (workflows_total, workflows_with_persona_path, persona_path_share_pct)
//     stats: PersonaInvocationStats[] (per agent_id)

import type { ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  getPersonaMetrics,
  getPersonaVsLegacyShare,
} from '../../v2/observability/persona-metrics.js';
import type { Router } from './types.js';
import { badRequest, jsonOk } from './_shared.js';

function handleMetrics(url: URL, res: ServerResponse): void {
  const workflowId = url.searchParams.get('workflow_id') ?? undefined;
  const sinceMsRaw = url.searchParams.get('since_ms');
  const sinceMs = sinceMsRaw ? Number(sinceMsRaw) : undefined;
  if (sinceMs != null && !Number.isFinite(sinceMs)) {
    badRequest(res, 'since_ms must be a valid epoch millisecond timestamp');
    return;
  }
  const db = initDb(getDbPath());
  try {
    const stats = getPersonaMetrics(db, {
      ...(workflowId ? { workflowId } : {}),
      ...(sinceMs != null ? { sinceMs } : {}),
    });
    const share = getPersonaVsLegacyShare(db, sinceMs);
    jsonOk(res, { share, stats });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

export const dashboardPersonaMetricsRouter: Router = async (req, url, res) => {
  if (req.method === 'GET' && url.pathname === '/api/dashboard/persona-metrics') {
    handleMetrics(url, res);
    return true;
  }
  return false;
};
