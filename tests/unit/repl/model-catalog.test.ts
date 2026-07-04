// Tests for modelCatalog loader — live fetch mock + CSV merge behavior.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _clearCatalogCache, extractProvider, loadCatalog } from '../../../src/repl/services/modelCatalog.js';

beforeEach(() => {
  _clearCatalogCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  _clearCatalogCache();
});

describe('extractProvider', () => {
  it('parses slash-separated model ids', () => {
    expect(extractProvider('cc/claude-sonnet-4-6')).toBe('cc');
    expect(extractProvider('gemini-cli/gemini-3.1-pro-preview')).toBe('gemini-cli');
  });

  it('parses colon-separated PAL tool ids', () => {
    expect(extractProvider('pal:consensus')).toBe('pal');
    expect(extractProvider('pal:thinkdeep')).toBe('pal');
  });

  it('returns "unknown" for malformed ids', () => {
    expect(extractProvider('bare-model')).toBe('unknown');
    expect(extractProvider('')).toBe('unknown');
  });
});

describe('loadCatalog', () => {
  it('falls back to CSV when live API fetch fails (timeout simulated)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const cat = await loadCatalog({ force: true });
    expect(cat.source).toBe('csv');
    expect(cat.liveError).toMatch(/live API unavailable/);
    expect(cat.models.length).toBeGreaterThan(0);
    // All non-virtual entries should be 'csv' source when live failed;
    // virtual CLI pseudo-entries are injected regardless.
    const nonVirtual = cat.models.filter((m) => m.source !== 'virtual');
    expect(nonVirtual.length).toBeGreaterThan(0);
    expect(nonVirtual.every((m) => m.source === 'csv')).toBe(true);
  });

  it('merges live API result with CSV metadata', async () => {
    const liveIds = ['cc/claude-sonnet-4-6', 'cx/gpt-5.4', 'cc/new-model-not-in-csv'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: liveIds.map((id) => ({ id })) }),
    }));
    const cat = await loadCatalog({ force: true });
    expect(cat.source).toBe('merged');
    expect(cat.liveError).toBeUndefined();

    // cc/claude-sonnet-4-6 is in both → 'merged' source + CSV metadata preserved
    const sonnet = cat.models.find((m) => m.model_id === 'cc/claude-sonnet-4-6');
    expect(sonnet).toBeDefined();
    if (sonnet) {
      expect(sonnet.source).toBe('merged');
      expect(sonnet.provider).toBe('cc');
    }

    // cc/new-model-not-in-csv is live-only → 'live' source + no metadata
    const liveOnly = cat.models.find((m) => m.model_id === 'cc/new-model-not-in-csv');
    expect(liveOnly).toBeDefined();
    if (liveOnly) {
      expect(liveOnly.source).toBe('live');
      expect(liveOnly.tier).toBeUndefined();
    }
  });

  it('waits long enough for the real Omniroute catalog before falling back to CSV', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2500);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'cc/claude-sonnet-4-6' }] }),
      };
    }));

    const cat = await loadCatalog({ force: true });

    expect(cat.source).toBe('merged');
    expect(cat.liveError).toBeUndefined();
  });

  it('sorts providers alphabetically (Example decision 2026-04-24)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const cat = await loadCatalog({ force: true });
    expect(cat.providers.length).toBeGreaterThan(0);
    for (let i = 0; i + 1 < cat.providers.length; i++) {
      expect(
        cat.providers[i]!.displayName.localeCompare(cat.providers[i + 1]!.displayName),
      ).toBeLessThanOrEqual(0);
    }
  });

  it('caches result for 5min (same instance returned without re-fetch)', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchSpy);
    const first = await loadCatalog({ force: true });
    const second = await loadCatalog(); // no force → cache hit
    expect(first).toBe(second);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('force:true bypasses cache', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchSpy);
    await loadCatalog({ force: true });
    await loadCatalog({ force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('sorts models by tier (S+ first, then alphabetical)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const cat = await loadCatalog({ force: true });
    // First entry with a tier must be S+ or S (assuming CSV has some of those)
    const firstWithTier = cat.models.find((m) => m.tier);
    if (firstWithTier) {
      const topTiers = ['S+', 'S', 'S-'];
      expect(topTiers).toContain(firstWithTier.tier);
    }
  });

  it('ignores malformed live API shape without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ /* missing data */ }),
    }));
    const cat = await loadCatalog({ force: true });
    // Should fall through to CSV
    expect(cat.source).toBe('csv');
  });

  it('ignores non-200 responses as failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const cat = await loadCatalog({ force: true });
    expect(cat.source).toBe('csv');
    expect(cat.liveError).toBeDefined();
  });

  it('injects 7 virtual cli:<slug> pseudo-entries regardless of live/csv state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const cat = await loadCatalog({ force: true });
    const virtuals = cat.models.filter((m) => m.source === 'virtual');
    expect(virtuals.length).toBe(7);

    // All virtuals are provider=cli + kind=cli
    expect(virtuals.every((m) => m.provider === 'cli')).toBe(true);
    expect(virtuals.every((m) => m.kind === 'cli')).toBe(true);

    // The 7 slugs we care about today (sync with resolveCliSpec)
    const ids = virtuals.map((m) => m.model_id).sort();
    expect(ids).toEqual([
      'cli:claude-code',
      'cli:codex',
      'cli:cursor',
      'cli:gemini',
      'cli:kilo',
      'cli:kimi',
      'cli:opencode',
    ]);

    // Virtual entries have no tier (they're not ranked) → sort tail
    expect(virtuals.every((m) => m.tier === undefined)).toBe(true);
  });

  it('virtual entries survive the live+CSV merge (not overwritten by either)', async () => {
    // Simulate Omniroute returning an id that clashes by coincidence — virtual
    // injection happens AFTER merge, so it should add its own row, not replace.
    const liveIds = ['cc/claude-sonnet-4-6'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: liveIds.map((id) => ({ id })) }),
    }));
    const cat = await loadCatalog({ force: true });
    expect(cat.models.filter((m) => m.source === 'virtual').length).toBe(7);
  });

  it('classifies provider prefix → kind (every CSV prefix is llm; pal/cli are pseudo-buckets)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const cat = await loadCatalog({ force: true });

    // Every model has a kind field populated.
    expect(cat.models.every((m) => m.kind !== undefined)).toBe(true);

    // All 13 CSV prefixes are Omniroute routes (llm_call) — including
    // `gemini-cli` and `opencode-go` whose prefix names hint at CLI binaries
    // but the catalog entry routes through Omniroute, not local spawn.
    const cc = cat.models.find((m) => m.provider === 'cc');
    if (cc) expect(cc.kind).toBe('llm');

    const minimax = cat.models.find((m) => m.provider === 'minimax');
    if (minimax) expect(minimax.kind).toBe('llm');

    const geminiCli = cat.models.find((m) => m.provider === 'gemini-cli');
    if (geminiCli) expect(geminiCli.kind).toBe('llm'); // route, not binary

    const opencode = cat.models.find((m) => m.provider === 'opencode-go');
    if (opencode) expect(opencode.kind).toBe('llm');   // route, not binary
  });
});
