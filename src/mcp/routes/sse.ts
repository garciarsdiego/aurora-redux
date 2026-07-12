// Sprint 4.7 (D-H2.066): SSE endpoints — /events/workflow/:id, /events/gates,
// /events/notifications, POST /stream/llm.
//
// All POST-AUTH. Cleanup paths (Sprint 3.7, F-REL-6) log errors and fall
// back to res.destroy(). LLM stream rate-limited per actor (default 4
// concurrent — getMaxLlmStreamsPerActor()).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath, getMaxLlmStreamsPerActor } from '../../utils/config.js';
import { eventBroker, type GateEvent } from '../event-broker.js';
import { callOmnirouteStream } from '../../utils/omniroute-stream.js';
import type { Router } from './types.js';
import {
  badRequest,
  readBodyOr400,
  safeEndSse,
  safeJsonParse,
  sendSseEvent,
  setSseHeaders,
  wireSseLifecycle,
} from './_shared.js';
import {
  llmStreamsByActor,
  requireActorToken,
  type ActorAuth,
} from './_actor-registry.js';

interface BackfillRow { id: number; type: string; task_id: string | null; payload_json: string | null; timestamp: number; }

function handleWorkflowEventsSse(wfId: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
  setSseHeaders(res);
  const sinceParam = url.searchParams.get('since_event_id');
  const sinceId = sinceParam ? parseInt(sinceParam, 10) : 0;
  const safeSince = isNaN(sinceId) || sinceId < 0 ? 0 : sinceId;

  const db = initDb(getDbPath());
  try {
    const rows = db.prepare(
      `SELECT id, type, task_id, payload_json, timestamp
       FROM events WHERE workflow_id = ? AND id > ?
       ORDER BY id ASC LIMIT 500`,
    ).all(wfId, safeSince) as BackfillRow[];

    for (const row of rows) {
      const payload = row.payload_json ? safeJsonParse(row.payload_json) : {};
      const data = {
        type: row.type,
        workflow_id: wfId,
        task_id: row.task_id,
        payload,
        timestamp: row.timestamp,
      };
      sendSseEvent(res, row.type, data, row.id);
      sendSseEvent(res, 'workflow_event', data, row.id);
    }
  } finally {
    db.close();
  }

  const unsubscribe = eventBroker.subscribeWorkflow(wfId, (ev) => {
    const data = {
      type: ev.type,
      workflow_id: ev.workflow_id,
      task_id: (ev.payload['task_id'] as string | undefined) ?? null,
      payload: ev.payload,
      timestamp: Date.now(),
    };
    sendSseEvent(res, ev.type, data);
    sendSseEvent(res, 'workflow_event', data);
  });

  wireSseLifecycle(req, res, () => {
    unsubscribe();
    safeEndSse(res);
  });
}

function handleGateEventsSse(url: URL, req: IncomingMessage, res: ServerResponse): void {
  setSseHeaders(res);
  const workspace = url.searchParams.get('workspace');
  const wsFilter = workspace && workspace.trim().length > 0 ? workspace.trim() : null;

  const unsubscribe = eventBroker.subscribeGates(wsFilter, (ev: GateEvent) => {
    sendSseEvent(res, ev.type, {
      gate_id: ev.gate_id,
      workflow_id: ev.workflow_id,
      workspace: ev.workspace,
      payload: ev.payload,
      timestamp: Date.now(),
    });
  });

  wireSseLifecycle(req, res, () => {
    unsubscribe();
    safeEndSse(res);
  });
}

function handleNotificationEventsSse(url: URL, req: IncomingMessage, res: ServerResponse): void {
  setSseHeaders(res);
  const userId = url.searchParams.get('user_id') ?? 'default';

  // Backfill: send recent unread notifications
  const db = initDb(getDbPath());
  try {
    const rows = db.prepare(
      `SELECT id, user_id, type, title, body, priority, status, metadata_json,
              workflow_id, task_id, created_at, read_at, dismissed_at
       FROM notifications
       WHERE user_id = ? AND status = 'unread'
       ORDER BY created_at DESC
       LIMIT 20`,
    ).all(userId) as Array<{
      id: string;
      user_id: string;
      type: string;
      title: string;
      body: string;
      priority: string;
      status: string;
      metadata_json: string;
      workflow_id: string | null;
      task_id: string | null;
      created_at: number;
      read_at: number | null;
      dismissed_at: number | null;
    }>;

    for (const row of rows) {
      const notification = {
        id: row.id,
        user_id: row.user_id,
        type: row.type,
        title: row.title,
        body: row.body,
        priority: row.priority,
        status: row.status,
        metadata: safeJsonParse(row.metadata_json),
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        created_at: row.created_at,
        read_at: row.read_at,
        dismissed_at: row.dismissed_at,
      };
      sendSseEvent(res, 'notification', notification);
    }
  } finally {
    db.close();
  }

  // Subscribe to new notifications
  const unsubscribe = eventBroker.subscribeNotifications(userId, (ev) => {
    sendSseEvent(res, 'notification', ev);
  });

  wireSseLifecycle(req, res, () => {
    unsubscribe();
    safeEndSse(res);
  });
}

