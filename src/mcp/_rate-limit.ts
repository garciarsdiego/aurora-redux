// M1 / Wave 1-E (A8 — security perimeter):
// Generic token-bucket rate limiter for HTTP routes that face the public
// internet (webhooks) or untrusted callers.
//
// Token-bucket semantics:
//   - Each key gets a bucket of `burst` tokens (default = rpm).
//   - Tokens refill at a rate of `rpm / 60` per second, continuously.
//   - Each request costs 1 token.
//   - Empty bucket → request is rejected with a Retry-After hint.
//
// This is intentionally process-local (Map-based). The daemon is single-node
// today; if/when we shard, we will swap this for a Redis-backed implementation
// behind the same `createRateLimiter` factory.
//
// Memory safety: the bucket Map grows with the cardinality of `key`. For
// webhook slugs this is bounded by MAX_ACTIVE_WEBHOOKS (=50) so we do not
// bother with explicit eviction. If a caller passes a high-cardinality key
// (e.g., source IP from the open internet) it should pre-filter or wire a
// max-size LRU before calling this factory.

export interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
  remaining?: number;
}

export interface RateLimiterOptions {
  /** Requests per minute when the bucket is at steady state. */
  rpm: number;
  /** Max bucket size (initial token count). Defaults to `rpm` so a fresh
   *  bucket allows a single-minute burst at the steady-state rate. */
  burst?: number;
  /** Optional clock injection — primarily for tests. */
  now?: () => number;
}

/**
 * Factory: returns a `check(key)` function that consumes 1 token from the
 * bucket associated with `key` and reports whether the request is allowed.
 *
 * The returned function captures its own `buckets` Map so multiple
 * limiters do not share state. This makes the limiter trivially testable
 * (one per `describe` block) and keeps per-route limits independent.
 */
export function createRateLimiter(opts: RateLimiterOptions): (key: string) => RateLimitDecision {
  const rpm = Math.max(1, opts.rpm);
  const burst = Math.max(1, opts.burst ?? rpm);
  const tokensPerMs = rpm / 60_000;
  const buckets = new Map<string, TokenBucket>();
  const now = opts.now ?? Date.now;

  return function check(key: string): RateLimitDecision {
    const currentMs = now();
    const existing = buckets.get(key);
    const bucket: TokenBucket = existing
      ? { ...existing }
      : { tokens: burst, lastRefillMs: currentMs };

    // Refill: continuous accrual based on elapsed time.
    const elapsed = Math.max(0, currentMs - bucket.lastRefillMs);
    if (elapsed > 0) {
      bucket.tokens = Math.min(burst, bucket.tokens + elapsed * tokensPerMs);
      bucket.lastRefillMs = currentMs;
    }

    if (bucket.tokens < 1) {
      // Time until 1 full token is back in the bucket.
      const deficit = 1 - bucket.tokens;
      const retryAfterMs = Math.ceil(deficit / tokensPerMs);
      buckets.set(key, bucket);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  };
}

/**
 * Test-only helper: returns the underlying Map. Production code should not
 * import this — it is exported solely so unit tests can assert eviction
 * behavior without reaching into private state.
 */
export function __testing_inspect_buckets(
  check: (key: string) => RateLimitDecision,
): Map<string, TokenBucket> | null {
  const ref = (check as unknown as { __buckets__?: Map<string, TokenBucket> }).__buckets__;
  return ref ?? null;
}
