import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { handleTelegramWebhook } from '../../src/hitl/telegram-webhook.js';
import { answerTelegramCallback } from '../../src/hitl/telegram.js';

// Mock the dependencies
vi.mock('../../src/hitl/telegram.js', () => ({
  answerTelegramCallback: vi.fn(),
  parseTelegramCallbackData: vi.fn(),
}));

vi.mock('../../src/db/persist.js', () => ({
  insertEvent: vi.fn(),
  resolveHitlGate: vi.fn(),
}));

describe('handleTelegramWebhook', () => {
  let mockDb: Database.Database;
  let mockRes: Partial<ServerResponse>;
  let mockWriteHead: ReturnType<typeof vi.fn>;
  let mockEnd: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock database
    mockDb = {
      prepare: vi.fn().mockReturnThis(),
      get: vi.fn(),
    } as unknown as Database.Database;

    // Mock response
    mockWriteHead = vi.fn();
    mockEnd = vi.fn();
    mockRes = {
      writeHead: mockWriteHead,
      end: mockEnd,
    };

    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('rejects invalid JSON body', async () => {
    await handleTelegramWebhook(mockDb, 'invalid json', mockRes as ServerResponse, 'bot-token');

    expect(mockWriteHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON body'));
  });

  it('rejects non-callback query updates', async () => {
    await handleTelegramWebhook(mockDb, JSON.stringify({ message: { text: 'hello' } }), mockRes as ServerResponse, 'bot-token');

    expect(mockWriteHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('not_a_callback_query'));
  });

  it('rejects callback query with invalid structure', async () => {
    await handleTelegramWebhook(mockDb, JSON.stringify({ callback_query: { id: 123 } }), mockRes as ServerResponse, 'bot-token');

    expect(mockWriteHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('Invalid callback query structure'));
  });

  it('handles successful gate resolution', async () => {
    const { parseTelegramCallbackData } = await import('../../src/hitl/telegram.js');
    const { resolveHitlGate, insertEvent } = await import('../../src/db/persist.js');

    vi.mocked(parseTelegramCallbackData).mockReturnValue({ gate_id: 'hg_abc', decision: 'approve' });
    vi.mocked(resolveHitlGate).mockReturnValue({ workflow_id: 'wf_123', task_id: 'tk_456', id: 'hg_abc' });
    vi.mocked(answerTelegramCallback).mockResolvedValue(undefined);

    (mockDb.prepare as any).mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 'hg_abc',
        workflow_id: 'wf_123',
        task_id: 'tk_456',
        status: 'pending',
      }),
    });

    await handleTelegramWebhook(mockDb, JSON.stringify({ callback_query: { id: 'cb_123', data: 'omniforge:hitl:hg_abc:approve' } }), mockRes as ServerResponse, 'bot-token');

    expect(mockWriteHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('"handled":true'));
    expect(resolveHitlGate).toHaveBeenCalledWith(mockDb, 'hg_abc', 'approved');
    expect(insertEvent).toHaveBeenCalled();
    expect(answerTelegramCallback).toHaveBeenCalledWith('bot-token', 'cb_123', 'approve');
  });

  it('returns 404 for non-existent gate', async () => {
    const { parseTelegramCallbackData } = await import('../../src/hitl/telegram.js');

    vi.mocked(parseTelegramCallbackData).mockReturnValue({ gate_id: 'hg_nonexistent', decision: 'approve' });

    (mockDb.prepare as any).mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
    });

    await handleTelegramWebhook(mockDb, JSON.stringify({ callback_query: { id: 'cb_123', data: 'omniforge:hitl:hg_nonexistent:approve' } }), mockRes as ServerResponse, 'bot-token');

    expect(mockWriteHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
    expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('Gate not found'));
  });

  it('handles already resolved gates gracefully', async () => {
    const { parseTelegramCallbackData } = await import('../../src/hitl/telegram.js');

    vi.mocked(parseTelegramCallbackData).mockReturnValue({ gate_id: 'hg_abc', decision: 'approve' });
    vi.mocked(answerTelegramCallback).mockResolvedValue(undefined);

    (mockDb.prepare as any).mockReturnValue({
      get: vi.fn().mockReturnValue({
        id: 'hg_abc',
        workflow_id: 'wf_123',
        task_id: 'tk_456',
        status: 'approved',
      }),
    });

    await handleTelegramWebhook(mockDb, JSON.stringify({ callback_query: { id: 'cb_123', data: 'omniforge:hitl:hg_abc:approve' } }), mockRes as ServerResponse, 'bot-token');

    expect(mockWriteHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('"already_resolved":true'));
    expect(answerTelegramCallback).toHaveBeenCalled();
  });

  it('handles parse errors gracefully', async () => {
    const { parseTelegramCallbackData } = await import('../../src/hitl/telegram.js');

    vi.mocked(parseTelegramCallbackData).mockImplementation(() => {
      throw new Error('Invalid callback data');
    });
    vi.mocked(answerTelegramCallback).mockResolvedValue(undefined);

    await handleTelegramWebhook(mockDb, JSON.stringify({ callback_query: { id: 'cb_123', data: 'invalid' } }), mockRes as ServerResponse, 'bot-token');

    expect(mockWriteHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
    expect(mockEnd).toHaveBeenCalledWith(expect.stringContaining('Invalid callback data'));
  });
});