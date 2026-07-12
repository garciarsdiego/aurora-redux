// Sprint 4.6 (D-H2.066): triggers (schedules + webhooks) + public webhook receive.
//
// `POST /webhooks/:slug` is PUBLIC (HMAC-signed, must be reachable for
// external callers like GitHub/Slack/Zapier). All other endpoints under
// /api/dashboard/triggers/* are POST-AUTH.
//
// Schedule tick endpoint has Sprint 3.2 rate-limit (10/min/source IP).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import {
  createDashboardSchedule,
  createDashboardWebhook,
  insertDashboardWebhookInvocation,
  listDashboardTriggers,
  loadDashboardWebhookBySlug,
  rotateDashboardWebhookSecret,
  setDashboardScheduleActive,
  setDashboardWebhookActive,
  updateDashboardWebhookInvocationWorkflow,
  verifyDashboardWebhookRequest,
} from '../dashboard-triggers.js';
import type { Router } from './types.js';
import { badRequest, jsonOk, readBodyOr400, readRawBody, unauthorized } from './_shared.js';
import { runDashboardTriggerTarget } from './_dashboard-dag-helpers.js';
import { runDashboardScheduleTickOnce } from './_schedule-tick.js';
import {
  emitTriggerFireRecordedEvent,
  markTriggerFireDispatched,
  markTriggerFireError,
  recordTriggerFire,
} from './_trigger-orphan-retry.js';
import { createRateLimiter } from '../_rate-limit.js';
import { insertEvent } from '../../db/persist.js';

// Sprint 3.2 (D-H2.066, F-SEC-3): rate-limit /tick endpoint.
const SCHEDULE_TICK_WINDOW_MS = 60_000;
const SCHEDULE_TICK_MAX_PER_WINDOW = 10;
export const scheduleTickHistory = new Map<string, number[]>();

// M1 / Wave 1-E (A8): rate-limit public webhook ingress. The webhook handler
// is PRE-AUTH (HMAC is the auth) so a flood of bad-signature requests still
// exercises the daemon for each call. Without this limiter, an attacker who
// learns a slug can flood the daemon with O(rpm) requests/min → workflow
// pressure even if every signature gets rejected (HMAC verification is the
// gate, but it still allocates the DB connection + decryption work).
//
// Default 10 rpm per slug is generous for a single-operator dogfood: real
// upstreams (Stripe/GitHub/Zapier) fire well below this. Override via
// `WEBHOOK_RATE_LIMIT_RPM` if the operator wires a high-volume integration.
const WEBHOOK_RATE_LIMIT_RPM = Number(process.env.WEBHOOK_RATE_LIMIT_RPM ?? '10');
const webhookLimiter = createRateLimiter({ rpm: WEBHOOK_RATE_LIMIT_RPM });

function scheduleTickRateLimitKey(req: IncomingMessage): string {
  const xfwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  return xfwd || req.socket.remoteAddress || 'unknown';
}

function consumeScheduleTickRate(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
  const recent = (scheduleTickHistory.get(key) ?? []).filter((t) => now - t < SCHEDULE_TICK_WINDOW_MS);
  if (recent.length >= SCHEDULE_TICK_MAX_PER_WINDOW) {
    const oldest = recent[0] ?? now;
    return { allowed: false, retryAfterMs: SCHEDULE_TICK_WINDOW_MS - (now - oldest) };
  }
  recent.push(now);
  scheduleTickHistory.set(key, recent);
  return { allowed: true, retryAfterMs: 0 };
}

function handleDashboardTriggersList(res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, listDashboardTriggers(db)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardScheduleCreate(body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, { schedule: createDashboardSchedule(db, body) }, 201); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardSchedulePatch(id: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, { schedule: setDashboardScheduleActive(db, id, body) }); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

async function handleDashboardScheduleTick(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const key = scheduleTickRateLimitKey(req);
  const decision = consumeScheduleTickRate(key);
  if (!decision.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)),
    });
    res.end(JSON.stringify({
      error: 'rate_limited',
      detail: `schedule tick is capped at ${SCHEDULE_TICK_MAX_PER_WINDOW} per ${SCHEDULE_TICK_WINDOW_MS / 1000}s per source`,
      retry_after_ms: decision.retryAfterMs,
    }));
    return;
  }
  try { jsonOk(res, await runDashboardScheduleTickOnce()); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
}

