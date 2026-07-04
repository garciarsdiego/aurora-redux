/**
 * Unified Rate Limiting Types
 *
 * Sprint 7: Rate Limit Unification between Aurora and OmniRoute
 * Supports multiple limiter types: token-bucket, sliding-window, adaptive
 */

export interface TokenBucket {
  tokens: number;
  lastRefillMs: number;
}

export interface SlidingWindowCounter {
  count: number;
  windowStartMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
  remaining?: number;
  limit?: number;
  windowMs?: number;
}

export interface RateLimiterOptions {
  /** Requests per minute when the bucket is at steady state. */
  rpm: number;
  /** Max bucket size (initial token count). Defaults to `rpm`. */
  burst?: number;
  /** Optional clock injection — primarily for tests. */
  now?: () => number;
}

export interface SlidingWindowOptions {
  /** Maximum requests in the time window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Optional clock injection — primarily for tests. */
  now?: () => number;
}

export interface AdaptiveLimiterOptions {
  /** Base RPM to use when OmniRoute limits are unavailable. */
  baseRpm: number;
  /** Burst capacity multiplier. */
  burstMultiplier?: number;
  /** How often to sync with OmniRoute (ms). */
  syncIntervalMs?: number;
  /** Optional clock injection. */
  now?: () => number;
}

export interface RateLimitConfig {
  /** Limiter type: 'token-bucket' | 'sliding-window' | 'adaptive' */
  type: 'token-bucket' | 'sliding-window' | 'adaptive';
  /** RPM for token-bucket and adaptive limiters. */
  rpm?: number;
  /** Max requests for sliding-window limiters. */
  maxRequests?: number;
  /** Window duration for sliding-window limiters (ms). */
  windowMs?: number;
  /** Burst capacity for token-bucket limiters. */
  burst?: number;
  /** Whether this limiter syncs with OmniRoute. */
  syncWithOmniRoute?: boolean;
}

export interface RateLimitMetrics {
  /** Total requests checked. */
  totalChecks: number;
  /** Total requests allowed. */
  allowed: number;
  /** Total requests denied. */
  denied: number;
  /** Current remaining capacity. */
  remaining: number;
  /** Current limit. */
  limit: number;
  /** Timestamp of last check. */
  lastCheckMs: number;
}

export interface OmniRouteRateLimitInfo {
  endpoint: string;
  remaining: number;
  resetIn: number; // seconds
}

export interface RateLimitRegistryEntry {
  name: string;
  limiter: (key: string) => RateLimitDecision;
  config: RateLimitConfig;
  metrics: RateLimitMetrics;
  createdAt: number;
}