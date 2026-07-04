import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { insertEvent, resolveHitlGate } from '../db/persist.js';
import { parseTelegramCallbackData, answerTelegramCallback, type TelegramGateDecision } from './telegram.js';

/**
 * Handle Telegram webhook update for inline keyboard button callbacks.
 * This endpoint is called by Telegram when a user clicks a button on a HITL gate notification.
 */
export async function handleTelegramWebhook(
  db: Database.Database,
  body: string,
  res: ServerResponse,
  botToken: string
): Promise<void> {
  let update: Record<string, unknown>;
  try {
    update = JSON.parse(body) as Record<string, unknown>;
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  const callbackQuery = update.callback_query;
  if (!callbackQuery || typeof callbackQuery !== 'object') {
    // Not a callback query - might be a regular message, which we don't handle
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handled: false, reason: 'not_a_callback_query' }));
    return;
  }

  const callbackId = (callbackQuery as { id?: unknown }).id;
  const data = (callbackQuery as { data?: unknown }).data;

  if (typeof callbackId !== 'string' || typeof data !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid callback query structure' }));
    return;
  }

  try {
    const parsed = parseTelegramCallbackData(data);
    if (!parsed.gate_id) {
      throw new Error('Telegram callback missing gate id');
    }

    // Check if gate exists and is pending
    const gate = db
      .prepare('SELECT id, workflow_id, task_id, status FROM hitl_gates WHERE id = ?')
      .get(parsed.gate_id) as { id: string; workflow_id: string; task_id: string | null; status: string } | undefined;

    if (!gate) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gate not found', gate_id: parsed.gate_id }));
      return;
    }

    if (gate.status !== 'pending') {
      // Gate already resolved - just answer the callback
      await answerTelegramCallback(botToken, callbackId, parsed.decision);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ handled: true, already_resolved: true, gate_id: parsed.gate_id }));
      return;
    }

    // Resolve the gate
    const decision = parsed.decision === 'approve' ? 'approved' : parsed.decision === 'reject' ? 'rejected' : 'modify';
    resolveHitlGate(db, parsed.gate_id, decision);

    // Log the event
    insertEvent(db, {
      workflow_id: gate.workflow_id,
      task_id: gate.task_id,
      type: 'hitl_gate_resolved',
      payload: {
        gate_id: parsed.gate_id,
        decision: parsed.decision,
        source: 'telegram_webhook',
        callback_query_id: callbackId,
      },
    });

    // Answer the callback to show feedback to user
    await answerTelegramCallback(botToken, callbackId, parsed.decision);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ handled: true, gate_id: parsed.gate_id, decision: parsed.decision }));
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[Telegram Webhook] Error handling callback: ${errorMessage}`);

    // Try to answer the callback with error message
    try {
      const callbackId = (callbackQuery as { id?: unknown }).id as string;
      await answerTelegramCallback(botToken, callbackId, 'approve'); // Default to approve on error
    } catch {
      // Ignore answer errors
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: errorMessage }));
  }
}

/**
 * Wrapper to read the request body and call handleTelegramWebhook.
 * This is the actual HTTP handler used by the router.
 */
export async function handleTelegramWebhookRequest(
  db: Database.Database,
  req: IncomingMessage,
  res: ServerResponse,
  botToken: string
): Promise<void> {
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString();
  }
  await handleTelegramWebhook(db, body, res, botToken);
}