function handleDashboardWebhookCreate(body: unknown, token: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, createDashboardWebhook(db, body, token), 201); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardWebhookPatch(id: string, body: unknown, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, { webhook: setDashboardWebhookActive(db, id, body) }); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

function handleDashboardWebhookRotate(id: string, token: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try { jsonOk(res, rotateDashboardWebhookSecret(db, id, token)); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); }
  finally { db.close(); }
}

async function handleDashboardWebhookReceive(
  slug: string,
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
): Promise<void> {
  // M1 / Wave 1-E (A8): rate-limit BEFORE reading body / opening DB. A flood
  // of requests on the same slug must not allocate buffers or DB connections
  // — the limiter check is O(1) and runs before any work.
  const decision = webhookLimiter(slug);
  if (!decision.allowed) {
    const retryAfterMs = decision.retryAfterMs ?? 60_000;
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(retryAfterMs / 1000)),
    });
    // Observability: emit an event so the operator sees the rate-limit hit
    // in the dashboard timeline. Best-effort — must not throw out of the
    // handler if the DB is briefly unavailable.
    try {
      const db = initDb(getDbPath());
      try {
        insertEvent(db, {
          workflow_id: '_daemon',
          type: 'webhook_rate_limited',
          payload: { slug, retry_after_ms: retryAfterMs, rpm_limit: WEBHOOK_RATE_LIMIT_RPM },
        });
      } finally {
        db.close();
      }
    } catch (eventErr) {
      // Event emission is best-effort; never block the 429 response.
      process.stderr.write(
        `[daemon] webhook_rate_limited event emit failed: ${eventErr instanceof Error ? eventErr.message : String(eventErr)}\n`,
      );
    }
    res.end(JSON.stringify({
      error: 'rate_limited',
      detail: `webhook ingress is capped at ${WEBHOOK_RATE_LIMIT_RPM} per minute per slug`,
      retry_after_ms: retryAfterMs,
    }));
    return;
  }

  let rawBody = '';
  try { rawBody = await readRawBody(req); }
  catch (err) { badRequest(res, err instanceof Error ? err.message : String(err)); return; }

  const sourceIp = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
    ?? req.socket.remoteAddress
    ?? null;
  const timestamp = (req.headers['x-maestro-timestamp'] as string | undefined) ?? '';
  const signature = (req.headers['x-maestro-signature'] as string | undefined) ?? '';
  const db = initDb(getDbPath());
  try {
    const webhook = loadDashboardWebhookBySlug(db, slug);
    if (!webhook) {
      insertDashboardWebhookInvocation(db, {
        slug, signature_valid: false, status: 'rejected',
        source_ip: sourceIp, error_message: 'webhook not found', raw_body: rawBody,
      });
      unauthorized(res);
      return;
    }
    const verification = verifyDashboardWebhookRequest({ webhook, keyMaterial: token, timestamp, signature, rawBody });
    if (!verification.ok) {
      insertDashboardWebhookInvocation(db, {
        webhook_id: webhook.id, slug, signature_valid: false, status: 'rejected',
        source_ip: sourceIp, error_message: verification.reason, raw_body: rawBody,
      });
      unauthorized(res);
      return;
    }
    const invocation = insertDashboardWebhookInvocation(db, {
      webhook_id: webhook.id, slug, signature_valid: true, status: 'accepted',
      source_ip: sourceIp, raw_body: rawBody,
    });

    // Tier 0 / Wave 4 / 0.4 (F-REL-2): outbox row BEFORE dispatch so a
    // daemon crash mid-dispatch is recoverable on next start.
    const triggerFire = recordTriggerFire(db, {
      trigger_source: 'webhook',
      webhook_id: webhook.id,
      invocation_id: invocation.id,
      workspace: webhook.workspace,
      target_kind: webhook.target_kind,
      target_ref: webhook.target_ref,
      input_payload_json: webhook.input_payload_json,
      live_payload: rawBody,
    });

    try {
      const result = await runDashboardTriggerTarget({
        workspace: webhook.workspace,
        target_kind: webhook.target_kind,
        target_ref: webhook.target_ref,
        input_payload: JSON.parse(webhook.input_payload_json) as unknown,
        live_payload: rawBody,
      });
      const workflowId = typeof result['workflow_id'] === 'string' ? result['workflow_id'] : null;
      updateDashboardWebhookInvocationWorkflow(db, invocation.id, workflowId, 'accepted');
      if (workflowId) {
        markTriggerFireDispatched(db, triggerFire.id, workflowId);
        emitTriggerFireRecordedEvent(db, triggerFire.id, workflowId, {
          source: 'webhook',
          webhook_id: webhook.id,
          invocation_id: invocation.id,
          fired_at: triggerFire.fired_at,
        });
      } else {
        markTriggerFireError(db, triggerFire.id, 'dispatch returned no workflow_id');
      }
      jsonOk(res, { invocation_id: invocation.id, workflow_id: workflowId, trigger_fire_id: triggerFire.id }, 202);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateDashboardWebhookInvocationWorkflow(db, invocation.id, null, 'error', message);
      markTriggerFireError(db, triggerFire.id, message);
      jsonOk(res, { invocation_id: invocation.id, error: message, trigger_fire_id: triggerFire.id }, 202);
    }
  } catch (err) {
    badRequest(res, err instanceof Error ? err.message : String(err));
  } finally {
    db.close();
  }
}

