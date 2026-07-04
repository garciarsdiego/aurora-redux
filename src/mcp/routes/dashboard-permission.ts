// Wave 2.A: persona-tool permission decision endpoint.
//
// Operator surface for resolving `permission_ask` SSE events. Today the
// daemon is emit-and-continue — tools proceed immediately without waiting
// for an operator decision. This route records the operator's resolution
// for audit and broadcasts a `permission_decided` SSE event so other open
// dashboard tabs sync. Future work flips the gate to await-and-resolve;
// the same `ask_id` already round-trips, so no wire change is needed.
//
// Route:
//   POST /api/dashboard/permission/decide
//     body: { ask_id, decision: 'approve' | 'deny', decided_by? }
//   Persists into permission_decisions (idempotent — second decision is a
//   no-op rather than an overwrite, so two operators racing don't clobber
//   each other's calls).

import type { ServerResponse } from 'node:http';

import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { insertEvent } from '../../db/persist.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readJsonBody } from './_shared.js';

interface DecideBody {
  ask_id?: unknown;
  decision?: unknown;
  decided_by?: unknown;
  workflow_id?: unknown;
  task_id?: unknown;
  agent_id?: unknown;
  tool?: unknown;
}

function parseAskId(askId: string): {
  workflow_id: string | null;
  task_id: string | null;
  agent_id: string;
  tool: string;
} | null {
  // Format from src/v2/agents/permissions.ts: wf:tk:agent:tool:nonce
  const parts = askId.split(':');
  if (parts.length < 5) return null;
  const [wf, tk, agent, tool] = parts;
  if (!agent || !tool) return null;
  return {
    workflow_id: wf && wf !== '_' ? wf : null,
    task_id: tk && tk !== '_' ? tk : null,
    agent_id: agent,
    tool,
  };
}

async function handleDecide(req: Parameters<Router>[0], res: ServerResponse): Promise<void> {
  let body: DecideBody;
  try {
    body = (await readJsonBody(req)) as DecideBody;
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : 'invalid body');
    return;
  }

  const askId = typeof body.ask_id === 'string' ? body.ask_id : '';
  const decision = body.decision === 'approve' || body.decision === 'deny' ? body.decision : null;
  if (!askId) {
    badRequest(res, 'ask_id is required');
    return;
  }
  if (!decision) {
    badRequest(res, "decision must be 'approve' or 'deny'");
    return;
  }

  const parsed = parseAskId(askId);
  if (!parsed) {
    badRequest(res, 'ask_id has unexpected shape');
    return;
  }

  const decidedBy = typeof body.decided_by === 'string' && body.decided_by.length > 0
    ? body.decided_by
    : 'dashboard';

  // Allow the caller to override identifiers if the dashboard kept them
  // separately from the ask_id (e.g. when the SSE event payload is what we
  // trust). Falls back to whatever we parsed out of the id.
  const workflowId = typeof body.workflow_id === 'string' && body.workflow_id.length > 0
    ? body.workflow_id
    : parsed.workflow_id;
  const taskId = typeof body.task_id === 'string' && body.task_id.length > 0
    ? body.task_id
    : parsed.task_id;
  const agentId = typeof body.agent_id === 'string' && body.agent_id.length > 0
    ? body.agent_id
    : parsed.agent_id;
  const tool = typeof body.tool === 'string' && body.tool.length > 0 ? body.tool : parsed.tool;

  const db = initDb(getDbPath());
  const now = Date.now();
  let recorded = false;
  let alreadyDecided = false;
  let existingDecision: string | null = null;
  let existingDecidedBy: string | null = null;
  try {
    // Upsert: insert if absent (a decision is allowed even when the ask wasn't
    // pre-recorded, since the ask itself flows through events not this table).
    // If a row already exists with a non-null decision, the second call is a
    // no-op and reports the original.
    const existing = db
      .prepare(
        `SELECT decision, decided_by FROM permission_decisions WHERE ask_id = ?`,
      )
      .get(askId) as { decision: string | null; decided_by: string | null } | undefined;

    if (existing) {
      if (existing.decision != null) {
        alreadyDecided = true;
        existingDecision = existing.decision;
        existingDecidedBy = existing.decided_by;
      } else {
        db.prepare(
          `UPDATE permission_decisions
              SET decision = ?, decided_by = ?, decided_at = ?
            WHERE ask_id = ?`,
        ).run(decision, decidedBy, now, askId);
        recorded = true;
      }
    } else {
      db.prepare(
        `INSERT INTO permission_decisions
            (ask_id, workflow_id, task_id, agent_id, tool,
             decision, decided_by, asked_at, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(askId, workflowId, taskId, agentId, tool, decision, decidedBy, now, now);
      recorded = true;
    }

    if (recorded && workflowId) {
      // Broadcast so other open dashboards sync. Same plumbing as
      // permission_ask — flows through insertEvent → eventBroker.
      insertEvent(db, {
        workflow_id: workflowId,
        task_id: taskId,
        type: 'permission_decided',
        payload: {
          ask_id: askId,
          agent_id: agentId,
          tool,
          decision,
          decided_by: decidedBy,
          decided_at: now,
        },
      });
    }

    jsonOk(res, {
      ask_id: askId,
      decision: alreadyDecided ? existingDecision : decision,
      decided_by: alreadyDecided ? existingDecidedBy : decidedBy,
      already_decided: alreadyDecided,
      recorded,
    });
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

export const dashboardPermissionRouter: Router = async (req, url, res) => {
  if (req.method === 'POST' && url.pathname === '/api/dashboard/permission/decide') {
    await handleDecide(req, res);
    return true;
  }
  return false;
};
