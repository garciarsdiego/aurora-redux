import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendTelegramGateNotification,
  telegramCallbackData,
  parseTelegramCallbackData,
  answerTelegramCallback,
  type TelegramGateDecision,
} from '../../src/hitl/telegram.js';

describe('sendTelegramGateNotification', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to correct Telegram API URL with bot token', async () => {
    await sendTelegramGateNotification({
      botToken: 'test-token-123',
      chatId: 5824770981,
      taskName: 'Deploy API',
      workspace: 'internal',
      kind: 'llm_call',
      model: 'cc/claude-opus-4-7',
      objective: 'Release v2',
      gateId: 'hg_abc',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bottest-token-123/sendMessage');
  });

  it('payload contains chat_id, parse_mode HTML, inline keyboard, and task details', async () => {
    const result = await sendTelegramGateNotification({
      botToken: 'tok',
      chatId: '123456',
      taskName: 'Build Docker Image',
      workspace: 'globex',
      kind: 'cli_spawn',
      model: null,
      objective: 'Build and push',
      gateId: 'hg_xyz',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(result.sent).toBe(true);
    expect(body.chat_id).toBe('123456');
    expect(body.parse_mode).toBe('HTML');
    const text = body.text as string;
    expect(text).toContain('🛑');
    expect(text).toContain('Build Docker Image');
    expect(text).toContain('cli_spawn');
    expect(text).toContain('(default)');
    expect(text).toContain('globex');
    expect(text).toContain('Build and push');
    expect(text).toContain('hg_xyz');

    // Check inline keyboard
    const replyMarkup = body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(replyMarkup).toBeDefined();
    expect(replyMarkup.inline_keyboard).toHaveLength(2);
    expect(replyMarkup.inline_keyboard[0]).toHaveLength(2);
    expect(replyMarkup.inline_keyboard[1]).toHaveLength(1);

    // Check button labels
    expect(replyMarkup.inline_keyboard[0][0].text).toBe('✅ Aprovar');
    expect(replyMarkup.inline_keyboard[0][1].text).toBe('❌ Rejeitar');
    expect(replyMarkup.inline_keyboard[1][0].text).toBe('✏️ Modificar');
  });

  it('non-ok response returns sent: false with error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' });
    const result = await sendTelegramGateNotification({
      botToken: 't', chatId: 1, taskName: 'T', workspace: 'w',
      kind: 'llm_call', model: null, objective: '', gateId: 'hg_x',
    });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('400');
  });

  it('network error returns sent: false with error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await sendTelegramGateNotification({
      botToken: 't', chatId: 1, taskName: 'T', workspace: 'w',
      kind: 'llm_call', model: null, objective: '', gateId: 'hg_x',
    });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('timeout abort returns sent: false with error', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );
    const result = await sendTelegramGateNotification({
      botToken: 't', chatId: 1, taskName: 'T', workspace: 'w',
      kind: 'llm_call', model: null, objective: '', gateId: 'hg_x',
    });
    expect(result.sent).toBe(false);
    expect(result.error).toContain('aborted');
  });
});

describe('telegramCallbackData', () => {
  it('generates correct callback data format', () => {
    const data = telegramCallbackData('hg_abc', 'approve');
    expect(data).toBe('omniforge:hitl:hg_abc:approve');
  });

  it('generates callback data for reject', () => {
    const data = telegramCallbackData('hg_xyz', 'reject');
    expect(data).toBe('omniforge:hitl:hg_xyz:reject');
  });

  it('generates callback data for modify', () => {
    const data = telegramCallbackData('hg_123', 'modify');
    expect(data).toBe('omniforge:hitl:hg_123:modify');
  });
});

describe('parseTelegramCallbackData', () => {
  it('parses new format callback data', () => {
    const parsed = parseTelegramCallbackData('omniforge:hitl:hg_abc:approve');
    expect(parsed.gate_id).toBe('hg_abc');
    expect(parsed.decision).toBe('approve');
  });

  it('parses reject decision', () => {
    const parsed = parseTelegramCallbackData('omniforge:hitl:hg_xyz:reject');
    expect(parsed.gate_id).toBe('hg_xyz');
    expect(parsed.decision).toBe('reject');
  });

  it('parses modify decision', () => {
    const parsed = parseTelegramCallbackData('omniforge:hitl:hg_123:modify');
    expect(parsed.gate_id).toBe('hg_123');
    expect(parsed.decision).toBe('modify');
  });

  it('parses backward compatible format omniforge:gateId:decision', () => {
    const parsed = parseTelegramCallbackData('omniforge:hg_abc:approve');
    expect(parsed.gate_id).toBe('hg_abc');
    expect(parsed.decision).toBe('approve');
  });

  it('parses backward compatible format omniforge:decision:gateId', () => {
    const parsed = parseTelegramCallbackData('omniforge:approve:hg_abc');
    expect(parsed.gate_id).toBe('hg_abc');
    expect(parsed.decision).toBe('approve');
  });

  it('throws error for non-omniforge callback', () => {
    expect(() => parseTelegramCallbackData('other:hitl:hg_abc:approve')).toThrow('not an Omniforge callback');
  });

  it('throws error for unsupported format', () => {
    expect(() => parseTelegramCallbackData('omniforge:invalid')).toThrow('Unsupported Omniforge callback format');
  });

  it('throws error for invalid decision', () => {
    expect(() => parseTelegramCallbackData('omniforge:hitl:hg_abc:invalid')).toThrow('Unsupported HITL decision');
  });
});

describe('answerTelegramCallback', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends answer callback for approve decision', async () => {
    await answerTelegramCallback('bot-token', 'callback-123', 'approve');
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot-token/answerCallbackQuery');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.callback_query_id).toBe('callback-123');
    expect(body.text).toBe('✅ Gate aprovado');
    expect(body.show_alert).toBe(false);
  });

  it('sends answer callback for reject decision', async () => {
    await answerTelegramCallback('bot-token', 'callback-123', 'reject');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe('❌ Gate rejeitado');
  });

  it('sends answer callback for modify decision', async () => {
    await answerTelegramCallback('bot-token', 'callback-123', 'modify');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toBe('✏️ Modificação solicitada');
  });

  it('handles errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    await expect(answerTelegramCallback('bot-token', 'callback-123', 'approve')).resolves.toBeUndefined();
  });
});