// Public webhook router (PRE-AUTH, since signature is the auth).
export const publicWebhookRouter: Router = async (req, url, res, ctx) => {
  const match = url.pathname.match(/^\/webhooks\/([^/]+)$/);
  if (req.method === 'POST' && match) {
    await handleDashboardWebhookReceive(decodeURIComponent(match[1] ?? ''), req, res, ctx.token);
    return true;
  }
  return false;
};

// Triggers admin router (POST-AUTH).
export const dashboardTriggersHttpRouter: Router = async (req, url, res, ctx) => {
  if (req.method === 'GET' && url.pathname === '/api/dashboard/triggers') {
    handleDashboardTriggersList(res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/triggers/schedules') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardScheduleCreate(body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/triggers/schedules/tick') {
    await handleDashboardScheduleTick(req, res);
    return true;
  }
  const schedMatch = url.pathname.match(/^\/api\/dashboard\/triggers\/schedules\/([^/]+)$/);
  if (req.method === 'PATCH' && schedMatch) {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardSchedulePatch(decodeURIComponent(schedMatch[1] ?? ''), body, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/dashboard/triggers/webhooks') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardWebhookCreate(body, ctx.token, res);
    return true;
  }
  const whRotateMatch = url.pathname.match(/^\/api\/dashboard\/triggers\/webhooks\/([^/]+)\/rotate-secret$/);
  if (req.method === 'POST' && whRotateMatch) {
    handleDashboardWebhookRotate(decodeURIComponent(whRotateMatch[1] ?? ''), ctx.token, res);
    return true;
  }
  const whMatch = url.pathname.match(/^\/api\/dashboard\/triggers\/webhooks\/([^/]+)$/);
  if (req.method === 'PATCH' && whMatch) {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleDashboardWebhookPatch(decodeURIComponent(whMatch[1] ?? ''), body, res);
    return true;
  }
  return false;
};

// Re-export for tests / health checks.
export { SCHEDULE_TICK_MAX_PER_WINDOW, SCHEDULE_TICK_WINDOW_MS, WEBHOOK_RATE_LIMIT_RPM };

// Test-only: expose the limiter so an integration test can drain it fast.
export const __testing_webhookLimiter = webhookLimiter;
