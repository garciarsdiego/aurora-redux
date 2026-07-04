// Aurora-parity Wave 2 — exact-match LLM response cache.
//
// A solo operator re-runs the same objective dozens of times while iterating;
// every re-run otherwise re-pays for byte-identical decomposer/reviewer/
// consolidator calls. This cache replays an identical call at $0.
//
// CORRECTNESS TRAP (flagged in the parity-plan critique): the cache key MUST
// include the FULL system prompt — which already carries the injected
// "## Past run lessons" reflection block and the active decomposer variant — so
// a newly-learned lesson (or a swapped A/B variant) changes the key and MISSES,
// rather than silently serving a stale decomposition and defeating the Wave-3
// recall flywheel. computeLlmCacheKey hashes the whole systemPrompt to guarantee
// this; `llm-cache.test.ts` asserts a changed system prompt is a MISS.
//
// Opt-in: OMNIFORGE_LLM_CACHE=true (default OFF). Best-effort: every DB op is
// guarded so a cache failure can never break the live LLM call.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

const CACHE_KEY_VERSION = 'v1';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Cache is opt-in; default off until the key-sensitivity test is trusted in prod. */
export function isLlmCacheEnabled(): boolean {
  return process.env.OMNIFORGE_LLM_CACHE === 'true';
}

function cacheTtlMs(): number {
  const raw = process.env.OMNIFORGE_LLM_CACHE_TTL_MS;
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TTL_MS;
}

export interface LlmCacheKeyParts {
  /** The model that will actually serve the request (post routing + auto-tag). */
  model: string;
  /** FULL system prompt — includes injected reflection + active variant (see header). */
  systemPrompt: string;
  userPrompt: string;
  /** null when the model doesn't support temperature (so it isn't part of the key). */
  temperature: number | null;
}

export function computeLlmCacheKey(parts: LlmCacheKeyParts): string {
  const canonical = JSON.stringify({
    v: CACHE_KEY_VERSION,
    model: parts.model,
    system: parts.systemPrompt,
    user: parts.userPrompt,
    temperature: parts.temperature,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface CachedLlmResponse {
  content: string;
  model: string;
  usage: unknown | null;
}

/**
 * Return a cached response for `key`, or null on miss / staleness / any error.
 * Increments hit_count on a fresh hit. Never throws — the cache is best-effort.
 */
export function getCachedResponse(
  db: Database.Database,
  key: string,
  nowMs: number = Date.now(),
): CachedLlmResponse | null {
  try {
    const row = db
      .prepare('SELECT model, content, usage_json, created_at FROM llm_response_cache WHERE cache_key = ?')
      .get(key) as { model: string; content: string; usage_json: string | null; created_at: number } | undefined;
    if (!row) return null;
    if (nowMs - row.created_at > cacheTtlMs()) return null; // stale — treat as miss
    db.prepare('UPDATE llm_response_cache SET hit_count = hit_count + 1 WHERE cache_key = ?').run(key);
    return {
      content: row.content,
      model: row.model,
      usage: row.usage_json ? (JSON.parse(row.usage_json) as unknown) : null,
    };
  } catch {
    return null;
  }
}

/** Store (or replace) a response. Preserves hit_count on replace. Never throws. */
export function putCachedResponse(
  db: Database.Database,
  key: string,
  model: string,
  content: string,
  usage: unknown | null,
  nowMs: number = Date.now(),
): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO llm_response_cache (cache_key, model, content, usage_json, created_at, hit_count)
       VALUES (?, ?, ?, ?, ?, COALESCE((SELECT hit_count FROM llm_response_cache WHERE cache_key = ?), 0))`,
    ).run(key, model, content, usage !== null && usage !== undefined ? JSON.stringify(usage) : null, nowMs, key);
  } catch {
    // best-effort
  }
}
