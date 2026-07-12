import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerTool, type ToolResult, type ToolContext } from '../registry.js';

export const WebSearchInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(50).default(10),
});

export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutput {
  results: WebSearchResult[];
  provider: 'brave' | 'serpapi' | 'duckduckgo';
  cached: boolean;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UA =
  'Mozilla/5.0 (compatible; Omniforge/0.3; +https://example.invalid) web-search';

type PersistedSearchPayload = {
  results: WebSearchResult[];
  provider: 'brave' | 'serpapi' | 'duckduckgo';
};

function webSearchCacheDir(): string {
  return resolve(process.cwd(), 'data', 'web_search_cache');
}

function webSearchCachePath(query: string, limit: number): string {
  const key = createHash('sha256').update(`${query}\u0000${limit}`).digest('hex');
  return resolve(webSearchCacheDir(), `${key}.json`);
}

async function readCacheIfFresh(
  filePath: string,
): Promise<WebSearchOutput | null> {
  try {
    const st = await stat(filePath);
    if (Date.now() - st.mtimeMs >= CACHE_TTL_MS) {
      return null;
    }
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedSearchPayload;
    if (!parsed || !Array.isArray(parsed.results) || !parsed.provider) {
      return null;
    }
    return {
      results: parsed.results.map((r) => ({
        title: String(r.title ?? ''),
        url: String(r.url ?? ''),
        snippet: String(r.snippet ?? ''),
      })),
      provider: parsed.provider,
      cached: true,
    };
  } catch {
    return null;
  }
}

async function writeCache(
  filePath: string,
  payload: PersistedSearchPayload,
): Promise<void> {
  await mkdir(webSearchCacheDir(), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload), 'utf8');
}

function truncateResults(
  results: WebSearchResult[],
  limit: number,
): WebSearchResult[] {
  return results.slice(0, limit);
}

/** Minimal HTML entity decode for snippets/titles pulled from DuckDuckGo HTML. */
function decodeBasicHtmlEntities(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function stripTags(html: string): string {
  return decodeBasicHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parses DuckDuckGo `html.duckduckgo.com/html` result list.
 *
 * DuckDuckGo marks primary links with `class="result__a"` (href + anchor text as title).
 * Adjacent snippets use `class="result__snippet"`. Ordering in the SERP aligns index-wise
 * for typical result blocks; regex pairing keeps the implementation dependency-free.
 */
export function parseDuckDuckGoSerpHtml(
  html: string,
  limit: number,
): WebSearchResult[] {
  const linkRe =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe =
    /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];

  const out: WebSearchResult[] = [];
  for (let i = 0; i < links.length && out.length < limit; i++) {
    const href = decodeBasicHtmlEntities(links[i]![1]!.trim());
    const titleHtml = links[i]![2] ?? '';
    const title = stripTags(titleHtml);
    const snippetRaw = snippets[i]?.[1] ?? '';
    const snippet = stripTags(snippetRaw);
    out.push({ title, url: href, snippet });
  }

  // Loop condition (`out.length < limit`) already caps `out` at `limit`
  // entries — no re-truncation needed here.
  return out;
}

async function fetchBraveSerp(query: string, limit: number): Promise<WebSearchResult[]> {
  const token = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!token) {
    throw new Error('web-search: BRAVE_SEARCH_API_KEY is not set');
  }

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`web-search: Brave HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string }>;
    };
  };

  const rows = data.web?.results ?? [];
  return truncateResults(
    rows.map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    })),
    limit,
  );
}

async function fetchSerpApiSerp(
  query: string,
  limit: number,
): Promise<WebSearchResult[]> {
  const apiKey = process.env.SERPAPI_KEY?.trim();
  if (!apiKey) {
    throw new Error('web-search: SERPAPI_KEY is not set');
  }

  const url = new URL('https://serpapi.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(limit));
  url.searchParams.set('api_key', apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`web-search: SerpAPI HTTP ${res.status}`);
  }

  const data = (await res.json()) as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>;
    error?: string;
  };

  if (data.error) {
    throw new Error(`web-search: SerpAPI error ${data.error}`);
  }

  const rows = data.organic_results ?? [];
  return truncateResults(
    rows.map((r) => ({
      title: r.title ?? '',
      url: r.link ?? '',
      snippet: r.snippet ?? '',
    })),
    limit,
  );
}

async function fetchDuckDuckGoSerp(
  query: string,
  limit: number,
): Promise<WebSearchResult[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);

  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html',
    },
  });

  if (!res.ok) {
    throw new Error(`web-search: DuckDuckGo HTML HTTP ${res.status}`);
  }

  const html = await res.text();
  return parseDuckDuckGoSerpHtml(html, limit);
}

async function runLiveSearch(
  query: string,
  limit: number,
): Promise<PersistedSearchPayload> {
  if (process.env.BRAVE_SEARCH_API_KEY?.trim()) {
    const results = await fetchBraveSerp(query, limit);
    return { results, provider: 'brave' };
  }

  if (process.env.SERPAPI_KEY?.trim()) {
    const results = await fetchSerpApiSerp(query, limit);
    return { results, provider: 'serpapi' };
  }

  const results = await fetchDuckDuckGoSerp(query, limit);
  return { results, provider: 'duckduckgo' };
}

export async function webSearch(input: WebSearchInput): Promise<WebSearchOutput> {
  const parsed = WebSearchInputSchema.parse(input);
  const { query, limit } = parsed;
  const cachePath = webSearchCachePath(query, limit);

  const cached = await readCacheIfFresh(cachePath);
  if (cached) {
    return {
      ...cached,
      results: truncateResults(cached.results, limit),
    };
  }

  const live = await runLiveSearch(query, limit);
  const payload: PersistedSearchPayload = {
    results: truncateResults(live.results, limit),
    provider: live.provider,
  };

  try {
    await writeCache(cachePath, payload);
  } catch (err) {
    console.error('[web-search] cache write failed:', err);
  }

  return {
    results: payload.results,
    provider: payload.provider,
    cached: false,
  };
}

registerTool({
  name: 'web-search',
  description:
    'Web search with Brave → SerpAPI → DuckDuckGo cascade, 24h disk cache under data/web_search_cache/',
  argsSchema: WebSearchInputSchema,
  async execute(args, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const out = await webSearch(args);
      return { success: true, output: JSON.stringify(out) };
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
