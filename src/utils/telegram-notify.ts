// Bloco 5.4 — fire-and-forget Telegram push notification.
// Used by MCP run_workflow to push progress updates during execution.
// Non-fatal: all errors are silently swallowed so the workflow is never blocked.
let warnedMissing = false;
export async function notifyTelegram(text: string): Promise<{ sent: boolean; error?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // Use TELEGRAM_CHAT_ID — same var as HITL flow (consistent with .env). The
  // previous TELEGRAM_HOME_CHANNEL name was undefined in .env, so progress
  // notifications were silently dead since Bloco 5.4 landed.
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    if (!warnedMissing && !process.env.TELEGRAM_NOTIFY_SILENT) {
      warnedMissing = true;
      process.stderr.write('[notifyTelegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing — notifications disabled\n');
    }
    return { sent: false, error: 'credentials_missing' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { sent: false, error: `http_${res.status}:${body.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
