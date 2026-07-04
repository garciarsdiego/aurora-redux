import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must mock config before importing the module under test
vi.mock('../../src/utils/config.js', () => ({
  getOmnirouteUrl: () => 'http://localhost:20228',
  getOmnirouteApiKey: () => 'test-key',
  getOmnirouteDefaultModel: () => 'cc/claude-sonnet-4-6',
  getOmnirouteMaxTokens: () => 8192,
  getOmnirouteMaxContinuations: () => 3,
  getOmnirouteUseResponsesApi: () => false,
  getOmnirouteFallbackModels: () => [],
}));

const FAKE_MODELS = [
  { id: 'cc/claude-sonnet-4-6', object: 'model' },
  { id: 'openai/gpt-4o', object: 'model' },
];

function makeFetchResponse(models: typeof FAKE_MODELS) {
  return Promise.resolve({
    ok: true,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({ data: models }),
  } as unknown as Response);
}

describe('fetchModels 5-minute cache (B.4 — PR #8 deferred)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls fetch once and caches the result within TTL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(makeFetchResponse(FAKE_MODELS));

    // Dynamic import so the vi.mock above takes effect
    const { fetchModels } = await import('../../src/v2/omniroute-bridge/client.js');

    const first = await fetchModels({ force: true });
    const second = await fetchModels();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.enabled).toBe(true);
    expect(first.models).toHaveLength(2);
    expect(second).toBe(first); // exact same cached object
  });

  it('force: true bypasses the cache and re-fetches', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(makeFetchResponse(FAKE_MODELS));
    const { fetchModels } = await import('../../src/v2/omniroute-bridge/client.js');

    await fetchModels({ force: true });
    await fetchModels({ force: true });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('re-fetches after TTL (5 minutes) expires', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(makeFetchResponse(FAKE_MODELS));
    const { fetchModels } = await import('../../src/v2/omniroute-bridge/client.js');

    await fetchModels({ force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance past 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await fetchModels();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns enabled: false when no API key is configured', async () => {
    // Override the mock for this test only
    const configMod = await import('../../src/utils/config.js');
    vi.spyOn(configMod, 'getOmnirouteApiKey').mockReturnValue('');

    const { fetchModels } = await import('../../src/v2/omniroute-bridge/client.js');
    const result = await fetchModels({ force: true });

    expect(result.enabled).toBe(false);
    expect(result.models).toHaveLength(0);
  });
});
