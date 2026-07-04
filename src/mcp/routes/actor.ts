// Sprint 4.7 (D-H2.066): /actor/{register,heartbeat,unregister},
// /workflow/:id/cancel, /gate/:id/resolve.
//
// Actor registry is in-memory (see _actor-registry.ts). All endpoints
// POST-AUTH (Bearer). Cancel propagates AbortController.abort() to all
// in-flight tasks (Sprint 2.2, F-REL-1). Gate resolve is race-safe.

import type { ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  insertEvent,
  loadHitlGateById,
  loadWorkflowById,
  resolveHitlGateWithActor,
  setWorkflowMetadata,
} from '../../db/persist.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import { eventBroker } from '../event-broker.js';
import { broadcastCancelToWorkflow } from '../../v2/subagent/control.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, notFound, readJsonBody, safeJsonParse, unauthorized } from './_shared.js';
import {
  ACTOR_TOKEN_TTL_MS,
  actorRegistry,
  generateActorId,
  generateActorToken,
  isExpired,
  llmStreamsByActor,
  pruneExpiredActors,
  requireActorToken,
  type ActorEntry,
} from './_actor-registry.js';

interface RegisterBody { actor_id?: string; kind?: ActorEntry['kind']; }
interface CancelBody { reason?: string; }
interface GateResolveBody {
  decision?: 'approve' | 'reject' | 'modify';
  modified_input?: unknown;
  comment?: string;
  actor_token?: string;
}

const DECISION_MAP = {
  approve: 'approved',
  reject: 'rejected',
  modify: 'modify',
} as const;

function handleActorRegister(body: RegisterBody, res: ServerResponse): void {
  pruneExpiredActors();
  const kind: ActorEntry['kind'] =
    body.kind === 'cli' || body.kind === 'external' || body.kind === 'repl' ? body.kind : 'repl';
  const actorId = (typeof body.actor_id === 'string' && body.actor_id.trim().length > 0)
    ? body.actor_id.trim().slice(0, 64)
    : generateActorId(kind);
  const token = generateActorToken();
  const expiresAt = Date.now() + ACTOR_TOKEN_TTL_MS;
  actorRegistry.set(token, { actor_id: actorId, kind, expires_at: expiresAt });
  jsonOk(res, { actor_id: actorId, actor_token: token, expires_at: expiresAt });
}

function handleActorHeartbeat(body: { actor_token?: string }, res: ServerResponse): void {
  pruneExpiredActors();
  const token = typeof body.actor_token === 'string' ? body.actor_token : '';
  const entry = actorRegistry.get(token);
  if (!entry || isExpired(entry)) { unauthorized(res); return; }
  const newExpiry = Date.now() + ACTOR_TOKEN_TTL_MS;
  actorRegistry.set(token, { ...entry, expires_at: newExpiry });
  jsonOk(res, { actor_id: entry.actor_id, expires_at: newExpiry });
}

function handleActorUnregister(body: { actor_token?: string }, res: ServerResponse): void {
  const token = typeof body.actor_token === 'string' ? body.actor_token : '';
  if (token) actorRegistry.delete(token);
  llmStreamsByActor.delete(token);
  jsonOk(res, { ok: true });
}

function handleWorkflowCancel(wfId: string, body: CancelBody, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const wf = loadWorkflowById(db, wfId);
    if (!wf) { notFound(res, `Workflow not found: ${wfId}`); return; }

    const terminal = ['completed', 'failed', 'cancelled'];
    if (terminal.includes(wf.status)) {
      jsonOk(res, { error: 'workflow_already_terminal', status: wf.status, wf_id: wfId }, 409);
      return;
    }

    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
    const now = Date.now();

    // A15 (Sprint 2.2, F-REL-1 / atomic cancel): broadcast + status flip +
    // metadata patch must commit as a single SQLite transaction so process
    // death between the broadcast and the status flip CANNOT leave a
    // workflow stuck in 'executing' with all tasks 'cancelled'.
    //
    // The transaction is additionally wrapped in withSqliteRetrySync to
    // recover from transient SQLITE_BUSY caused by WAL checkpoints or
    // concurrent writers (executor + scheduler tick). On BUSY, better-sqlite3
    // rolls back the entire txn before we see the error, so the retry sees
    // a clean slate — no partial cancel state leaks.
    //
    // Side effects inside the txn (control.broadcastCancelToWorkflow):
    //   - aborts AbortController for each running task (process-local)
    //   - flips tasks.status to 'cancelled'
    //   - flips active subagent_runs to 'killed'
    //   - cancels pending subagent_messages
    //
    // Note: AbortController.abort() is NOT transactional — if the txn
    // rolls back, controllers stay aborted. This is acceptable because
    // (a) the operator's intent was to cancel, and (b) on retry we will
    // re-abort the same (already-aborted) controllers, which is a no-op.
    let broadcast: ReturnType<typeof broadcastCancelToWorkflow>;
    const cancelTx = db.transaction(() => {
      broadcast = broadcastCancelToWorkflow(db, wfId, reason);

      db.prepare(`UPDATE workflows SET status = 'cancelled', completed_at = ? WHERE id = ?`)
        .run(now, wfId);

      const existingMeta = wf.metadata ? safeJsonParse(wf.metadata) : {};
      const newMeta = {
        ...existingMeta,
        cancelled_reason: reason,
        cancelled_at: now,
        cancel_propagation: broadcast,
      };
      setWorkflowMetadata(db, wfId, JSON.stringify(newMeta));
    });
    withSqliteRetrySync(() => cancelTx());

    insertEvent(db, {
      workflow_id: wfId,
      type: 'workflow_cancelled',
      payload: {
        reason,
        tasks_cancelled: broadcast!.tasks_cancelled,
        controllers_aborted: broadcast!.controllers_aborted,
        messages_cancelled: broadcast!.messages_cancelled,
      },
    });

    jsonOk(res, {
      wf_id: wfId,
      cancelled: true,
      tasks_cancelled: broadcast!.tasks_cancelled,
      controllers_aborted: broadcast!.controllers_aborted,
      messages_cancelled: broadcast!.messages_cancelled,
    });
  } finally {
    db.close();
  }
}

