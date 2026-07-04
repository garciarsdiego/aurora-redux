import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _getModelCacheSize,
  _resetModelCache,
  fetchModels,
} from '../../src/v2/omniroute-bridge/client.js';

const ENV_KEY = 'OMNIROUTE_MODEL_CACHE_SIZE';
const URL_KEY = 'OMNIROUTE_URL';
const API_KEY = 'OMNIROUTE_API_KEY';

const STUB_PAYLOAD = {
  data: [
    { id: 'cc/claude-sonnet-4-6' },
    { id: 'openai/gpt-5.4' },
  ],
};

describe('omniroute model cache LRU cap', () => {
  let originalCache: string | undefined;
  let originalUrl: string | undefined;
  let originalKey: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCache = process.env[ENV_KEY];
    originalUrl = process.env[URL_KEY];
    originalKey = process.env[API_KEY];
    process.env[API_KEY] = 'test-key-not-real';
    _resetModelCache();

    // Each call must return a fresh Response — Response bodies are single-use,
    // and `mockResolvedValue` would hand the same instance back to every caller.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify(STUB_PAYLOAD), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    if (originalCache === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalCache;
    if (originalUrl === undefined) delete process.env[URL_KEY];
    else process.env[URL_KEY] = originalUrl;
    if (originalKey === undefined) delete process.env[API_KEY];
    else process.env[API_KEY] = originalKey;
    _resetModelCache();
    fetchSpy.mockRestore();
  });

  it('caps the cache and evicts oldest entry first (FIFO) once the cap is exceeded', async () => {
    process.env[ENV_KEY] = '3';

    // Drive different cache keys by mutating OMNIROUTE_URL between calls;
    // cacheKey is `${baseUrl}` which is derived from the URL config.
    process.env[URL_KEY] = 'http://localhost:21001';
    await fetchModels({ force: true });
    process.env[URL_KEY] = 'http://localhost:21002';
    await fetchModels({ force: true });
    process.env[URL_KEY] = 'http://localhost:21003';
    await fetchModels({ force: true });
    expect(_getModelCacheSize()).toBe(3);

    // 4th distinct key should evict the oldest:
    process.env[URL_KEY] = 'http://localhost:21004';
    await fetchModels({ force: true });
    expect(_getModelCacheSize()).toBe(3);
  });

  it('respects the default cap (100) when env is unset', async () => {
    delete process.env[ENV_KEY];

    for (let i = 0; i < 101; i += 1) {
      process.env[URL_KEY] = `http://localhost:${22000 + i}`;
      await fetchModels({ force: true });
    }
    expect(_getModelCacheSize()).toBe(100);
  });

  it('falls back to default cap when env value is non-numeric or non-positive', async () => {
    process.env[ENV_KEY] = 'garbage';
    for (let i = 0; i < 101; i += 1) {
      process.env[URL_KEY] = `http://localhost:${23000 + i}`;
      await fetchModels({ force: true });
    }
    expect(_getModelCacheSize()).toBe(100);

    _resetModelCache();
    process.env[ENV_KEY] = '0';
    for (let i = 0; i < 101; i += 1) {
      process.env[URL_KEY] = `http://localhost:${24000 + i}`;
      await fetchModels({ force: true });
    }
    expect(_getModelCacheSize()).toBe(100);
  });

  it('keeps the cache empty when the API key is missing (no caching path)', async () => {
    delete process.env[API_KEY];
    process.env[URL_KEY] = 'http://localhost:25000';
    const result = await fetchModels({ force: true });
    expect(result.enabled).toBe(false);
    expect(_getModelCacheSize()).toBe(0);
  });
});
