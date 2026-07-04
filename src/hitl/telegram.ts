export type TelegramGateDecision = 'approve' | 'reject' | 'modify';

export interface TelegramGateOpts {
  botToken: string;
  chatId: string | number;
  taskName: string;
  workspace: string;
  kind: string;
  model: string | null;
  objective: string;
  gateId: string;
}

export interface TelegramGateCallback {
  gate_id: string;
  decision: TelegramGateDecision;
}

/**
 * Generate callback data for Telegram inline keyboard buttons.
 * Format: omniforge:hitl:{gateId}:{decision}
 */
export function telegramCallbackData(gateId: string, decision: TelegramGateDecision): string {
  return `omniforge:hitl:${gateId}:${decision}`;
}

/**
 * Parse callback data from Telegram inline keyboard button.
 */
export function parseTelegramCallbackData(data: string): TelegramGateCallback {
  const parts = data.split(':');
  if (parts[0] !== 'omniforge') {
    throw new Error('Callback data is not an Omniforge callback');
  }

  // New format: omniforge:hitl:{gateId}:{decision}
  if (parts.length === 4 && parts[1] === 'hitl') {
    const decision = parseDecision(parts[3]);
    return { gate_id: parts[2] ?? '', decision };
  }

  // Backward compatibility with old button shapes:
  //   omniforge:{gateId}:approve
  //   omniforge:approve:{gateId}
  if (parts.length === 3) {
    if (isDecision(parts[2])) return { gate_id: parts[1] ?? '', decision: parts[2] };
    if (isDecision(parts[1])) return { gate_id: parts[2] ?? '', decision: parts[1] };
  }

  throw new Error('Unsupported Omniforge callback format');
}

function parseDecision(value: string | undefined): TelegramGateDecision {
  if (value === 'approve' || value === 'reject' || value === 'modify') return value;
  throw new Error('Unsupported HITL decision in callback data');
}

function isDecision(value: string | undefined): value is TelegramGateDecision {
  return value === 'approve' || value === 'reject' || value === 'modify';
}

/**
 * Send HITL gate notification to Telegram with inline keyboard buttons.
 */
export async function sendTelegramGateNotification(opts: TelegramGateOpts): Promise<{ sent: boolean; error?: string }> {
  const { botToken, chatId, taskName, workspace, kind, model, objective, gateId } = opts;

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Improved message formatting with emoji and better structure
  const text =
    `🛑 <b>HITL Gate — Aprovação Necessária</b>\n\n` +
    `<b>Task:</b> ${esc(taskName)}\n` +
    `<b>Kind:</b> ${esc(kind)}\n` +
    `<b>Model:</b> ${esc(model ?? '(default)')}\n` +
    `<b>Workspace:</b> ${esc(workspace)}\n\n` +
    `<b>Objective:</b>\n${esc(objective || '(sem objetivo)')}\n\n` +
    `<code>${esc(gateId)}</code>`;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000); // Increased timeout to 10s

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Aprovar', callback_data: telegramCallbackData(gateId, 'approve') },
              { text: '❌ Rejeitar', callback_data: telegramCallbackData(gateId, 'reject') }
            ],
            [
              { text: '✏️ Modificar', callback_data: telegramCallbackData(gateId, 'modify') }
            ]
          ]
        }
      }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = `Telegram API returned ${res.status}: ${body}`;
      console.warn(`[HITL] ${error} — falling back to terminal prompt`);
      return { sent: false, error };
    }
    return { sent: true };
  } catch (err) {
    const error = `Telegram failed: ${(err as Error).message}`;
    console.warn(`[HITL] ${error} — falling back to terminal prompt`);
    return { sent: false, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answer Telegram callback query to show feedback to user.
 */
export async function answerTelegramCallback(
  botToken: string,
  callbackQueryId: string,
  decision: TelegramGateDecision
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
  const text =
    decision === 'approve' ? '✅ Gate aprovado' :
    decision === 'reject' ? '❌ Gate rejeitado' :
    '✏️ Modificação solicitada';

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      }),
    });
  } catch (err) {
    console.warn(`[HITL] Failed to answer Telegram callback: ${(err as Error).message}`);
  }
}
