import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  mkdir: mkdirMock,
  stat: statMock,
}));

import { resolveTool } from '../../src/v2/tools/registry.js';
import {
  webSearch,
  WebSearchInputSchema,
  parseDuckDuckGoSerpHtml,
} from '../../src/v2/tools/core/web-search.js';

const MS_PER_HOUR = 60 * 60 * 1000;

beforeEach(() => {
  readFileMock.mockReset();
  writeFileMock.mockReset();
  mkdirMock.mockReset();
  statMock.mockReset();
  mkdirMock.mockResolvedValue(undefined);
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.SERPAPI_KEY;
  vi.stubGlobal('fetch', undefined as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseDuckDuckGoSerpHtml', () => {
  it('extracts title, url, and snippet from DuckDuckGo-style HTML', () => {
    const html = `
      <div>
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp">My Page</a>
        <a class="result__snippet">First hit description here.</a>
        <a class="result__a" href="https://other.test/doc">Second</a>
        <a class="result__snippet"><b>Bold</b> snippet piece.</a>
      </div>`;

    const results = parseDuckDuckGoSerpHtml(html, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'My Page',
      url: expect.stringContaining('example.com'),
      snippet: expect.stringContaining('First hit'),
    });
    expect(results[1]?.title).toBe('Second');
    expect(results[1]?.snippet).toContain('Bold');
  });

  it('respects limit when SERP yields more anchors', () => {
    let html = '';
    for (let i = 0; i < 5; i++) {
      html += `<a class="result__a" href="https://u${i}.test">${i}</a>`;
      html += `<a class="result__snippet">s${i}</a>`;
    }
    const results = parseDuckDuckGoSerpHtml(html, 2);
    expect(results).toHaveLength(2);
    expect(results[1]?.url).toBe('https://u1.test');
  });
});

describe('webSearch', () => {
  it('throws on empty query (Zod validation)', async () => {
    expect(WebSearchInputSchema.safeParse({ query: '', limit: 10 }).success).toBe(false);
    await expect(webSearch({ query: '', limit: 10 })).rejects.toThrow();
  });

  it('returns cached payload when cache file is fresh', async () => {
    statMock.mockResolvedValue({ mtimeMs: Date.now() - MS_PER_HOUR } as Awaited<
      ReturnType<typeof import('node:fs/promises').stat>
    >);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        results: [{ title: 'T', url: 'https://cached', snippet: 'S' }],
        provider: 'serpapi',
      }),
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch({ query: 'alpha', limit: 10 });

    expect(out.cached).toBe(true);
    expect(out.provider).toBe('serpapi');
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.url).toBe('https://cached');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it('treats cache as miss when mtime is older than 24h (no readFile)', async () => {
    statMock.mockResolvedValue({
      mtimeMs: Date.now() - 25 * MS_PER_HOUR,
    } as Awaited<ReturnType<typeof import('node:fs/promises').stat>>);

    process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';

    const braveBody = {
      web: {
        results: [{ title: 'Fresh', url: 'https://fresh.example', description: 'D' }],
      },
    };

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(braveBody), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch({ query: 'beta', limit: 10 });

    expect(out.cached).toBe(false);
    expect(out.provider).toBe('brave');
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    const braveCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('api.search.brave.com'),
    );
    expect(braveCall).toBeDefined();
  });

  it('uses Brave when BRAVE_SEARCH_API_KEY is set (cache miss)', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    process.env.BRAVE_SEARCH_API_KEY = 'k';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          web: {
            results: [
              { title: 'A', url: 'https://a', description: 'da' },
              { title: 'B', url: 'https://b', description: 'db' },
              { title: 'C', url: 'https://c', description: 'dc' },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch({ query: 'q', limit: 2 });

    expect(out.cached).toBe(false);
    expect(out.provider).toBe('brave');
    expect(out.results).toHaveLength(2);
    expect(out.results[1]?.title).toBe('B');
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.hostname).toBe('api.search.brave.com');
    expect(u.searchParams.get('count')).toBe('2');
  });

  it('falls back to SerpAPI when Brave key is absent', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    process.env.SERPAPI_KEY = 'sk';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          organic_results: [
            { title: 'S1', link: 'https://s1', snippet: 'x' },
            { title: 'S2', link: 'https://s2', snippet: 'y' },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch({ query: 'gamma', limit: 10 });

    expect(out.provider).toBe('serpapi');
    expect(out.cached).toBe(false);
    const u = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(u.hostname).toBe('serpapi.com');
    expect(u.searchParams.get('api_key')).toBe('sk');
    expect(u.searchParams.get('num')).toBe('10');
  });

  it('falls back to DuckDuckGo HTML when no API keys are set', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const html = `
      <a class="result__a" href="https://ddg.example/r">Result One</a>
      <a class="result__snippet">Snippet for one.</a>`;

    const fetchMock = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await webSearch({ query: 'delta', limit: 5 });

    expect(out.provider).toBe('duckduckgo');
    expect(out.cached).toBe(false);
    expect(out.results[0]).toMatchObject({
      title: 'Result One',
      snippet: 'Snippet for one.',
    });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('html.duckduckgo.com');
  });
});

describe('web-search tool registration', () => {
  it('registers web-search in the tool registry', () => {
    const def = resolveTool('web-search');
    expect(def.name).toBe('web-search');
    expect(def.argsSchema).toBeDefined();
  });
});
