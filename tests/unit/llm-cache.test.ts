/**
 * Aurora-parity Wave 2 — exact-match LLM response cache.
 * The CRITICAL test: a changed system prompt (a newly-injected reflection lesson
 * or a swapped variant) must produce a DIFFERENT key → MISS, so the cache can
 * never silently serve a stale decomposition and defeat the recall flywheel.
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeLlmCacheKey,
  getCachedResponse,
  putCachedResponse,
  isLlmCacheEnabled,
  type LlmCacheKeyParts,
} from '../../src/utils/llm-cache.js';

const BASE: LlmCacheKeyParts = {
  model: 'cc/claude-sonnet-4-6',
  systemPrompt: 'You are a decomposer.\n\n## Past run lessons\n- lesson A',
  userPrompt: 'Build X',
  temperature: 0.2,
};

describe('computeLlmCacheKey — sensitivity', () => {
  it('is stable for identical inputs', () => {
    expect(computeLlmCacheKey(BASE)).toBe(computeLlmCacheKey({ ...BASE }));
  });

  it('MISSES when the system prompt changes (new reflection lesson / swapped variant)', () => {
    const withNewLesson = { ...BASE, systemPrompt: BASE.systemPrompt + '\n- lesson B (newly learned)' };
    expect(computeLlmCacheKey(withNewLesson)).not.toBe(computeLlmCacheKey(BASE));
  });

  it('MISSES on a different model / user prompt / temperature', () => {
    expect(computeLlmCacheKey({ ...BASE, model: 'cc/claude-opus-4-7' })).not.toBe(computeLlmCacheKey(BASE));
    expect(computeLlmCacheKey({ ...BASE, userPrompt: 'Build Y' })).not.toBe(computeLlmCacheKey(BASE));
    expect(computeLlmCacheKey({ ...BASE, temperature: 0.9 })).not.toBe(computeLlmCacheKey(BASE));
    expect(computeLlmCacheKey({ ...BASE, temperature: null })).not.toBe(computeLlmCacheKey(BASE));
  });
});

describe('isLlmCacheEnabled', () => {
  const orig = process.env.OMNIFORGE_LLM_CACHE;
  afterEach(() => { if (orig === undefined) delete process.env.OMNIFORGE_LLM_CACHE; else process.env.OMNIFORGE_LLM_CACHE = orig; });
  it('defaults off, true only for the explicit string', () => {
    delete process.env.OMNIFORGE_LLM_CACHE;
    expect(isLlmCacheEnabled()).toBe(false);
    process.env.OMNIFORGE_LLM_CACHE = 'true';
    expect(isLlmCacheEnabled()).toBe(true);
    process.env.OMNIFORGE_LLM_CACHE = '1';
    expect(isLlmCacheEnabled()).toBe(false);
  });
});

describe('get/putCachedResponse', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE llm_response_cache (cache_key TEXT PRIMARY KEY, model TEXT NOT NULL, content TEXT NOT NULL, usage_json TEXT, created_at INTEGER NOT NULL, hit_count INTEGER NOT NULL DEFAULT 0);`);
  });
  afterEach(() => db.close());

  it('round-trips a stored response and increments hit_count', () => {
    const key = computeLlmCacheKey(BASE);
    expect(getCachedResponse(db, key)).toBeNull(); // miss before store
    putCachedResponse(db, key, BASE.model, 'cached output', { total_cost_usd: 0.01 });
    const hit = getCachedResponse(db, key);
    expect(hit?.content).toBe('cached output');
    expect(hit?.model).toBe(BASE.model);
    expect((hit?.usage as { total_cost_usd: number }).total_cost_usd).toBe(0.01);
    getCachedResponse(db, key);
    const n = (db.prepare('SELECT hit_count FROM llm_response_cache WHERE cache_key = ?').get(key) as { hit_count: number }).hit_count;
    expect(n).toBe(2);
  });

  it('treats an entry older than the TTL as a miss', () => {
    const key = computeLlmCacheKey(BASE);
    const longAgo = Date.now() - (48 * 60 * 60 * 1000); // 2 days
    putCachedResponse(db, key, BASE.model, 'old', null, longAgo);
    expect(getCachedResponse(db, key)).toBeNull(); // stale (default 24h TTL)
    expect(getCachedResponse(db, key, longAgo + 1000)).not.toBeNull(); // within TTL relative to its creation
  });
});
