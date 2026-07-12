/**
 * Unit tests for OmniRoute failover module (Sprint 3)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  failoverManager,
  evaluateAndCheckFailover,
  isFailoverActive,
  shouldAllowOmniRouteRequest,
  getFailoverState,
  type FailoverConfig,
  type FailoverState,
} from '../../src/v2/omniroute-bridge/failover.js';

// Mock dependencies
vi.mock('../../src/v2/omniroute-bridge/health-cache.js', () => ({
  getCachedHealth: vi.fn(),
  getCacheStats: vi.fn(() => ({
    hasCache: true,
    cacheAge: 1000,
    isStale: false,
    isRefreshing: false,
    lastFetchAttempt: Date.now(),
    fetchSuccess: true,
    ttl: 300000,
  })),
}));

vi.mock('../../src/v2/omniroute-bridge/client.js', async (importOriginal) => ({
  // tallyProviderHealth é um helper puro — usa a implementação real; só a
  // chamada de rede é mockada.
  tallyProviderHealth: (await importOriginal<typeof import('../../src/v2/omniroute-bridge/client.js')>()).tallyProviderHealth,
  checkDetailedHealth: vi.fn(),
}));

vi.mock('../../src/v2/observability/log-aggregation.js', () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

import { getCachedHealth } from '../../src/v2/omniroute-bridge/health-cache.js';
import { checkDetailedHealth } from '../../src/v2/omniroute-bridge/client.js';

describe('OmniRoute Failover Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failoverManager.reset();
  });

  describe('Failover State Management', () => {
    it('should start with failover inactive', () => {
      const state = getFailoverState();
      expect(state.isFailoverActive).toBe(false);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.currentHealthStatus).toBe('unknown');
    });

    it('should manually activate failover', () => {
      failoverManager.manualActivateFailover();
      const state = getFailoverState();
      expect(state.isFailoverActive).toBe(true);
      expect(state.failoverActivatedAt).not.toBeNull();
    });

    it('should manually deactivate failover', () => {
      failoverManager.manualActivateFailover();
      failoverManager.manualDeactivateFailover();
      const state = getFailoverState();
      expect(state.isFailoverActive).toBe(false);
      expect(state.consecutiveFailures).toBe(0);
    });

    it('should reset failover state', () => {
      failoverManager.manualActivateFailover();
      failoverManager.reset();
      const state = getFailoverState();
      expect(state.isFailoverActive).toBe(false);
      expect(state.consecutiveFailures).toBe(0);
      expect(state.failureHistory).toEqual([]);
    });
  });

  describe('Request Allowance Logic', () => {
    it('should allow requests when failover is inactive', () => {
      expect(shouldAllowOmniRouteRequest()).toBe(true);
    });

    it('should allow requests when failover is active and failOpen is true', () => {
      failoverManager.updateConfig({ failOpen: true });
      failoverManager.manualActivateFailover();
      expect(shouldAllowOmniRouteRequest()).toBe(true);
    });

    it('should block requests when failover is active and failOpen is false', () => {
      failoverManager.updateConfig({ failOpen: false });
      failoverManager.manualActivateFailover();
      expect(shouldAllowOmniRouteRequest()).toBe(false);
    });
  });

  describe('Failover Evaluation', () => {
    it('should not trigger failover on healthy status', async () => {
      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: { status: 'healthy', latency_ms: 500, last_check: new Date().toISOString() },
          openai: { status: 'healthy', latency_ms: 800, last_check: new Date().toISOString() },
        },
        rate_limits: {},
      });

      const result = await evaluateAndCheckFailover();
      expect(result.shouldFailover).toBe(false);
      expect(result.state.isFailoverActive).toBe(false);
    });

    it('should not trigger failover on degraded status', async () => {
      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: { status: 'healthy', latency_ms: 500, last_check: new Date().toISOString() },
          openai: { status: 'degraded', latency_ms: 2000, last_check: new Date().toISOString() },
        },
        rate_limits: {},
      });

      const result = await evaluateAndCheckFailover();
      expect(result.shouldFailover).toBe(false);
      expect(result.state.currentHealthStatus).toBe('degraded');
    });

    it('should trigger failover on unhealthy status', async () => {
      // Set lower threshold for this test
      failoverManager.updateConfig({ failureThreshold: 1 });

      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: { status: 'unhealthy', latency_ms: 5000, last_check: new Date().toISOString() },
          openai: { status: 'unhealthy', latency_ms: 5000, last_check: new Date().toISOString() },
        },
        rate_limits: {},
      });

      const result = await evaluateAndCheckFailover();
      expect(result.shouldFailover).toBe(true);
      expect(result.state.isFailoverActive).toBe(true);

      // Reset threshold
      failoverManager.updateConfig({ failureThreshold: 3 });
    });

    it('should trigger failover after consecutive failures', async () => {
      vi.mocked(getCachedHealth).mockReturnValue(null);
      vi.mocked(checkDetailedHealth).mockResolvedValue({
        ok: false,
        data: {
          status: 'error',
          timestamp: new Date().toISOString(),
          providers: {},
          rate_limits: {},
        },
        error: 'Connection refused',
      });

      // Simulate multiple failures
      for (let i = 0; i < 3; i++) {
        await evaluateAndCheckFailover();
      }

      const state = getFailoverState();
      expect(state.isFailoverActive).toBe(true);
      expect(state.consecutiveFailures).toBeGreaterThanOrEqual(3);
    });

    it('should reset consecutive failures on health recovery', async () => {
      // First, trigger failover
      vi.mocked(getCachedHealth).mockReturnValue(null);
      vi.mocked(checkDetailedHealth).mockResolvedValue({
        ok: false,
        data: {
          status: 'error',
          timestamp: new Date().toISOString(),
          providers: {},
          rate_limits: {},
        },
        error: 'Connection refused',
      });

      for (let i = 0; i < 3; i++) {
        await evaluateAndCheckFailover();
      }

      let state = getFailoverState();
      expect(state.consecutiveFailures).toBeGreaterThan(0);

      // Then, recover
      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: { status: 'healthy', latency_ms: 500, last_check: new Date().toISOString() },
        },
        rate_limits: {},
      });

      await evaluateAndCheckFailover();
      state = getFailoverState();
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('Configuration', () => {
    beforeEach(() => {
      // Reset config to defaults before each test
      failoverManager.updateConfig({
        failureThreshold: 3,
        failureWindowMs: 5 * 60 * 1000,
        minHealthPercentage: 50,
        failOpen: true,
        retryAfterMs: 60 * 1000,
      });
    });

    it('should use default configuration', () => {
      const stats = failoverManager.getStats();
      expect(stats.config.failureThreshold).toBe(3);
      expect(stats.config.failureWindowMs).toBe(5 * 60 * 1000);
      expect(stats.config.minHealthPercentage).toBe(50);
      expect(stats.config.failOpen).toBe(true);
    });

    it('should update configuration', () => {
      failoverManager.updateConfig({
        failureThreshold: 5,
        failOpen: false,
      });

      const stats = failoverManager.getStats();
      expect(stats.config.failureThreshold).toBe(5);
      expect(stats.config.failOpen).toBe(false);
    });
  });

  describe('Statistics', () => {
    it('should return failover statistics', () => {
      failoverManager.manualActivateFailover();
      const stats = failoverManager.getStats();

      expect(stats.isFailoverActive).toBe(true);
      expect(stats.failoverActivatedAt).not.toBeNull();
      expect(stats.timeSinceFailoverActivation).toBeGreaterThanOrEqual(0);
      expect(stats.config).toBeDefined();
      expect(stats.cacheStats).toBeDefined();
    });
  });

  describe('Health Status Determination', () => {
    it('should determine healthy status when all providers are healthy', async () => {
      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: { status: 'healthy', latency_ms: 500, last_check: new Date().toISOString() },
          openai: { status: 'healthy', latency_ms: 800, last_check: new Date().toISOString() },
        },
        rate_limits: {},
      });

      await evaluateAndCheckFailover();
      const state = getFailoverState();
      expect(state.currentHealthStatus).toBe('healthy');
    });

    it('should determine degraded status when some providers are degraded', async () => {
      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: { status: 'healthy', latency_ms: 500, last_check: new Date().toISOString() },
          openai: { status: 'degraded', latency_ms: 2000, last_check: new Date().toISOString() },
        },
        rate_limits: {},
      });

      await evaluateAndCheckFailover();
      const state = getFailoverState();
      expect(state.currentHealthStatus).toBe('degraded');
    });

    it('should determine unhealthy status when majority are unhealthy', async () => {
      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: { status: 'unhealthy', latency_ms: 5000, last_check: new Date().toISOString() },
          openai: { status: 'unhealthy', latency_ms: 5000, last_check: new Date().toISOString() },
          anthropic: { status: 'healthy', latency_ms: 500, last_check: new Date().toISOString() },
        },
        rate_limits: {},
      });

      await evaluateAndCheckFailover();
      const state = getFailoverState();
      expect(state.currentHealthStatus).toBe('unhealthy');
    });

    it('should determine unhealthy when overall status is error', async () => {
      vi.mocked(getCachedHealth).mockReturnValue({
        status: 'error',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      });

      await evaluateAndCheckFailover();
      const state = getFailoverState();
      expect(state.currentHealthStatus).toBe('unhealthy');
    });
  });
});