import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchProviderModels,
  listAllProviderModels,
  clearProviderModelsCache,
} from '../../src/utils/provider-models.js';
import type { DirectProviderRoute } from '../../src/utils/provider-routes.js';

// P3a (Aurora-Redux, trilha P3): módulo de fetch de modelos por provedor.
// Segue o padrão de mock de fetch de omniroute-call-ledger.test.ts
// (vi.stubGlobal('fetch', ...) + vi.unstubAllGlobals() no afterEach).

function makeRoute(overrides: Partial<DirectProviderRoute> = {}): DirectProviderRoute {
  return {
    providerName: 'kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    path: '/chat/completions',
    envVar: 'KIMI_API_KEY',
    baseUrlEnvVar: 'KIMI_BASE_URL',
    ...overrides,
  };
}

describe('fetchProviderModels', () => {
  const originalKey = process.env.KIMI_API_KEY;

  beforeEach(() => {
    process.env.KIMI_API_KEY = 'test-key';
    clearProviderModelsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = originalKey;
    clearProviderModelsCache();
  });

  it('parseia { data: [{id}] } OpenAI-compat em {provider, models}', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const result = await fetchProviderModels(makeRoute());
    expect(result).toEqual({ provider: 'kimi', models: ['m1', 'm2'] });
  });

  it('deriva a URL de /models a partir da base do route (sem /chat/completions)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'm1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchProviderModels(makeRoute());
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://api.kimi.com/coding/v1/models');
    expect(calledUrl).not.toContain('/chat/completions');
  });

  it('envia Authorization Bearer com getDirectProviderApiKey(route)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchProviderModels(makeRoute());
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('HTTP 500 → {provider, error}, nunca lança', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const result = await fetchProviderModels(makeRoute());
    expect(result.provider).toBe('kimi');
    expect('error' in result && result.error).toBeTruthy();
    expect('models' in result).toBe(false);
  });

  it('timeout/exceção → {provider, error} sem lançar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network timeout');
      }),
    );
    const result = await fetchProviderModels(makeRoute());
    expect(result.provider).toBe('kimi');
    expect('error' in result && result.error).toContain('timeout');
  });

  it('resposta sem shape esperado (data ausente) → error, não lança', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ nonsense: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const result = await fetchProviderModels(makeRoute());
    expect(result.provider).toBe('kimi');
    expect('error' in result && result.error).toBeTruthy();
  });

  it('usa AbortSignal.timeout (~8s) — a chamada de fetch recebe um signal', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchProviderModels(makeRoute());
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(options.signal).toBeDefined();
  });
});

describe('listAllProviderModels', () => {
  const CANDIDATE_ENVS = [
    'KIMI_API_KEY', 'KIMI_BASE_URL',
    'MINIMAX_API_KEY', 'MINIMAX_BASE_URL',
    'GLM_API_KEY', 'GLM_BASE_URL',
    'FOO_BASE_URL', 'FOO_API_KEY',
  ];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of CANDIDATE_ENVS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    clearProviderModelsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of CANDIDATE_ENVS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearProviderModelsCache();
  });

  it('filtra só rotas com API key presente e agrega em paralelo', async () => {
    process.env.KIMI_API_KEY = 'k1';
    // MINIMAX e GLM ficam sem key — não devem ser consultados via HTTP.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'kimi-for-coding' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const result = await listAllProviderModels();
    const kimiEntry = result.find((r) => r.provider === 'kimi');
    expect(kimiEntry).toBeDefined();
    expect('models' in kimiEntry! && kimiEntry!.models).toEqual(['kimi-for-coding']);
    // minimax/glm sem key configurada não devem aparecer como fetch results.
    expect(result.some((r) => r.provider === 'minimax')).toBe(false);
    expect(result.some((r) => r.provider === 'glm')).toBe(false);
  });

  it('inclui entradas estáticas informativas para transportes CLI (claude-cli/codex-cli)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const result = await listAllProviderModels();
    const claudeCli = result.find((r) => r.provider === 'claude-cli');
    const codexCli = result.find((r) => r.provider === 'codex-cli');
    expect(claudeCli).toBeDefined();
    expect(codexCli).toBeDefined();
    expect('error' in claudeCli!).toBe(false);
    expect('note' in claudeCli! && claudeCli!.note).toBeTruthy();
    expect('models' in claudeCli! && claudeCli!.models).toEqual([]);
  });

  it('provedor dinâmico com key presente também é consultado', async () => {
    process.env.FOO_BASE_URL = 'https://api.foo.example/v1';
    process.env.FOO_API_KEY = 'foo-key';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: 'foo-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const result = await listAllProviderModels();
    const fooEntry = result.find((r) => r.provider === 'foo');
    expect(fooEntry).toBeDefined();
    expect('models' in fooEntry! && fooEntry!.models).toEqual(['foo-model']);
  });

  it('nenhuma key configurada → só as entradas estáticas de CLI aparecem', async () => {
    const result = await listAllProviderModels();
    expect(result.every((r) => r.provider === 'claude-cli' || r.provider === 'codex-cli')).toBe(true);
  });
});
