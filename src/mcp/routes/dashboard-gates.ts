// Handler for HITL gate listing and dashboard resolution.
//
// All routes are Bearer-auth gated by http-server.ts upstream.
//
// Routes:
//   GET  /api/dashboard/gates                — list pending (and recent resolved) gates
//   POST /api/dashboard/gates/:id/resolve    — approve / reject / modify a gate
//
// The GET endpoint returns pending gates first (by created_at desc), then
// recently decided gates (up to `resolved_limit`, default 20). The POST
// endpoint is a dashboard convenience path that does NOT require an
// actor_token — it resolves as the daemon operator. For actor-token-gated
// resolution from REPL / CLI use the existing POST /gate/:id/resolve endpoint
// in actor.ts.
//
// Auth: Bearer only (enforced by http-server.ts router chain). No actor_token
// required here — dashboard operator is implicitly trusted after Bearer auth.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  loadHitlGateById,
  resolveHitlGate,
  type HitlGateRow,
} from '../../db/persist.js';
import { eventBroker } from '../event-broker.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound, readJsonBody } from './_shared.js';

// ── Path pattern ─────────────────────────────────────────────────────────────

const GATE_RESOLVE_RE = /^\/api\/dashboard\/gates\/([^/]+)\/resolve$/;

// ── Validation schemas ────────────────────────────────────────────────────────

const ResolveBodySchema = z.object({
  decision: z.enum(['approve', 'reject', 'modify']),
  comment: z.string().max(2000).optional(),
});

const DECISION_MAP = {
  approve: 'approved',
  reject: 'rejected',
  modify: 'modify',
} as const;

// ── Handlers ──────────────────────────────────────────────────────────────────

function handleListGates(url: URL, res: ServerResponse): void {
  const pendingLimitRaw = url.searchParams.get('pending_limit');
  const resolvedLimitRaw = url.searchParams.get('resolved_limit');

  const pendingLimit = (() => {
    const n = Number.parseInt(pendingLimitRaw ?? '50', 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 1), 200) : 50;
  })();
  const resolvedLimit = (() => {
    const n = Number.parseInt(resolvedLimitRaw ?? '20', 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 0), 100) : 20;
  })();

  const db = initDb(getDbPath());
  try {
    const pendingRows = db
      .prepare(
        `SELECT id, workflow_id, task_id, gate_type, prompt, context_json,
                status, decision, decision_reason, resolved_by_actor,
                channel, created_at, decided_at
           FROM hitl_gates
          WHERE status = 'pending'
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(pendingLimit) as HitlGateRow[];

    const recentRows: HitlGateRow[] = resolvedLimit > 0
      ? (db
          .prepare(
            `SELECT id, workflow_id, task_id, gate_type, prompt, context_json,
                    status, decision, decision_reason, resolved_by_actor,
                    channel, created_at, decided_at
               FROM hitl_gates
              WHERE status != 'pending'
              ORDER BY decided_at DESC
              LIMIT ?`,
          )
          .all(resolvedLimit) as HitlGateRow[])
      : [];

    jsonOk(res, {
      pending: pendingRows,
      recent: recentRows,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

async function handleResolveGate(
  gateId: string,
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

  const parsed = ResolveBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    badRequest(res, parsed.error.issues[0]?.message ?? 'invalid body');
    return;
  }

  const { decision, comment } = parsed.data;
  const dbDecision = DECISION_MAP[decision];

  const db = initDb(getDbPath());
  try {
    const gate = loadHitlGateById(db, gateId);
    if (!gate) {
      notFound(res, `Gate not found: ${gateId}`);
      return;
    }

    if (gate.status !== 'pending') {
      jsonOk(res, { gate_id: gateId, already_resolved: true, status: gate.status }, 409);
      return;
    }

    resolveHitlGate(db, gateId, dbDecision);

    if (comment) {
      const existing: Record<string, unknown> = (() => {
        try {
          return gate.context_json
            ? (JSON.parse(gate.context_json) as Record<string, unknown>)
            : {};
        } catch {
          return {};
        }
      })();
      db.prepare('UPDATE hitl_gates SET context_json = ? WHERE id = ?').run(
        JSON.stringify({ ...existing, comment }),
        gateId,
      );
    }

    eventBroker.publishGate({
      type: 'gate_resolved',
      gate_id: gateId,
      workflow_id: gate.workflow_id,
      workspace: null,
      payload: { decision: dbDecision, resolved_by_actor: 'dashboard' },
    });

    jsonOk(res, {
      gate_id: gateId,
      decision: dbDecision,
      resolved_by_actor: 'dashboard',
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// ── Router export ─────────────────────────────────────────────────────────────

export const dashboardGatesRouter: Router = async (req, url, res) => {
  // GET /api/dashboard/gates
  if (req.method === 'GET' && url.pathname === '/api/dashboard/gates') {
    handleListGates(url, res);
    return true;
  }

  // POST /api/dashboard/gates/:id/resolve
  const resolveMatch = url.pathname.match(GATE_RESOLVE_RE);
  if (req.method === 'POST' && resolveMatch) {
    await handleResolveGate(decodeURIComponent(resolveMatch[1] ?? ''), req, res);
    return true;
  }

  return false;
};
