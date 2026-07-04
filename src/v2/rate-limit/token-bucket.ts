/**
 * Token Bucket Rate Limiter
 *
 * Refactored from src/mcp/_rate-limit.ts for unified rate limiting.
 * Token-bucket semantics:
 *   - Each key gets a bucket of `burst` tokens (default = rpm).
 *   - Tokens refill at a rate of `rpm / 60` per second, continuously.
 *   - Each request costs 1 token.
 *   - Empty bucket → request is rejected with a Retry-After hint.
 */

import type {
  TokenBucket,
  RateLimitDecision,
  RateLimiterOptions,
  RateLimitMetrics,
} from './types.js';

export class TokenBucketLimiter {
  private readonly rpm: number;
  private readonly burst: number;
  private readonly tokensPerMs: number;
  private readonly buckets: Map<string, TokenBucket>;
  private readonly now: () => number;
  private readonly metrics: Map<string, RateLimitMetrics>;

  constructor(opts: RateLimiterOptions) {
    this.rpm = Math.max(1, opts.rpm);
    this.burst = Math.max(1, opts.burst ?? this.rpm);
    this.tokensPerMs = this.rpm / 60_000;
    this.buckets = new Map();
    this.metrics = new Map();
    this.now = opts.now ?? Date.now;
  }

  /**
   * Check if a request for the given key is allowed.
   * Consumes 1 token from the bucket if allowed.
   */
  check(key: string): RateLimitDecision {
    const currentMs = this.now();
    const existing = this.buckets.get(key);
    const bucket: TokenBucket = existing
      ? { ...existing }
      : { tokens: this.burst, lastRefillMs: currentMs };

    // Update metrics
    this.updateMetrics(key);

    // Refill: continuous accrual based on elapsed time.
    const elapsed = Math.max(0, currentMs - bucket.lastRefillMs);
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.tokensPerMs);
      bucket.lastRefillMs = currentMs;
    }

    if (bucket.tokens < 1) {
      // Time until 1 full token is back in the bucket.
      const deficit = 1 - bucket.tokens;
      const retryAfterMs = Math.ceil(deficit / this.tokensPerMs);
      this.buckets.set(key, bucket);
      this.recordDenial(key);
      return {
        allowed: false,
        retryAfterMs,
        remaining: 0,
        limit: this.rpm,
        windowMs: 60_000,
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    this.recordAllowance(key, Math.floor(bucket.tokens));
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      limit: this.rpm,
      windowMs: 60_000,
    };
  }

  /**
   * Get metrics for a specific key.
   */
  getMetrics(key: string): RateLimitMetrics {
    const metrics = this.metrics.get(key);
    if (!metrics) {
      return {
        totalChecks: 0,
        allowed: 0,
        denied: 0,
        remaining: this.burst,
        limit: this.rpm,
        lastCheckMs: this.now(),
      };
    }
    return { ...metrics };
  }

  /**
   * Reset the limiter for a specific key (useful for tests).
   */
  reset(key?: string): void {
    if (key) {
      this.buckets.delete(key);
      this.metrics.delete(key);
    } else {
      this.buckets.clear();
      this.metrics.clear();
    }
  }

  /**
   * Get the current bucket state for a key (test-only).
   */
  inspectBucket(key: string): TokenBucket | undefined {
    return this.buckets.get(key);
  }

  private updateMetrics(key: string): void {
    const existing = this.metrics.get(key);
    if (!existing) {
      this.metrics.set(key, {
        totalChecks: 1,
        allowed: 0,
        denied: 0,
        remaining: this.burst,
        limit: this.rpm,
        lastCheckMs: this.now(),
      });
      return;
    }
    existing.totalChecks += 1;
    existing.lastCheckMs = this.now();
  }

  private recordAllowance(key: string, remaining: number): void {
    const metrics = this.metrics.get(key);
    if (metrics) {
      metrics.allowed += 1;
      metrics.remaining = remaining;
    }
  }

  private recordDenial(key: string): void {
    const metrics = this.metrics.get(key);
    if (metrics) {
      metrics.denied += 1;
      metrics.remaining = 0;
    }
  }
}

/**
 * Factory function: creates a token-bucket limiter.
 * Returns a `check(key)` function for backward compatibility.
 */
export function createTokenBucketLimiter(
  opts: RateLimiterOptions,
): (key: string) => RateLimitDecision {
  const limiter = new TokenBucketLimiter(opts);
  const check = (key: string) => limiter.check(key);

  // Attach limiter instance for advanced usage
  (check as { __limiter__?: TokenBucketLimiter }).__limiter__ = limiter;

  return check;
}

/**
 * Test-only helper: returns the underlying limiter instance.
 */
export function __testing_getLimiter(
  check: (key: string) => RateLimitDecision,
): TokenBucketLimiter | null {
  const ref = (check as unknown as { __limiter__?: TokenBucketLimiter }).__limiter__;
  return ref ?? null;
}