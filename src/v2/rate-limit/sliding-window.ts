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
import { MetricsTracker } from './metrics-tracker.js';

export class SlidingWindowLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly windows: Map<string, SlidingWindowCounter>;
  private readonly now: () => number;
  private readonly tracker: MetricsTracker;

  constructor(opts: SlidingWindowOptions) {
    this.maxRequests = Math.max(1, opts.maxRequests);
    this.windowMs = Math.max(1, opts.windowMs);
    this.windows = new Map();
    this.now = opts.now ?? Date.now;
    this.tracker = new MetricsTracker(this.now, () => ({
      remaining: this.maxRequests,
      limit: this.maxRequests,
    }));
  }

  /**
   * Check if a request for the given key is allowed.
   * Slides the window forward based on current time.
   */
  check(key: string): RateLimitDecision {
    const currentMs = this.now();
    const existing = this.windows.get(key);

    // Update metrics
    this.tracker.check(key);

    // New window: first request for this key, or the previous window expired
    if (!existing || currentMs - existing.windowStartMs >= this.windowMs) {
      this.windows.set(key, {
        count: 1,
        windowStartMs: currentMs,
      });
      this.tracker.allow(key, this.maxRequests - 1);
      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        limit: this.maxRequests,
        windowMs: this.windowMs,
      };
    }

    // Window still active, check capacity
    const elapsed = currentMs - existing.windowStartMs;
    if (existing.count >= this.maxRequests) {
      const retryAfterMs = this.windowMs - elapsed;
      this.tracker.deny(key);
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
    this.tracker.allow(key, this.maxRequests - existing.count);
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
    return this.tracker.get(key);
  }

  /**
   * Reset the limiter for a specific key (useful for tests).
   */
  reset(key?: string): void {
    if (key) {
      this.windows.delete(key);
    } else {
      this.windows.clear();
    }
    this.tracker.reset(key);
  }

  /**
   * Get the current window state for a key (test-only).
   */
  inspectWindow(key: string): SlidingWindowCounter | undefined {
    return this.windows.get(key);
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