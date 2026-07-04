/**
 * Rate Limit Registry
 *
 * Central registry for all rate limiters in the system.
 * Provides unified access to limiters and their configurations.
 */

import type {
  RateLimitConfig,
  RateLimitDecision,
  RateLimitRegistryEntry,
  RateLimiterOptions,
  SlidingWindowOptions,
  AdaptiveLimiterOptions,
} from './types.js';
import { createTokenBucketLimiter } from './token-bucket.js';
import { createSlidingWindowLimiter } from './sliding-window.js';
import { createAdaptiveLimiter } from './adaptive-limiter.js';
import { getGlobalConfigSync } from './config-sync.js';
import { getGlobalMetricsCollector } from './metrics.js';

export class RateLimitRegistry {
  private readonly limiters: Map<string, RateLimitRegistryEntry>;
  private readonly configSync: ReturnType<typeof getGlobalConfigSync>;
  private readonly metricsCollector: ReturnType<typeof getGlobalMetricsCollector>;

  constructor() {
    this.limiters = new Map();
    this.configSync = getGlobalConfigSync();
    this.metricsCollector = getGlobalMetricsCollector();
  }

  /**
   * Register a new rate limiter with the given name and configuration.
   */
  register(name: string, config: RateLimitConfig): void {
    if (this.limiters.has(name)) {
      throw new Error(`Rate limiter '${name}' is already registered`);
    }

    const limiter = this.createLimiter(config);
    const entry: RateLimitRegistryEntry = {
      name,
      limiter,
      config,
      metrics: {
        totalChecks: 0,
        allowed: 0,
        denied: 0,
        remaining: config.rpm ?? config.maxRequests ?? 0,
        limit: config.rpm ?? config.maxRequests ?? 0,
        lastCheckMs: Date.now(),
      },
      createdAt: Date.now(),
    };

    this.limiters.set(name, entry);
    this.metricsCollector.register(entry);

    // If adaptive, register with config sync
    if (config.type === 'adaptive' && config.syncWithOmniRoute) {
      const adaptiveLimiter = (limiter as unknown as { __limiter__?: { updateOmniRouteLimit: (info: any) => void } }).__limiter__;
      if (adaptiveLimiter && 'updateOmniRouteLimit' in adaptiveLimiter) {
        this.configSync.registerLimiter(adaptiveLimiter as any);
      }
    }
  }

  /**
   * Unregister a rate limiter.
   */
  unregister(name: string): void {
    const entry = this.limiters.get(name);
    if (!entry) {
      return;
    }

    // Unregister from config sync if adaptive
    if (entry.config.type === 'adaptive' && entry.config.syncWithOmniRoute) {
      const adaptiveLimiter = (entry.limiter as unknown as { __limiter__?: any }).__limiter__;
      if (adaptiveLimiter) {
        this.configSync.unregisterLimiter(adaptiveLimiter);
      }
    }

    this.limiters.delete(name);
    this.metricsCollector.unregister(name);
  }

  /**
   * Check if a request is allowed for the named limiter.
   */
  check(name: string, key: string): RateLimitDecision {
    const entry = this.limiters.get(name);
    if (!entry) {
      throw new Error(`Rate limiter '${name}' is not registered`);
    }

    const decision = entry.limiter(key);

    // Update metrics in the entry
    entry.metrics.totalChecks += 1;
    if (decision.allowed) {
      entry.metrics.allowed += 1;
    } else {
      entry.metrics.denied += 1;
    }
    entry.metrics.remaining = decision.remaining ?? 0;
    entry.metrics.lastCheckMs = Date.now();

    return decision;
  }

  /**
   * Get metrics for a specific limiter.
   */
  getMetrics(name: string) {
    const entry = this.limiters.get(name);
    if (!entry) {
      return null;
    }
    return entry.metrics;
  }

  /**
   * Get configuration for a specific limiter.
   */
  getConfig(name: string): RateLimitConfig | null {
    const entry = this.limiters.get(name);
    if (!entry) {
      return null;
    }
    return entry.config;
  }

  /**
   * Get all registered limiter names.
   */
  getLimiterNames(): string[] {
    return Array.from(this.limiters.keys());
  }

  /**
   * Check if a limiter is registered.
   */
  has(name: string): boolean {
    return this.limiters.has(name);
  }

  /**
   * Get the number of registered limiters.
   */
  size(): number {
    return this.limiters.size;
  }

  /**
   * Clear all limiters (test-only).
   */
  clear(): void {
    for (const name of this.limiters.keys()) {
      this.unregister(name);
    }
  }

  /**
   * Create a limiter function based on configuration.
   */
  private createLimiter(config: RateLimitConfig): (key: string) => RateLimitDecision {
    switch (config.type) {
      case 'token-bucket':
        return createTokenBucketLimiter({
          rpm: config.rpm ?? 60,
          burst: config.burst,
        } as RateLimiterOptions);

      case 'sliding-window':
        return createSlidingWindowLimiter({
          maxRequests: config.maxRequests ?? 60,
          windowMs: config.windowMs ?? 60_000,
        } as SlidingWindowOptions);

      case 'adaptive':
        const adaptiveLimiter = createAdaptiveLimiter({
          baseRpm: config.rpm ?? 60,
          burstMultiplier: config.burst ? config.burst / (config.rpm ?? 60) : 1,
        } as AdaptiveLimiterOptions);

        // Attach limiter instance for config sync
        const checkWrapper = (key: string) => adaptiveLimiter.check(key);
        (checkWrapper as { __limiter__?: any }).__limiter__ = adaptiveLimiter;

        return checkWrapper;

      default:
        throw new Error(`Unknown limiter type: ${(config as { type: string }).type}`);
    }
  }
}

/**
 * Global registry instance (singleton pattern).
 */
let globalRegistry: RateLimitRegistry | null = null;

/**
 * Get or create the global rate limit registry.
 */
export function getGlobalRegistry(): RateLimitRegistry {
  if (!globalRegistry) {
    globalRegistry = new RateLimitRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global registry (test-only).
 */
export function __testing_resetGlobalRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clear();
    globalRegistry = null;
  }
}