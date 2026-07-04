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

export class AdaptiveLimiter {
  private readonly baseRpm: number;
  private readonly burstMultiplier: number;
  private readonly syncIntervalMs: number;
  private readonly now: () => number;
  private limiter: TokenBucketLimiter;
  private currentRpm: number;
  private lastSyncMs: number;
  private omniRouteLimits: Map<string, OmniRouteRateLimitInfo>;
  private metrics: Map<string, RateLimitMetrics>;

  constructor(opts: AdaptiveLimiterOptions) {
    this.baseRpm = Math.max(1, opts.baseRpm);
    this.burstMultiplier = opts.burstMultiplier ?? 1;
    this.syncIntervalMs = opts.syncIntervalMs ?? 60_000; // Default 1 minute
    this.now = opts.now ?? Date.now;

    this.currentRpm = this.baseRpm;
    this.limiter = new TokenBucketLimiter({
      rpm: this.currentRpm,
      burst: Math.floor(this.currentRpm * this.burstMultiplier),
      now: this.now,
    });

    this.lastSyncMs = this.now();
    this.omniRouteLimits = new Map();
    this.metrics = new Map();
  }

  /**
   * Check if a request for the given key is allowed.
   * Automatically syncs with OmniRoute if sync interval has passed.
   */
  check(key: string): RateLimitDecision {
    // Auto-sync if interval has passed
    const currentMs = this.now();
    if (currentMs - this.lastSyncMs >= this.syncIntervalMs) {
      this.syncLimits();
      this.lastSyncMs = currentMs;
    }

    // Update metrics
    this.updateMetrics(key);

    // Delegate to token-bucket limiter
    const decision = this.limiter.check(key);

    // Update metrics based on decision
    if (decision.allowed) {
      this.recordAllowance(key, decision.remaining ?? 0);
    } else {
      this.recordDenial(key);
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
      this.limiter = new TokenBucketLimiter({
        rpm: this.currentRpm,
        burst: Math.floor(this.currentRpm * this.burstMultiplier),
        now: this.now,
      });
    }
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
        remaining: this.currentRpm,
        limit: this.currentRpm,
        lastCheckMs: this.now(),
      };
    }
    return { ...metrics };
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
    this.limiter = new TokenBucketLimiter({
      rpm: this.currentRpm,
      burst: Math.floor(this.currentRpm * this.burstMultiplier),
      now: this.now,
    });
    this.lastSyncMs = this.now();
    this.omniRouteLimits.clear();
    this.metrics.clear();
  }

  /**
   * Force a sync with OmniRoute (called by config sync).
   */
  private syncLimits(): void {
    // In a real implementation, this would fetch from OmniRoute health endpoint
    // For now, we rely on updateOmniRouteLimit() being called externally
    // This is a no-op placeholder for future enhancement
  }

  private updateMetrics(key: string): void {
    const existing = this.metrics.get(key);
    if (!existing) {
      this.metrics.set(key, {
        totalChecks: 1,
        allowed: 0,
        denied: 0,
        remaining: this.currentRpm,
        limit: this.currentRpm,
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
 * Factory function: creates an adaptive limiter.
 */
export function createAdaptiveLimiter(opts: AdaptiveLimiterOptions): AdaptiveLimiter {
  return new AdaptiveLimiter(opts);
}