/**
 * Tests for the Anthropic prompt-prefix cache wire (B6.1).
 *
 * Asserts that callOmnirouteWithUsage formats the request body correctly
 * based on OMNIFORGE_PROMPT_PREFIX_CACHE + the model family + prompt size:
 *   - flag off → plain string for system content (legacy shape)
 *   - flag on, anthropic family, prompt ≥4K → cache_control envelope
 *   - flag on, non-anthropic family → plain string (don't fail other providers)
 *   - flag on, prompt <4K → plain string (Anthropic ignores cache below ~1K
 *     tokens; we use chars as a proxy and skip the marker to keep wire small)
 *
 * Origin: AUDIT-2026-05-05.md §6 perf-win 1, B6.1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callOmnirouteWithUsage } from '../../src/utils/omniroute-call.js';

// Capture the body sent to fetch — that's the assertion surface.
function captureFetch(): { calls: Array<{ url: string; init: RequestInit }>; install: () => void; restore: () => void } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          model: 'cc/claude-sonnet-4-6',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }
  return {
    calls,
    install() {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch;
    },
    restore() {
      (globalThis as unknown as { fetch: typeof fetch }).fetch = original;
    },
  };
}

const ORIG_CACHE_FLAG = process.env.OMNIFORGE_PROMPT_PREFIX_CACHE;
const ORIG_OMNIROUTE_URL = process.env.OMNIROUTE_URL;
const ORIG_OMNIROUTE_KEY = process.env.OMNIROUTE_API_KEY;

beforeEach(() => {
  // Pin Omniroute to a fake URL so the test never hits a real network.
  process.env.OMNIROUTE_URL = 'http://test-omniroute.invalid';
  process.env.OMNIROUTE_API_KEY = 'sk-test';
});

afterEach(() => {
  if (ORIG_CACHE_FLAG === undefined) delete process.env.OMNIFORGE_PROMPT_PREFIX_CACHE;
  else process.env.OMNIFORGE_PROMPT_PREFIX_CACHE = ORIG_CACHE_FLAG;
  if (ORIG_OMNIROUTE_URL === undefined) delete process.env.OMNIROUTE_URL;
  else process.env.OMNIROUTE_URL = ORIG_OMNIROUTE_URL;
  if (ORIG_OMNIROUTE_KEY === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = ORIG_OMNIROUTE_KEY;
  vi.restoreAllMocks();
});

function bodyOf(call: { init: RequestInit }): { messages: Array<{ role: string; content: unknown }> } {
  expect(call.init.body).toBeTypeOf('string');
  return JSON.parse(call.init.body as string) as ReturnType<typeof bodyOf>;
}

const BIG_SYSTEM = 'You are a helpful assistant. '.repeat(200); // ~5.6K chars
const SHORT_SYSTEM = 'You are a helpful assistant.'; // 28 chars

describe('callOmnirouteWithUsage — Anthropic prompt-prefix cache wire', () => {
  it('flag OFF (default): system content is a plain string', async () => {
    // Note: system + user are folded into one `user` message as a workaround for
    // OmniRoute v3.8.0 dropping `system` on Claude models (omniroute-call.ts:216).
    delete process.env.OMNIFORGE_PROMPT_PREFIX_CACHE;
    const fetchMock = captureFetch();
    fetchMock.install();
    try {
      await callOmnirouteWithUsage({
        systemPrompt: BIG_SYSTEM,
        userPrompt: 'hi',
        model: 'cc/claude-sonnet-4-6',
      });
      const body = bodyOf(fetchMock.calls[0]);
      expect(typeof body.messages[0].content).toBe('string');
      expect(body.messages[0].content as string).toContain(BIG_SYSTEM);
      expect(body.messages[0].content as string).toContain('hi');
    } finally {
      fetchMock.restore();
    }
  });

  it('flag ON + anthropic + ≥4K chars: system content is a cache_control envelope', async () => {
    process.env.OMNIFORGE_PROMPT_PREFIX_CACHE = 'true';
    const fetchMock = captureFetch();
    fetchMock.install();
    try {
      await callOmnirouteWithUsage({
        systemPrompt: BIG_SYSTEM,
        userPrompt: 'hi',
        model: 'cc/claude-sonnet-4-6',
      });
      const body = bodyOf(fetchMock.calls[0]);
      expect(Array.isArray(body.messages[0].content)).toBe(true);
      const block = (body.messages[0].content as Array<Record<string, unknown>>)[0];
      expect(block.type).toBe('text');
      expect(block.text).toBe(BIG_SYSTEM);
      expect(block.cache_control).toEqual({ type: 'ephemeral' });
    } finally {
      fetchMock.restore();
    }
  });

  it('flag ON + non-anthropic family: cache marker is NOT applied (other providers may reject)', async () => {
    process.env.OMNIFORGE_PROMPT_PREFIX_CACHE = 'true';
    const fetchMock = captureFetch();
    fetchMock.install();
    try {
      await callOmnirouteWithUsage({
        systemPrompt: BIG_SYSTEM,
        userPrompt: 'hi',
        model: 'cx/gpt-5.5', // openai family — not 'cc/' or 'claude-'
      });
      const body = bodyOf(fetchMock.calls[0]);
      expect(typeof body.messages[0].content).toBe('string');
    } finally {
      fetchMock.restore();
    }
  });

  it('flag ON + anthropic + <4K chars: cache marker is NOT applied (small prompt floor)', async () => {
    process.env.OMNIFORGE_PROMPT_PREFIX_CACHE = 'true';
    const fetchMock = captureFetch();
    fetchMock.install();
    try {
      await callOmnirouteWithUsage({
        systemPrompt: SHORT_SYSTEM,
        userPrompt: 'hi',
        model: 'cc/claude-sonnet-4-6',
      });
      const body = bodyOf(fetchMock.calls[0]);
      expect(typeof body.messages[0].content).toBe('string');
    } finally {
      fetchMock.restore();
    }
  });

  it('flag ON + claude- prefix (alt naming): cache marker IS applied', async () => {
    process.env.OMNIFORGE_PROMPT_PREFIX_CACHE = 'true';
    const fetchMock = captureFetch();
    fetchMock.install();
    try {
      await callOmnirouteWithUsage({
        systemPrompt: BIG_SYSTEM,
        userPrompt: 'hi',
        model: 'claude-sonnet-4-6', // direct anthropic id (no cc/ prefix)
      });
      const body = bodyOf(fetchMock.calls[0]);
      expect(Array.isArray(body.messages[0].content)).toBe(true);
    } finally {
      fetchMock.restore();
    }
  });

  it('user content is included alongside cache-marked system block (single folded user message)', async () => {
    // Workaround folds system + user into messages[0].content array; the second
    // block carries the user message text. cache_control is only on the system block.
    process.env.OMNIFORGE_PROMPT_PREFIX_CACHE = 'true';
    const fetchMock = captureFetch();
    fetchMock.install();
    try {
      await callOmnirouteWithUsage({
        systemPrompt: BIG_SYSTEM,
        userPrompt: 'this is the user message',
        model: 'cc/claude-sonnet-4-6',
      });
      const body = bodyOf(fetchMock.calls[0]);
      expect(Array.isArray(body.messages[0].content)).toBe(true);
      const blocks = body.messages[0].content as Array<Record<string, unknown>>;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(blocks[1].cache_control).toBeUndefined();
      expect(String(blocks[1].text)).toContain('this is the user message');
    } finally {
      fetchMock.restore();
    }
  });
});

// N3: cache observability — extractUsage must surface Anthropic's
// `cache_creation_input_tokens` + `cache_read_input_tokens` so callers /
// trace spans can measure the B6.1 wire's effectiveness.
describe('callOmnirouteWithUsage — Anthropic cache fields (N3)', () => {
  function mockResponse(usage: Record<string, unknown>): { calls: Array<{ url: string; init: RequestInit }>; install: () => void; restore: () => void } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const original = globalThis.fetch;
    function fakeFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            model: 'cc/claude-sonnet-4-6',
            usage,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return {
      calls,
      install() { (globalThis as unknown as { fetch: typeof fetch }).fetch = fakeFetch as unknown as typeof fetch; },
      restore() { (globalThis as unknown as { fetch: typeof fetch }).fetch = original; },
    };
  }

  it('passes through cache_creation_input_tokens when present in response', async () => {
    const m = mockResponse({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 4500,
    });
    m.install();
    try {
      const result = await callOmnirouteWithUsage({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        model: 'cc/claude-sonnet-4-6',
      });
      expect(result.usage?.cache_creation_input_tokens).toBe(4500);
      expect(result.usage?.cache_read_input_tokens).toBeUndefined();
    } finally { m.restore(); }
  });

  it('passes through cache_read_input_tokens when present (cache HIT)', async () => {
    const m = mockResponse({
      input_tokens: 50,                    // small "fresh" input
      output_tokens: 40,
      cache_read_input_tokens: 4500,       // huge cached prefix re-used
    });
    m.install();
    try {
      const result = await callOmnirouteWithUsage({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        model: 'cc/claude-sonnet-4-6',
      });
      expect(result.usage?.cache_read_input_tokens).toBe(4500);
      // The smoking-gun: cache_read > 0 = the B6.1 wire is doing its job
      expect((result.usage?.cache_read_input_tokens ?? 0) > 0).toBe(true);
    } finally { m.restore(); }
  });

  it('omits cache fields when response usage has none (non-Anthropic provider)', async () => {
    const m = mockResponse({
      prompt_tokens: 100,
      completion_tokens: 50,
      cost_usd: 0.001,
    });
    m.install();
    try {
      const result = await callOmnirouteWithUsage({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        model: 'cx/gpt-5.5',
      });
      expect(result.usage?.cache_creation_input_tokens).toBeUndefined();
      expect(result.usage?.cache_read_input_tokens).toBeUndefined();
      expect(result.usage?.input_tokens).toBe(100);
      expect(result.usage?.output_tokens).toBe(50);
    } finally { m.restore(); }
  });

  it('handles both cache fields together (creation + read in same response)', async () => {
    const m = mockResponse({
      input_tokens: 200,
      output_tokens: 80,
      cache_creation_input_tokens: 1024,
      cache_read_input_tokens: 3456,
    });
    m.install();
    try {
      const result = await callOmnirouteWithUsage({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        model: 'cc/claude-sonnet-4-6',
      });
      expect(result.usage?.cache_creation_input_tokens).toBe(1024);
      expect(result.usage?.cache_read_input_tokens).toBe(3456);
    } finally { m.restore(); }
  });
});
