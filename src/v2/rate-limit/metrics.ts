/**
 * Rate Limit Metrics
 *
 * Collects and aggregates metrics from all rate limiters.
 * Provides monitoring and observability for rate limiting behavior.
 */

import type { RateLimitMetrics, RateLimitRegistryEntry } from './types.js';

export interface AggregatedMetrics {
  /** Total checks across all limiters. */
  totalChecks: number;
  /** Total allowed requests across all limiters. */
  totalAllowed: number;
  /** Total denied requests across all limiters. */
  totalDenied: number;
  /** Overall allow rate (0-1). */
  allowRate: number;
  /** Metrics per limiter. */
  byLimiter: Map<string, RateLimitMetrics>;
  /** Timestamp of aggregation. */
  timestamp: number;
}

export class RateLimitMetricsCollector {
  private readonly entries: Map<string, RateLimitRegistryEntry>;

  constructor() {
    this.entries = new Map();
  }

  /**
   * Register a rate limiter for metrics collection.
   */
  register(entry: RateLimitRegistryEntry): void {
    this.entries.set(entry.name, entry);
  }

  /**
   * Unregister a rate limiter.
   */
  unregister(name: string): void {
    this.entries.delete(name);
  }

  /**
   * Get metrics for a specific limiter.
   */
  getLimiterMetrics(name: string): RateLimitMetrics | null {
    const entry = this.entries.get(name);
    if (!entry) {
      return null;
    }
    return entry.metrics;
  }

  /**
   * Get aggregated metrics across all limiters.
   */
  getAggregatedMetrics(): AggregatedMetrics {
    let totalChecks = 0;
    let totalAllowed = 0;
    let totalDenied = 0;
    const byLimiter = new Map<string, RateLimitMetrics>();

    for (const [name, entry] of this.entries) {
      const metrics = entry.metrics;
      totalChecks += metrics.totalChecks;
      totalAllowed += metrics.allowed;
      totalDenied += metrics.denied;
      byLimiter.set(name, { ...metrics });
    }

    const allowRate = totalChecks > 0 ? totalAllowed / totalChecks : 0;

    return {
      totalChecks,
      totalAllowed,
      totalDenied,
      allowRate,
      byLimiter,
      timestamp: Date.now(),
    };
  }

  /**
   * Get a summary string for logging/monitoring.
   */
  getSummary(): string {
    const agg = this.getAggregatedMetrics();
    return JSON.stringify({
      total_checks: agg.totalChecks,
      total_allowed: agg.totalAllowed,
      total_denied: agg.totalDenied,
      allow_rate: `${(agg.allowRate * 100).toFixed(2)}%`,
      limiters: Array.from(this.entries.keys()),
    });
  }

  /**
   * Reset all metrics (test-only).
   */
  reset(): void {
    this.entries.clear();
  }
}

/**
 * Global metrics collector instance (singleton pattern).
 */
let globalMetricsCollector: RateLimitMetricsCollector | null = null;

/**
 * Get or create the global metrics collector.
 */
export function getGlobalMetricsCollector(): RateLimitMetricsCollector {
  if (!globalMetricsCollector) {
    globalMetricsCollector = new RateLimitMetricsCollector();
  }
  return globalMetricsCollector;
}

/**
 * Reset the global metrics collector (test-only).
 */
export function __testing_resetGlobalMetricsCollector(): void {
  globalMetricsCollector = null;
}