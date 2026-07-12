/**
 * Adaptive Rate Limiter
 *
 * Syncs with OmniRoute's reported rate limits and adapts accordingly.
 * Falls back to base RPM when OmniRoute limits are unavailable.
 * Automatically adjusts limits based on upstream feedback.
 */

import type {
  RateLimitDecision,
  AdaptiveLimiterOptions,
  RateLimitMetrics,
  OmniRouteRateLimitInfo,
} from './types.js';
import { TokenBucketLimiter } from './token-bucket.js';
import { MetricsTracker } from './metrics-tracker.js';

export class AdaptiveLimiter {
  private readonly baseRpm: number;
  private readonly burstMultiplier: number;
  private readonly now: () => number;
  private limiter: TokenBucketLimiter;
  private currentRpm: number;
  private omniRouteLimits: Map<string, OmniRouteRateLimitInfo>;
  private tracker: MetricsTracker;

  constructor(opts: AdaptiveLimiterOptions) {
    this.baseRpm = Math.max(1, opts.baseRpm);
    this.burstMultiplier = opts.burstMultiplier ?? 1;
    this.now = opts.now ?? Date.now;

    this.currentRpm = this.baseRpm;
    this.limiter = this.buildLimiter();

    this.omniRouteLimits = new Map();
    this.tracker = new MetricsTracker(this.now, () => ({
      remaining: this.currentRpm,
      limit: this.currentRpm,
    }));
  }

  /**
   * Build a token-bucket limiter sized for the current adaptive RPM.
   */
  private buildLimiter(): TokenBucketLimiter {
    return new TokenBucketLimiter({
      rpm: this.currentRpm,
      burst: Math.floor(this.currentRpm * this.burstMultiplier),
      now: this.now,
    });
  }

  /**
   * Check if a request for the given key is allowed.
   * Note: limits are pushed externally via updateOmniRouteLimit()
   * (see config-sync.ts) — there is no self-sync on check.
   */
  check(key: string): RateLimitDecision {
    // Update metrics
    this.tracker.check(key);

    // Delegate to token-bucket limiter
    const decision = this.limiter.check(key);

    // Update metrics based on decision
    if (decision.allowed) {
      this.tracker.allow(key, decision.remaining ?? 0);
    } else {
      this.tracker.deny(key);
    }

    // Add adaptive metadata
    return {
      ...decision,
      limit: this.currentRpm,
    };
  }

  /**
   * Update OmniRoute rate limit information.
   * Called by the config sync mechanism.
   */
  updateOmniRouteLimit(info: OmniRouteRateLimitInfo): void {
    this.omniRouteLimits.set(info.endpoint, info);

    // Calculate adaptive RPM based on OmniRoute limits
    // If OmniRoute reports remaining < 20, reduce our local limit
    const allLimits = Array.from(this.omniRouteLimits.values());
    if (allLimits.length > 0) {
      const minRemaining = Math.min(
        ...allLimits.map((l) => l.remaining),
      );

      if (minRemaining < 20) {
        // Reduce limit to 50% of base when OmniRoute is running low
        this.currentRpm = Math.max(1, Math.floor(this.baseRpm * 0.5));
      } else if (minRemaining < 50) {
        // Reduce limit to 75% of base when OmniRoute is mid-range
        this.currentRpm = Math.max(1, Math.floor(this.baseRpm * 0.75));
      } else {
        // Use base RPM when OmniRoute is healthy
        this.currentRpm = this.baseRpm;
      }

      // Update underlying limiter with new RPM
      this.limiter = this.buildLimiter();
    }
  }

  /**
   * Get metrics for a specific key.
   */
  getMetrics(key: string): RateLimitMetrics {
    return this.tracker.get(key);
  }

  /**
   * Get current adaptive RPM.
   */
  getCurrentRpm(): number {
    return this.currentRpm;
  }

  /**
   * Get stored OmniRoute limits.
   */
  getOmniRouteLimits(): Map<string, OmniRouteRateLimitInfo> {
    return new Map(this.omniRouteLimits);
  }

  /**
   * Reset the limiter (useful for tests).
   */
  reset(): void {
    this.currentRpm = this.baseRpm;
    this.limiter = this.buildLimiter();
    this.omniRouteLimits.clear();
    this.tracker.reset();
  }
}

/**
 * Factory function: creates an adaptive limiter.
 */
export function createAdaptiveLimiter(opts: AdaptiveLimiterOptions): AdaptiveLimiter {
  return new AdaptiveLimiter(opts);
}