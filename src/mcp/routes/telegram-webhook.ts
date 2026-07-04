import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDbPath, telegramBotToken, telegramWebhookSecret } from '../../utils/config.js';
import { initDb } from '../../db/client.js';
import { handleTelegramWebhookRequest } from '../../hitl/telegram-webhook.js';
import { constantTimeCompare } from '../../utils/timing-safe-compare.js';
import type { RouteContext, Router } from './types.js';

/**
 * Telegram webhook router - handles inline keyboard button callbacks from Telegram.
 * This is a pre-auth router (no Bearer token required) because the webhook secret
 * in the URL path serves as authentication.
 */
export const telegramWebhookRouter: Router = async (req: IncomingMessage, url: URL, res: ServerResponse, ctx: RouteContext) => {
  // Match /telegram/webhook/:secret
  if (req.method === 'POST' && url.pathname.startsWith('/telegram/webhook/')) {
    const secret = url.pathname.split('/').pop();
    const expectedSecret = telegramWebhookSecret();

    // Validate webhook secret using constant-time comparison to prevent timing-oracle
    // brute-force attacks. We must NOT short-circuit on missing/empty secret because
    // that would leak information via timing. Always invoke constantTimeCompare
    // against expectedSecret (falling back to a sentinel so the call is always made),
    // and only admit when expectedSecret is actually configured.
    const incoming = typeof secret === 'string' ? secret : '';
    const configured = typeof expectedSecret === 'string' && expectedSecret.length > 0;
    const sentinel = configured ? expectedSecret : 'sentinel-no-secret-configured';
    const secretMatch = constantTimeCompare(incoming, sentinel) && configured;

    if (!secretMatch) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid webhook secret' }));
      return true;
    }

    const botToken = telegramBotToken();
    if (!botToken) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN not configured' }));
      return true;
    }

    const db = initDb(getDbPath());
    try {
      await handleTelegramWebhookRequest(db, req, res, botToken);
    } finally {
      db.close();
    }
    return true;
  }

  return false;
};