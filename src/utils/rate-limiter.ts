import { parsedNumber, optional } from './config.js';

export interface RateLimiterConfig {
  maxTokens: number;
  refillRate: number;
  refillIntervalMs: number;
}

export interface RateLimiterState {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiterResult {
  allowed: boolean;
  tokensLeft: number;
  retryAfterMs: number;
}

export class TokenBucketRateLimiter {
  private state: RateLimiterState;
  private config: RateLimiterConfig;

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = {
      maxTokens: config?.maxTokens ?? getMaxTokens(),
      refillRate: config?.refillRate ?? getRefillRate(),
      refillIntervalMs: config?.refillIntervalMs ?? getRefillIntervalMs(),
    };
    this.state = {
      tokens: this.config.maxTokens,
      lastRefill: Date.now(),
    };
  }

  refill(): void {
    const now = Date.now();
    const elapsed = now - this.state.lastRefill;
    const intervals = Math.floor(elapsed / this.config.refillIntervalMs);
    if (intervals > 0) {
      this.state.tokens = Math.min(
        this.config.maxTokens,
        this.state.tokens + intervals * this.config.refillRate,
      );
      this.state.lastRefill = now;
    }
  }

  tryConsume(tokens: number = 1): RateLimiterResult {
    this.refill();
    if (this.state.tokens >= tokens) {
      this.state.tokens -= tokens;
      return { allowed: true, tokensLeft: this.state.tokens, retryAfterMs: 0 };
    }
    const tokensNeeded = tokens - this.state.tokens;
    const intervalsNeeded = Math.ceil(tokensNeeded / this.config.refillRate);
    const retryAfterMs = intervalsNeeded * this.config.refillIntervalMs;
    return {
      allowed: false,
      tokensLeft: this.state.tokens,
      retryAfterMs,
    };
  }

  availableTokens(): number {
    this.refill();
    return this.state.tokens;
  }
}

const buckets = new Map<string, TokenBucketRateLimiter>();

function getMaxTokens(): number {
  return parsedNumber('OMNIFORGE_RATE_LIMIT_MAX_TOKENS', 60);
}

function getRefillRate(): number {
  return parsedNumber('OMNIFORGE_RATE_LIMIT_REFILL_RATE', 1);
}

function getRefillIntervalMs(): number {
  return parsedNumber('OMNIFORGE_RATE_LIMIT_REFILL_INTERVAL_MS', 1_000);
}

export function getRateLimitEnabled(): boolean {
  const val = optional('OMNIFORGE_RATE_LIMIT_ENABLED', 'true').trim().toLowerCase();
  return val === 'true' || val === '1';
}

export function getRateLimitBucket(workspace: string): TokenBucketRateLimiter {
  let bucket = buckets.get(workspace);
  if (!bucket) {
    bucket = new TokenBucketRateLimiter();
    buckets.set(workspace, bucket);
  }
  return bucket;
}

export function checkRateLimit(workspace: string, cost: number = 1): RateLimiterResult {
  if (!getRateLimitEnabled()) {
    return { allowed: true, tokensLeft: Infinity, retryAfterMs: 0 };
  }
  const bucket = getRateLimitBucket(workspace);
  return bucket.tryConsume(Math.ceil(cost));
}

export class RateLimitError extends Error {
  public readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super(`Rate limit exceeded. Retry after ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export function getRateLimiterMetrics(): Record<string, { tokens: number }> {
  const metrics: Record<string, { tokens: number }> = {};
  for (const [workspace, bucket] of buckets) {
    metrics[workspace] = { tokens: bucket.availableTokens() };
  }
  return metrics;
}
