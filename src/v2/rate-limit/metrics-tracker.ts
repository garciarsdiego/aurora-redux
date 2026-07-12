/**
 * Internal per-key metrics tracker shared by the rate limiters.
 *
 * Encapsulates the Map<string, RateLimitMetrics> bookkeeping that the
 * token-bucket, sliding-window, and adaptive limiters all need.
 * Internal helper only — intentionally not exported from the package index.
 */

import type { RateLimitMetrics } from './types.js';

export class MetricsTracker {
  private readonly metrics: Map<string, RateLimitMetrics>;
  private readonly now: () => number;
  /** Resolved lazily so limiters with dynamic limits (adaptive) stay accurate. */
  private readonly defaults: () => { remaining: number; limit: number };

  constructor(now: () => number, defaults: () => { remaining: number; limit: number }) {
    this.metrics = new Map();
    this.now = now;
    this.defaults = defaults;
  }

  /**
   * Record a check for the key, creating the metrics entry on first use.
   */
  check(key: string): void {
    const existing = this.metrics.get(key);
    if (!existing) {
      const { remaining, limit } = this.defaults();
      this.metrics.set(key, {
        totalChecks: 1,
        allowed: 0,
        denied: 0,
        remaining,
        limit,
        lastCheckMs: this.now(),
      });
      return;
    }
    existing.totalChecks += 1;
    existing.lastCheckMs = this.now();
  }

  /**
   * Record an allowed request and the remaining capacity.
   */
  allow(key: string, remaining: number): void {
    const metrics = this.metrics.get(key);
    if (metrics) {
      metrics.allowed += 1;
      metrics.remaining = remaining;
    }
  }

  /**
   * Record a denied request.
   */
  deny(key: string): void {
    const metrics = this.metrics.get(key);
    if (metrics) {
      metrics.denied += 1;
      metrics.remaining = 0;
    }
  }

  /**
   * Get a copy of the metrics for a key (fresh defaults when unseen).
   */
  get(key: string): RateLimitMetrics {
    const metrics = this.metrics.get(key);
    if (!metrics) {
      const { remaining, limit } = this.defaults();
      return {
        totalChecks: 0,
        allowed: 0,
        denied: 0,
        remaining,
        limit,
        lastCheckMs: this.now(),
      };
    }
    return { ...metrics };
  }

  /**
   * Reset metrics for a key, or for all keys when omitted.
   */
  reset(key?: string): void {
    if (key) {
      this.metrics.delete(key);
    } else {
      this.metrics.clear();
    }
  }
}
