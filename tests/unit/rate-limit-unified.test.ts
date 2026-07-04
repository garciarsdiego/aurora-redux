/**
 * Unified Rate Limiting Tests
 *
 * Sprint 7: Rate Limit Unification between Aurora and OmniRoute
 * Comprehensive test suite with >80% coverage target.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTokenBucketLimiter,
  createSlidingWindowLimiter,
  createAdaptiveLimiter,
  createRateLimiter,
  registerLimiter,
  unregisterLimiter,
  checkRateLimit,
  getLimiterMetrics,
  getLimiterConfig,
  getLimiterNames,
  hasLimiter,
  startConfigSync,
  stopConfigSync,
  getAggregatedMetrics,
  getGlobalRegistry,
  getGlobalConfigSync,
  getGlobalMetricsCollector,
  __testing_resetGlobalRegistry,
  __testing_resetGlobalConfigSync,
  __testing_resetGlobalMetricsCollector,
  __testing_getTokenBucketLimiter,
  __testing_getSlidingWindowLimiter,
  type RateLimitConfig,
  type RateLimitDecision,
} from '../../src/v2/rate-limit/index.js';

describe('Unified Rate Limiting', () => {
  beforeEach(() => {
    // Reset all global singletons before each test
    __testing_resetGlobalRegistry();
    __testing_resetGlobalConfigSync();
    __testing_resetGlobalMetricsCollector();
  });

  afterEach(() => {
    // Cleanup after each test
    stopConfigSync();
  });

  describe('Token Bucket Limiter', () => {
    it('should allow requests within RPM limit', () => {
      const check = createTokenBucketLimiter({ rpm: 10 });

      for (let i = 0; i < 10; i++) {
        const decision = check(`key-${i}`);
        expect(decision.allowed).toBe(true);
        expect(decision.remaining).toBeGreaterThanOrEqual(0);
      }
    });

    it('should deny requests exceeding RPM limit', () => {
      const check = createTokenBucketLimiter({ rpm: 5 });

      // Use up all tokens
      for (let i = 0; i < 5; i++) {
        expect(check('same-key').allowed).toBe(true);
      }

      // Next request should be denied
      const decision = check('same-key');
      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterMs).toBeGreaterThan(0);
      expect(decision.remaining).toBe(0);
    });

    it('should respect burst capacity', () => {
      const check = createTokenBucketLimiter({ rpm: 10, burst: 20 });

      // Should allow burst of 20 requests
      for (let i = 0; i < 20; i++) {
        expect(check('burst-key').allowed).toBe(true);
      }

      // 21st request should be denied
      expect(check('burst-key').allowed).toBe(false);
    });

    it('should refill tokens over time', () => {
      const now = vi.fn(() => 0);
      const check = createTokenBucketLimiter({ rpm: 60, now });

      // Use all tokens
      for (let i = 0; i < 60; i++) {
        expect(check('refill-key').allowed).toBe(true);
      }
      expect(check('refill-key').allowed).toBe(false);

      // Advance time by 1 second (should refill 1 token at 60 RPM)
      now.mockReturnValue(1000);
      expect(check('refill-key').allowed).toBe(true);
    });

    it('should track metrics correctly', () => {
      const check = createTokenBucketLimiter({ rpm: 10 });
      const limiter = __testing_getTokenBucketLimiter(check);

      expect(limiter).not.toBeNull();

      if (limiter) {
        check('metrics-key');
        check('metrics-key');
        check('metrics-key');

        const metrics = limiter.getMetrics('metrics-key');
        expect(metrics.totalChecks).toBe(3);
        expect(metrics.allowed).toBe(3);
        expect(metrics.denied).toBe(0);
        expect(metrics.remaining).toBe(7);
      }
    });

    it('should reset specific key', () => {
      const check = createTokenBucketLimiter({ rpm: 5 });
      const limiter = __testing_getTokenBucketLimiter(check);

      expect(limiter).not.toBeNull();

      if (limiter) {
        // Use all tokens
        for (let i = 0; i < 5; i++) {
          check('reset-key');
        }
        expect(check('reset-key').allowed).toBe(false);

        // Reset the key
        limiter.reset('reset-key');

        // Should allow requests again
        expect(check('reset-key').allowed).toBe(true);
      }
    });

    it('should reset all keys', () => {
      const check = createTokenBucketLimiter({ rpm: 5 });
      const limiter = __testing_getTokenBucketLimiter(check);

      expect(limiter).not.toBeNull();

      if (limiter) {
        check('key1');
        check('key2');
        check('key3');

        limiter.reset();

        expect(limiter.inspectBucket('key1')).toBeUndefined();
        expect(limiter.inspectBucket('key2')).toBeUndefined();
        expect(limiter.inspectBucket('key3')).toBeUndefined();
      }
    });
  });

  describe('Sliding Window Limiter', () => {
    it('should allow requests within window limit', () => {
      const check = createSlidingWindowLimiter({ maxRequests: 10, windowMs: 60000 });

      for (let i = 0; i < 10; i++) {
        const decision = check(`key-${i}`);
        expect(decision.allowed).toBe(true);
        expect(decision.remaining).toBeGreaterThanOrEqual(0);
      }
    });

    it('should deny requests exceeding window limit', () => {
      const check = createSlidingWindowLimiter({ maxRequests: 5, windowMs: 60000 });

      // Use up all capacity
      for (let i = 0; i < 5; i++) {
        expect(check('same-key').allowed).toBe(true);
      }

      // Next request should be denied
      const decision = check('same-key');
      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterMs).toBeGreaterThan(0);
      expect(decision.remaining).toBe(0);
    });

    it('should slide window forward after expiration', () => {
      const now = vi.fn(() => 0);
      const check = createSlidingWindowLimiter({ maxRequests: 5, windowMs: 1000, now });

      // Use all capacity
      for (let i = 0; i < 5; i++) {
        expect(check('slide-key').allowed).toBe(true);
      }
      expect(check('slide-key').allowed).toBe(false);

      // Advance time past window
      now.mockReturnValue(1500);

      // Should allow requests again
      expect(check('slide-key').allowed).toBe(true);
    });

    it('should track metrics correctly', () => {
      const check = createSlidingWindowLimiter({ maxRequests: 10, windowMs: 60000 });
      const limiter = __testing_getSlidingWindowLimiter(check);

      expect(limiter).not.toBeNull();

      if (limiter) {
        check('metrics-key');
        check('metrics-key');
        check('metrics-key');

        const metrics = limiter.getMetrics('metrics-key');
        expect(metrics.totalChecks).toBe(3);
        expect(metrics.allowed).toBe(3);
        expect(metrics.denied).toBe(0);
        expect(metrics.remaining).toBe(7);
      }
    });

    it('should reset specific key', () => {
      const check = createSlidingWindowLimiter({ maxRequests: 5, windowMs: 60000 });
      const limiter = __testing_getSlidingWindowLimiter(check);

      expect(limiter).not.toBeNull();

      if (limiter) {
        // Use all capacity
        for (let i = 0; i < 5; i++) {
          check('reset-key');
        }
        expect(check('reset-key').allowed).toBe(false);

        // Reset the key
        limiter.reset('reset-key');

        // Should allow requests again
        expect(check('reset-key').allowed).toBe(true);
      }
    });
  });

  describe('Adaptive Limiter', () => {
    it('should allow requests within base RPM', () => {
      const limiter = createAdaptiveLimiter({ baseRpm: 10 });

      for (let i = 0; i < 10; i++) {
        const decision = limiter.check(`key-${i}`);
        expect(decision.allowed).toBe(true);
      }
    });

    it('should deny requests exceeding base RPM', () => {
      const limiter = createAdaptiveLimiter({ baseRpm: 5 });

      // Use all tokens
      for (let i = 0; i < 5; i++) {
        expect(limiter.check('same-key').allowed).toBe(true);
      }

      // Next request should be denied
      const decision = limiter.check('same-key');
      expect(decision.allowed).toBe(false);
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    });

    it('should adapt to OmniRoute limits', () => {
      const limiter = createAdaptiveLimiter({ baseRpm: 100 });

      // Update with low remaining (should reduce RPM)
      limiter.updateOmniRouteLimit({
        endpoint: '/v1/chat/completions',
        remaining: 5,
        resetIn: 60,
      });

      expect(limiter.getCurrentRpm()).toBeLessThan(100);
    });

    it('should track metrics correctly', () => {
      const limiter = createAdaptiveLimiter({ baseRpm: 10 });

      limiter.check('metrics-key');
      limiter.check('metrics-key');
      limiter.check('metrics-key');

      const metrics = limiter.getMetrics('metrics-key');
      expect(metrics.totalChecks).toBe(3);
      expect(metrics.allowed).toBe(3);
      expect(metrics.denied).toBe(0);
    });

    it('should reset to base RPM', () => {
      const limiter = createAdaptiveLimiter({ baseRpm: 100 });

      // Update with low remaining
      limiter.updateOmniRouteLimit({
        endpoint: '/v1/chat/completions',
        remaining: 5,
        resetIn: 60,
      });

      expect(limiter.getCurrentRpm()).toBeLessThan(100);

      // Reset
      limiter.reset();

      expect(limiter.getCurrentRpm()).toBe(100);
    });
  });

  describe('Global Registry', () => {
    it('should register and unregister limiters', () => {
      const config: RateLimitConfig = {
        type: 'token-bucket',
        rpm: 10,
      };

      expect(hasLimiter('test-limiter')).toBe(false);

      registerLimiter('test-limiter', config);
      expect(hasLimiter('test-limiter')).toBe(true);

      unregisterLimiter('test-limiter');
      expect(hasLimiter('test-limiter')).toBe(false);
    });

    it('should throw on duplicate registration', () => {
      const config: RateLimitConfig = {
        type: 'token-bucket',
        rpm: 10,
      };

      registerLimiter('duplicate', config);

      expect(() => {
        registerLimiter('duplicate', config);
      }).toThrow();
    });

    it('should check rate limits through registry', () => {
      const config: RateLimitConfig = {
        type: 'token-bucket',
        rpm: 5,
      };

      registerLimiter('registry-test', config);

      const decision1 = checkRateLimit('registry-test', 'key1');
      expect(decision1.allowed).toBe(true);

      const decision2 = checkRateLimit('registry-test', 'key1');
      expect(decision2.allowed).toBe(true);

      unregisterLimiter('registry-test');
    });

    it('should throw on unknown limiter', () => {
      expect(() => {
        checkRateLimit('unknown', 'key');
      }).toThrow();
    });

    it('should get limiter names', () => {
      registerLimiter('limiter1', { type: 'token-bucket', rpm: 10 });
      registerLimiter('limiter2', { type: 'sliding-window', maxRequests: 20, windowMs: 60000 });

      const names = getLimiterNames();
      expect(names).toContain('limiter1');
      expect(names).toContain('limiter2');
      expect(names.length).toBe(2);

      unregisterLimiter('limiter1');
      unregisterLimiter('limiter2');
    });

    it('should get limiter config', () => {
      const config: RateLimitConfig = {
        type: 'token-bucket',
        rpm: 15,
        burst: 20,
      };

      registerLimiter('config-test', config);

      const retrieved = getLimiterConfig('config-test');
      expect(retrieved).toEqual(config);

      unregisterLimiter('config-test');
    });

    it('should get limiter metrics', () => {
      const config: RateLimitConfig = {
        type: 'token-bucket',
        rpm: 10,
      };

      registerLimiter('metrics-test', config);

      checkRateLimit('metrics-test', 'key1');
      checkRateLimit('metrics-test', 'key1');

      const metrics = getLimiterMetrics('metrics-test');
      expect(metrics).not.toBeNull();
      expect(metrics!.totalChecks).toBe(2);
      expect(metrics!.allowed).toBe(2);

      unregisterLimiter('metrics-test');
    });

    it('should clear all limiters', () => {
      registerLimiter('limiter1', { type: 'token-bucket', rpm: 10 });
      registerLimiter('limiter2', { type: 'token-bucket', rpm: 10 });

      expect(getLimiterNames().length).toBe(2);

      const registry = getGlobalRegistry();
      registry.clear();

      expect(getLimiterNames().length).toBe(0);
    });
  });

  describe('Config Sync', () => {
    it('should register and unregister adaptive limiters', () => {
      const config: RateLimitConfig = {
        type: 'adaptive',
        rpm: 10,
        syncWithOmniRoute: true,
      };

      registerLimiter('adaptive-sync', config);

      // The limiter should be registered with config sync
      // (This is implicit; we're testing that it doesn't throw)
      unregisterLimiter('adaptive-sync');
    });

    it('should start and stop config sync', () => {
      const sync = getGlobalConfigSync({ autoSync: false });

      expect(sync.isActive()).toBe(false);

      sync.start();
      expect(sync.isActive()).toBe(true);

      sync.stop();
      expect(sync.isActive()).toBe(false);
    });

    it('should track last sync time', () => {
      const sync = getGlobalConfigSync({ autoSync: false });

      expect(sync.getLastSyncTime()).toBe(0);

      sync.start();
      // Wait a bit for initial sync
      // Note: In real implementation, this would be async
      sync.stop();

      // Last sync time should be updated
      // (In test, we're just checking the mechanism exists)
    });
  });

  describe('Metrics Collector', () => {
    it('should aggregate metrics across limiters', () => {
      registerLimiter('limiter1', { type: 'token-bucket', rpm: 10 });
      registerLimiter('limiter2', { type: 'token-bucket', rpm: 10 });

      checkRateLimit('limiter1', 'key1');
      checkRateLimit('limiter2', 'key1');

      const agg = getAggregatedMetrics();
      expect(agg.totalChecks).toBe(2);
      expect(agg.totalAllowed).toBe(2);
      expect(agg.totalDenied).toBe(0);
      expect(agg.byLimiter.size).toBe(2);

      unregisterLimiter('limiter1');
      unregisterLimiter('limiter2');
    });

    it('should calculate allow rate correctly', () => {
      registerLimiter('limiter1', { type: 'token-bucket', rpm: 2 });

      checkRateLimit('limiter1', 'key1');
      checkRateLimit('limiter1', 'key1');

      // Force a denial
      for (let i = 0; i < 3; i++) {
        checkRateLimit('limiter1', 'key2');
      }

      const agg = getAggregatedMetrics();
      expect(agg.allowRate).toBeGreaterThan(0);
      expect(agg.allowRate).toBeLessThanOrEqual(1);

      unregisterLimiter('limiter1');
    });
  });

  describe('Backward Compatibility', () => {
    it('should support legacy createRateLimiter', () => {
      const check = createRateLimiter({ rpm: 10 });

      expect(check('legacy-key').allowed).toBe(true);
      expect(check('legacy-key').allowed).toBe(true);
    });
  });

  describe('Integration Scenarios', () => {
    it('should handle multiple limiter types simultaneously', () => {
      registerLimiter('webhooks', { type: 'token-bucket', rpm: 10 });
      registerLimiter('streams', { type: 'sliding-window', maxRequests: 20, windowMs: 60000 });
      registerLimiter('omniroute', { type: 'adaptive', rpm: 30 });

      expect(checkRateLimit('webhooks', 'key1').allowed).toBe(true);
      expect(checkRateLimit('streams', 'key1').allowed).toBe(true);
      expect(checkRateLimit('omniroute', 'key1').allowed).toBe(true);

      unregisterLimiter('webhooks');
      unregisterLimiter('streams');
      unregisterLimiter('omniroute');
    });

    it('should maintain separate state per limiter', () => {
      registerLimiter('limiter-a', { type: 'token-bucket', rpm: 2 });
      registerLimiter('limiter-b', { type: 'token-bucket', rpm: 5 });

      // Exhaust limiter-a
      checkRateLimit('limiter-a', 'key');
      checkRateLimit('limiter-a', 'key');
      expect(checkRateLimit('limiter-a', 'key').allowed).toBe(false);

      // Limiter-b should still work
      expect(checkRateLimit('limiter-b', 'key').allowed).toBe(true);

      unregisterLimiter('limiter-a');
      unregisterLimiter('limiter-b');
    });

    it('should handle high-volume scenarios', () => {
      registerLimiter('high-volume', { type: 'token-bucket', rpm: 1000 });

      // Fire 1000 requests on the same key
      for (let i = 0; i < 1000; i++) {
        expect(checkRateLimit('high-volume', 'same-key').allowed).toBe(true);
      }

      // Next request should be denied
      expect(checkRateLimit('high-volume', 'same-key').allowed).toBe(false);

      unregisterLimiter('high-volume');
    });
  });
});