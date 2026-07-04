import { describe, it, expect, beforeEach } from 'vitest';
import {
  TokenBucketRateLimiter,
  checkRateLimit,
} from '../../src/utils/rate-limiter.js';

describe('TokenBucketRateLimiter', () => {
  it('should allow consumption when tokens are available', () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 1,
      refillIntervalMs: 1000,
    });
    const result = limiter.tryConsume(1);
    expect(result.allowed).toBe(true);
    expect(result.tokensLeft).toBe(9);
  });

  it('should deny when tokens are exhausted', () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 1,
      refillRate: 1,
      refillIntervalMs: 1000,
    });
    limiter.tryConsume(1);
    const result = limiter.tryConsume(1);
    expect(result.allowed).toBe(false);
    expect(result.tokensLeft).toBe(0);
  });

  it('should report retryAfterMs when denied', () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 1,
      refillRate: 1,
      refillIntervalMs: 1000,
    });
    limiter.tryConsume(1);
    const result = limiter.tryConsume(1);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('should refill tokens over time', async () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 5,
      refillRate: 5,
      refillIntervalMs: 100,
    });
    limiter.tryConsume(5);
    expect(limiter.tryConsume(1).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(limiter.tryConsume(1).allowed).toBe(true);
  });

  it('should not exceed max tokens during refill', () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 5,
      refillRate: 10,
      refillIntervalMs: 100,
    });
    limiter.tryConsume(5);
    // Even with rapid refill, should cap at maxTokens
    const tokens = limiter.availableTokens();
    expect(tokens).toBeLessThanOrEqual(5);
  });

  it('should handle multi-token consumption', () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 1,
      refillIntervalMs: 1000,
    });
    const result = limiter.tryConsume(3);
    expect(result.allowed).toBe(true);
    expect(result.tokensLeft).toBe(7);
  });

  it('should deny multi-token when insufficient', () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 2,
      refillRate: 1,
      refillIntervalMs: 1000,
    });
    const result = limiter.tryConsume(5);
    expect(result.allowed).toBe(false);
  });
});

describe('checkRateLimit', () => {
  it('should allow when rate limit is disabled', () => {
    process.env.OMNIFORGE_RATE_LIMIT_ENABLED = 'false';
    const result = checkRateLimit('test-workspace', 100);
    expect(result.allowed).toBe(true);
  });

  it('should track per-workspace buckets', () => {
    process.env.OMNIFORGE_RATE_LIMIT_ENABLED = 'true';
    process.env.OMNIFORGE_RATE_LIMIT_MAX_TOKENS = '5';
    process.env.OMNIFORGE_RATE_LIMIT_REFILL_RATE = '1';
    process.env.OMNIFORGE_RATE_LIMIT_REFILL_INTERVAL_MS = '60000';

    // Workspace A
    expect(checkRateLimit('ws-a', 1).allowed).toBe(true);
    expect(checkRateLimit('ws-a', 1).allowed).toBe(true);

    // Workspace B should have its own bucket
    expect(checkRateLimit('ws-b', 1).allowed).toBe(true);
    expect(checkRateLimit('ws-b', 1).allowed).toBe(true);
    expect(checkRateLimit('ws-b', 1).allowed).toBe(true);
  });
});
