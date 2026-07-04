/**
 * Sliding Window Rate Limiter
 *
 * Tracks request count within a sliding time window.
 * Suitable for rate limiting LLM streams and continuous API calls.
 * More precise than token-bucket for short-term burst protection.
 */

import type {
  SlidingWindowCounter,
  RateLimitDecision,
  SlidingWindowOptions,
  RateLimitMetrics,
} from './types.js';

export class SlidingWindowLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly windows: Map<string, SlidingWindowCounter>;
  private readonly now: () => number;
  private readonly metrics: Map<string, RateLimitMetrics>;

  constructor(opts: SlidingWindowOptions) {
    this.maxRequests = Math.max(1, opts.maxRequests);
    this.windowMs = Math.max(1, opts.windowMs);
    this.windows = new Map();
    this.metrics = new Map();
    this.now = opts.now ?? Date.now;
  }

  /**
   * Check if a request for the given key is allowed.
   * Slides the window forward based on current time.
   */
  check(key: string): RateLimitDecision {
    const currentMs = this.now();
    const existing = this.windows.get(key);

    // Update metrics
    this.updateMetrics(key);

    if (!existing) {
      // First request in this window
      this.windows.set(key, {
        count: 1,
        windowStartMs: currentMs,
      });
      this.recordAllowance(key, this.maxRequests - 1);
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        limit: this.maxRequests,
        windowMs: this.windowMs,
      };
    }

    // Check if the window has expired
    const elapsed = currentMs - existing.windowStartMs;
    if (elapsed >= this.windowMs) {
      // Window expired, start fresh
      this.windows.set(key, {
        count: 1,
        windowStartMs: currentMs,
      });
      this.recordAllowance(key, this.maxRequests - 1);
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        limit: this.maxRequests,
        windowMs: this.windowMs,
      };
    }

    // Window still active, check capacity
    if (existing.count >= this.maxRequests) {
      const retryAfterMs = this.windowMs - elapsed;
      this.recordDenial(key);
      return {
        allowed: false,
        retryAfterMs,
        remaining: 0,
        limit: this.maxRequests,
        windowMs: this.windowMs,
      };
    }

    // Increment count
    existing.count += 1;
    this.windows.set(key, existing);
    this.recordAllowance(key, this.maxRequests - existing.count);
    return {
      allowed: true,
      remaining: this.maxRequests - existing.count,
      limit: this.maxRequests,
      windowMs: this.windowMs,
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
        remaining: this.maxRequests,
        limit: this.maxRequests,
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
      this.windows.delete(key);
      this.metrics.delete(key);
    } else {
      this.windows.clear();
      this.metrics.clear();
    }
  }

  /**
   * Get the current window state for a key (test-only).
   */
  inspectWindow(key: string): SlidingWindowCounter | undefined {
    return this.windows.get(key);
  }

  private updateMetrics(key: string): void {
    const existing = this.metrics.get(key);
    if (!existing) {
      this.metrics.set(key, {
        totalChecks: 1,
        allowed: 0,
        denied: 0,
        remaining: this.maxRequests,
        limit: this.maxRequests,
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
 * Factory function: creates a sliding-window limiter.
 * Returns a `check(key)` function for consistency with token-bucket.
 */
export function createSlidingWindowLimiter(
  opts: SlidingWindowOptions,
): (key: string) => RateLimitDecision {
  const limiter = new SlidingWindowLimiter(opts);
  const check = (key: string) => limiter.check(key);

  // Attach limiter instance for advanced usage
  (check as { __limiter__?: SlidingWindowLimiter }).__limiter__ = limiter;

  return check;
}

/**
 * Test-only helper: returns the underlying limiter instance.
 */
export function __testing_getLimiter(
  check: (key: string) => RateLimitDecision,
): SlidingWindowLimiter | null {
  const ref = (check as unknown as { __limiter__?: SlidingWindowLimiter }).__limiter__;
  return ref ?? null;
}