function handleGateResolve(gateId: string, body: GateResolveBody, res: ServerResponse): void {
  const actor = requireActorToken(body.actor_token);
  if (!actor) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'actor_token required and must be valid' }));
    return;
  }

  if (body.decision !== 'approve' && body.decision !== 'reject' && body.decision !== 'modify') {
    badRequest(res, 'decision must be one of approve|reject|modify');
    return;
  }

  const db = initDb(getDbPath());
  try {
    const gate = loadHitlGateById(db, gateId);
    if (!gate) { notFound(res, `Gate not found: ${gateId}`); return; }

    const dbDecision = DECISION_MAP[body.decision];
    const result = resolveHitlGateWithActor(db, gateId, dbDecision, actor.actor_id, body.comment);

    if (body.modified_input !== undefined || body.comment) {
      const existing = gate.context_json ? safeJsonParse(gate.context_json) : {};
      const updated: Record<string, unknown> = { ...existing };
      if (body.modified_input !== undefined) updated['modified_input'] = body.modified_input;
      if (body.comment) updated['comment'] = body.comment;
      withSqliteRetrySync(() =>
        db.prepare('UPDATE hitl_gates SET context_json = ? WHERE id = ?').run(
          JSON.stringify(updated), gateId,
        ),
      );
    }

    if (result.first_resolver) {
      eventBroker.publishGate({
        type: 'gate_resolved',
        gate_id: gateId,
        workflow_id: gate.workflow_id,
        workspace: null,
        payload: {
          decision: result.decision,
          resolved_by_actor: result.resolved_by_actor,
        },
      });
    }

    jsonOk(res, {
      gate_id: gateId,
      first_resolver: result.first_resolver,
      resolved_by_actor: result.resolved_by_actor,
      ...(result.race_lost
        ? { race_lost: true, winning_decision: result.decision }
        : { decision: result.decision }),
    });
  } finally {
    db.close();
  }
}

export const actorRouter: Router = async (req, url, res, _ctx) => {
  if (req.method === 'POST' && url.pathname === '/actor/register') {
    let body: RegisterBody;
    try { body = (await readJsonBody(req)) as RegisterBody; }
    catch (err) { badRequest(res, (err as Error).message); return true; }
    handleActorRegister(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/actor/heartbeat') {
    let body: { actor_token?: string };
    try { body = (await readJsonBody(req)) as { actor_token?: string }; }
    catch (err) { badRequest(res, (err as Error).message); return true; }
    handleActorHeartbeat(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/actor/unregister') {
    let body: { actor_token?: string };
    try { body = (await readJsonBody(req)) as { actor_token?: string }; }
    catch (err) { badRequest(res, (err as Error).message); return true; }
    handleActorUnregister(body, res);
    return true;
  }
  const cancelMatch = url.pathname.match(/^\/workflow\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    let body: CancelBody;
    try { body = (await readJsonBody(req)) as CancelBody; }
    catch (err) { badRequest(res, (err as Error).message); return true; }
    handleWorkflowCancel(decodeURIComponent(cancelMatch[1] ?? ''), body, res);
    return true;
  }
  const gateMatch = url.pathname.match(/^\/gate\/([^/]+)\/resolve$/);
  if (req.method === 'POST' && gateMatch) {
    let body: GateResolveBody;
    try { body = (await readJsonBody(req)) as GateResolveBody; }
    catch (err) { badRequest(res, (err as Error).message); return true; }
    handleGateResolve(decodeURIComponent(gateMatch[1] ?? ''), body, res);
    return true;
  }
  return false;
};
