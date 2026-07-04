import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callOmniroute, callOmnirouteWithUsage } from '../../src/utils/omniroute-call.js';

describe('callOmniroute', () => {
  const envKeys = ['OMNIROUTE_URL', 'OMNIROUTE_API_KEY', 'OMNIROUTE_TIMEOUT_MS', 'OMNIROUTE_MAX_RETRIES'] as const;
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of envKeys) originalEnv.set(key, process.env[key]);
    process.env.OMNIROUTE_URL = 'http://omniroute.test';
    process.env.OMNIROUTE_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('passes an AbortSignal to fetch so non-stream calls have a deadline', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callOmniroute({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'cc/claude-sonnet-4-6',
    });

    expect(result).toBe('ok');
    expect(mockFetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      signal: expect.any(AbortSignal),
    });
  });

  it('retries transient fetch failures up to OMNIROUTE_MAX_RETRIES', async () => {
    process.env.OMNIROUTE_MAX_RETRIES = '1';
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const result = await callOmniroute({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'cc/claude-sonnet-4-6',
    });

    expect(result).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('surfaces an actionable message when Omniroute is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(callOmniroute({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'cc/claude-sonnet-4-6',
    })).rejects.toThrow(
      'Omniroute request failed for http://omniroute.test/api/v1/chat/completions: fetch failed',
    );
  });

  it('attaches status + responseHeaders to a non-OK HTTP error so the classifier can honour Retry-After', async () => {
    process.env.OMNIROUTE_MAX_RETRIES = '0';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
      text: async () => '{"error":"rate limited"}',
    }));

    const err = await callOmniroute({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'cc/claude-sonnet-4-6',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('Omniroute HTTP 429');
    expect((err as Error & { status?: number }).status).toBe(429);
    expect(
      (err as Error & { responseHeaders?: Record<string, string> }).responseHeaders?.['retry-after'],
    ).toBe('30');
  });

  it('callOmnirouteWithUsage returns normalized usage and model_used metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        model: 'cc/claude-sonnet-4-6',
        choices: [{ message: { content: 'with usage' } }],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7,
          total_cost_usd: 0.0123,
        },
      }),
    }));

    const result = await callOmnirouteWithUsage({
      systemPrompt: 'system',
      userPrompt: 'user',
      model: 'cc/claude-sonnet-4-6',
    });

    expect(result).toEqual({
      content: 'with usage',
      model_used: 'cc/claude-sonnet-4-6',
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_cost_usd: 0.0123,
      },
    });
  });
});
