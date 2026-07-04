/**
 * Health Status Cache Module
 * 
 * Caches OmniRoute health status with TTL to avoid excessive API calls.
 * Provides cached health data for failover decisions and dashboard visualization.
 */

import { checkDetailedHealth, type DetailedHealthResult, type HealthCheckResult } from './client.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_KEY = 'omniroute_health_status';

interface CacheEntry {
  data: DetailedHealthResult;
  timestamp: number;
  lastFetchAttempt: number;
  fetchSuccess: boolean;
}

let _cache: CacheEntry | null = null;
let _isRefreshing = false;

/**
 * Get cached health status if available and fresh
 */
export function getCachedHealth(): DetailedHealthResult | null {
  if (!_cache) return null;
  
  const now = Date.now();
  if (now - _cache.timestamp > CACHE_TTL_MS) {
    return null; // Cache expired
  }
  
  return _cache.data;
}

/**
 * Check if cache is stale (older than TTL)
 */
export function isCacheStale(): boolean {
  if (!_cache) return true;
  
  const now = Date.now();
  return now - _cache.timestamp > CACHE_TTL_MS;
}

/**
 * Get cache age in milliseconds
 */
export function getCacheAge(): number {
  if (!_cache) return 0;
  return Date.now() - _cache.timestamp;
}

/**
 * Refresh health status from OmniRoute
 * Uses background refresh to avoid blocking callers
 */
export async function refreshHealthStatus(): Promise<HealthCheckResult> {
  // Prevent concurrent refreshes
  if (_isRefreshing) {
    // If refresh is in progress, return current cache if available
    const cached = getCachedHealth();
    if (cached) {
      return { ok: true, data: cached };
    }
    // Otherwise wait for current refresh to complete
    await waitForRefreshComplete();
    const finalCached = getCachedHealth();
    return finalCached 
      ? { ok: true, data: finalCached }
      : { ok: false, error: 'Refresh failed' };
  }
  
  _isRefreshing = true;
  const now = Date.now();
  
  try {
    const result = await checkDetailedHealth();
    
    if (result.ok && result.data) {
      _cache = {
        data: result.data,
        timestamp: now,
        lastFetchAttempt: now,
        fetchSuccess: true,
      };
      return result;
    } else {
      // Update fetch attempt timestamp even on failure
      if (_cache) {
        _cache.lastFetchAttempt = now;
        _cache.fetchSuccess = false;
      } else {
        _cache = {
          data: result.data || {
            status: 'error',
            timestamp: new Date().toISOString(),
            providers: {},
            rate_limits: {},
          },
          timestamp: now,
          lastFetchAttempt: now,
          fetchSuccess: false,
        };
      }
      return result;
    }
  } finally {
    _isRefreshing = false;
  }
}

/**
 * Get health status with automatic cache refresh
 * Returns cached data if fresh, otherwise refreshes
 */
export async function getHealthStatus(forceRefresh = false): Promise<HealthCheckResult> {
  // If force refresh or cache is stale, refresh
  if (forceRefresh || isCacheStale()) {
    return await refreshHealthStatus();
  }
  
  // Return cached data
  const cached = getCachedHealth();
  if (cached) {
    return { ok: true, data: cached };
  }
  
  // Cache miss (shouldn't happen if logic is correct), refresh
  return await refreshHealthStatus();
}

/**
 * Wait for in-progress refresh to complete
 */
async function waitForRefreshComplete(): Promise<void> {
  const maxWait = 5000; // 5 seconds max wait
  const start = Date.now();
  
  while (_isRefreshing && Date.now() - start < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Get cache statistics for monitoring
 */
export function getCacheStats() {
  return {
    hasCache: _cache !== null,
    cacheAge: _cache ? getCacheAge() : 0,
    isStale: isCacheStale(),
    isRefreshing: _isRefreshing,
    lastFetchAttempt: _cache?.lastFetchAttempt || 0,
    fetchSuccess: _cache?.fetchSuccess || false,
    ttl: CACHE_TTL_MS,
  };
}

/**
 * Clear cache (useful for testing or manual refresh)
 */
export function clearCache(): void {
  _cache = null;
}

/**
 * Initialize cache with seed data (useful for startup)
 */
export function seedCache(data: DetailedHealthResult): void {
  _cache = {
    data,
    timestamp: Date.now(),
    lastFetchAttempt: Date.now(),
    fetchSuccess: true,
  };
}