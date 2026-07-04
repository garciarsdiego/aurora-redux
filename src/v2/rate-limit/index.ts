/**
 * Unified Rate Limiting Module
 *
 * Sprint 7: Rate Limit Unification between Aurora and OmniRoute
 *
 * This module provides a unified rate limiting system that supports:
 * - Token-bucket limiters (for webhooks, API endpoints)
 * - Sliding-window limiters (for LLM streams, continuous calls)
 * - Adaptive limiters (syncs with OmniRoute's reported limits)
 * - Configuration sync between Aurora and OmniRoute
 * - Comprehensive metrics and monitoring
 *
 * @example
 * ```ts
 * import { registerLimiter, checkRateLimit } from './v2/rate-limit/index.js';
 *
 * // Register a webhook limiter
 * registerLimiter('webhooks', {
 *   type: 'token-bucket',
 *   rpm: 10,
 *   burst: 15,
 * });
 *
 * // Check a request
 * const decision = checkRateLimit('webhooks', 'webhook-slug-123');
 * if (!decision.allowed) {
 *   console.log(`Rate limited. Retry after ${decision.retryAfterMs}ms`);
 * }
 * ```
 */

// Import global singletons for convenience API
import { getGlobalRegistry } from './registry.js';
import { getGlobalConfigSync } from './config-sync.js';
import { getGlobalMetricsCollector } from './metrics.js';

// Types
export type {
  TokenBucket,
  SlidingWindowCounter,
  RateLimitDecision,
  RateLimiterOptions,
  SlidingWindowOptions,
  AdaptiveLimiterOptions,
  RateLimitConfig,
  RateLimitMetrics,
  OmniRouteRateLimitInfo,
  RateLimitRegistryEntry,
} from './types.js';

// Token Bucket
export {
  TokenBucketLimiter,
  createTokenBucketLimiter,
  __testing_getLimiter as __testing_getTokenBucketLimiter,
} from './token-bucket.js';

// Sliding Window
export {
  SlidingWindowLimiter,
  createSlidingWindowLimiter,
  __testing_getLimiter as __testing_getSlidingWindowLimiter,
} from './sliding-window.js';

// Adaptive
export {
  AdaptiveLimiter,
  createAdaptiveLimiter,
} from './adaptive-limiter.js';

// Config Sync
export {
  RateLimitConfigSync,
  getGlobalConfigSync,
  __testing_resetGlobalConfigSync,
} from './config-sync.js';
export type { ConfigSyncOptions } from './config-sync.js';

// Metrics
export {
  RateLimitMetricsCollector,
  getGlobalMetricsCollector,
  __testing_resetGlobalMetricsCollector,
} from './metrics.js';
export type { AggregatedMetrics } from './metrics.js';

// Registry
export {
  RateLimitRegistry,
  getGlobalRegistry,
  __testing_resetGlobalRegistry,
} from './registry.js';

// Convenience API (using global registry)

/**
 * Register a rate limiter with the global registry.
 */
export function registerLimiter(name: string, config: import('./types.js').RateLimitConfig): void {
  const registry = getGlobalRegistry();
  registry.register(name, config);
}

/**
 * Unregister a rate limiter from the global registry.
 */
export function unregisterLimiter(name: string): void {
  const registry = getGlobalRegistry();
  registry.unregister(name);
}

/**
 * Check if a request is allowed for the named limiter.
 */
export function checkRateLimit(
  name: string,
  key: string,
): import('./types.js').RateLimitDecision {
  const registry = getGlobalRegistry();
  return registry.check(name, key);
}

/**
 * Get metrics for a specific limiter.
 */
export function getLimiterMetrics(name: string): import('./types.js').RateLimitMetrics | null {
  const registry = getGlobalRegistry();
  return registry.getMetrics(name);
}

/**
 * Get configuration for a specific limiter.
 */
export function getLimiterConfig(name: string): import('./types.js').RateLimitConfig | null {
  const registry = getGlobalRegistry();
  return registry.getConfig(name);
}

/**
 * Get all registered limiter names.
 */
export function getLimiterNames(): string[] {
  const registry = getGlobalRegistry();
  return registry.getLimiterNames();
}

/**
 * Check if a limiter is registered.
 */
export function hasLimiter(name: string): boolean {
  const registry = getGlobalRegistry();
  return registry.has(name);
}

/**
 * Start the global config sync (for adaptive limiters).
 */
export function startConfigSync(opts?: import('./config-sync.js').ConfigSyncOptions): void {
  const sync = getGlobalConfigSync(opts);
  sync.start();
}

/**
 * Stop the global config sync.
 */
export function stopConfigSync(): void {
  const sync = getGlobalConfigSync();
  sync.stop();
}

/**
 * Get aggregated metrics across all limiters.
 */
export function getAggregatedMetrics(): import('./metrics.js').AggregatedMetrics {
  const collector = getGlobalMetricsCollector();
  return collector.getAggregatedMetrics();
}

// Backward compatibility: re-export the old createRateLimiter
// This maintains compatibility with existing webhook code
import { createTokenBucketLimiter } from './token-bucket.js';
import type { RateLimiterOptions } from './types.js';

/**
 * Legacy compatibility: creates a token-bucket limiter.
 * Use registerLimiter() for new code.
 *
 * @deprecated Use registerLimiter() with type: 'token-bucket' instead.
 */
export function createRateLimiter(opts: RateLimiterOptions): (key: string) => import('./types.js').RateLimitDecision {
  return createTokenBucketLimiter(opts);
}