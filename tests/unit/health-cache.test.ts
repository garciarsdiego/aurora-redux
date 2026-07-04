/**
 * Unit tests for OmniRoute health cache module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getCachedHealth,
  isCacheStale,
  getCacheAge,
  getCacheStats,
  clearCache,
  seedCache,
} from '../../../src/v2/omniroute-bridge/health-cache';
import type { DetailedHealthResult } from '../../../src/v2/omniroute-bridge/client';

// Mock the client module to avoid dependency
vi.mock('../../../src/v2/omniroute-bridge/client', () => ({
  checkDetailedHealth: vi.fn(),
}));

describe('Health Cache Module', () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    clearCache();
  });

  describe('getCachedHealth', () => {
    it('should return null when cache is empty', () => {
      const result = getCachedHealth();
      expect(result).toBeNull();
    });

    it('should return cached data when fresh', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {
          claude: {
            status: 'healthy',
            latency_ms: 500,
            last_check: new Date().toISOString(),
          },
        },
        rate_limits: {
          claude: {
            remaining: 95,
            reset_in: 3600,
          },
        },
      };

      seedCache(mockData);
      const result = getCachedHealth();
      expect(result).toEqual(mockData);
    });
  });

  describe('isCacheStale', () => {
    it('should return true when cache is empty', () => {
      expect(isCacheStale()).toBe(true);
    });

    it('should return false when cache is fresh', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      };

      seedCache(mockData);
      expect(isCacheStale()).toBe(false);
    });

    it('should handle cache age calculation', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      };

      seedCache(mockData);
      const age = getCacheAge();
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(100); // Should be very fresh
    });
  });

  describe('getCacheAge', () => {
    it('should return 0 when cache is empty', () => {
      expect(getCacheAge()).toBe(0);
    });

    it('should return correct age for cached data', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      };

      seedCache(mockData);
      const age = getCacheAge();
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(100); // Should be very fresh
    });
  });

  describe('seedCache', () => {
    it('should initialize cache with seed data', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      };

      seedCache(mockData);
      const result = getCachedHealth();
      expect(result).toEqual(mockData);
    });

    it('should set fetchSuccess to true', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      };

      seedCache(mockData);
      const stats = getCacheStats();
      expect(stats.fetchSuccess).toBe(true);
    });
  });

  describe('clearCache', () => {
    it('should clear the cache', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      };

      seedCache(mockData);
      expect(getCachedHealth()).not.toBeNull();

      clearCache();
      expect(getCachedHealth()).toBeNull();
    });
  });

  describe('getCacheStats', () => {
    it('should return correct stats when cache is empty', () => {
      const stats = getCacheStats();
      expect(stats).toEqual({
        hasCache: false,
        cacheAge: 0,
        isStale: true,
        isRefreshing: false,
        lastFetchAttempt: 0,
        fetchSuccess: false,
        ttl: 5 * 60 * 1000, // 5 minutes
      });
    });

    it('should return correct stats when cache has data', () => {
      const mockData: DetailedHealthResult = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
      };

      seedCache(mockData);
      const stats = getCacheStats();
      expect(stats.hasCache).toBe(true);
      expect(stats.isStale).toBe(false);
      expect(stats.fetchSuccess).toBe(true);
      expect(stats.lastFetchAttempt).toBeGreaterThan(0);
    });
  });
});