interface StreamLlmBody {
  prompt?: string;
  system_prompt?: string;
  model?: string;
  idle_timeout_ms?: number;
  actor_token?: string;
  temperature?: number;
}

function validateStreamRequest(body: StreamLlmBody, res: ServerResponse): ActorAuth | null {
  if (typeof body.prompt !== 'string' || typeof body.system_prompt !== 'string' || typeof body.model !== 'string') {
    badRequest(res, 'prompt, system_prompt and model are required strings');
    return null;
  }
  const actor = requireActorToken(body.actor_token);
  if (!actor) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'actor_token required and must be valid' }));
    return null;
  }
  const inFlight = llmStreamsByActor.get(actor.actor_token) ?? 0;
  const maxConcurrentStreams = getMaxLlmStreamsPerActor();
  if (inFlight >= maxConcurrentStreams) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rate_limited', max_concurrent: maxConcurrentStreams }));
    return null;
  }
  llmStreamsByActor.set(actor.actor_token, inFlight + 1);
  return actor;
}

function releaseStreamSlot(actor: ActorAuth): void {
  const remaining = (llmStreamsByActor.get(actor.actor_token) ?? 1) - 1;
  if (remaining <= 0) llmStreamsByActor.delete(actor.actor_token);
  else llmStreamsByActor.set(actor.actor_token, remaining);
}

async function handleStreamLlm(body: StreamLlmBody, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const actor = validateStreamRequest(body, res);
  if (!actor) return;

  setSseHeaders(res);
  const startedAt = Date.now();
  const ctrl = new AbortController();
  let totalChars = 0;
  let totalChunks = 0;
  let lastUsage: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number } | null = null;

  const onClientClose = (): void => { try { ctrl.abort(); } catch { /* ignore */ } };
  req.on('close', onClientClose); req.on('error', onClientClose);
  res.on('close', onClientClose); res.on('error', onClientClose);

  try {
    const stream = callOmnirouteStream({
      systemPrompt: body.system_prompt!, userPrompt: body.prompt!, model: body.model!,
      temperature: body.temperature, signal: ctrl.signal,
      idleTimeoutMs: body.idle_timeout_ms,
      onUsage: (u) => { lastUsage = u; },
    });

    for await (const chunk of stream) {
      totalChunks++;
      totalChars += chunk.length;
      sendSseEvent(res, 'chunk', { text: chunk, seq: totalChunks });
      if (ctrl.signal.aborted || res.writableEnded) break;
    }

    sendSseEvent(res, 'done', {
      total_chunks: totalChunks, total_chars: totalChars,
      duration_ms: Date.now() - startedAt, usage: lastUsage,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof Error ? err.name : 'StreamError';
    sendSseEvent(res, 'error', { code, message: msg });
  } finally {
    req.off('close', onClientClose); req.off('error', onClientClose);
    res.off('close', onClientClose); res.off('error', onClientClose);
    releaseStreamSlot(actor);
    safeEndSse(res);
  }
}

export const sseRouter: Router = async (req, url, res, _ctx) => {
  const wfMatch = url.pathname.match(/^\/events\/workflow\/([^/]+)$/);
  if (req.method === 'GET' && wfMatch) {
    handleWorkflowEventsSse(decodeURIComponent(wfMatch[1] ?? ''), url, req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/events/gates') {
    handleGateEventsSse(url, req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/events/notifications') {
    handleNotificationEventsSse(url, req, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/stream/llm') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    await handleStreamLlm(body as StreamLlmBody, req, res);
    return true;
  }
  return false;
};
