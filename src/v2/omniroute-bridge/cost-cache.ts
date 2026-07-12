/**
 * Cost Data Cache Module
 *
 * Caches cost synchronization data to avoid excessive API calls to OmniRoute.
 * Provides cached cost reports and sync status for dashboard visualization.
 */

import type { OmniRouteCostReport, CostSyncResponse } from './cost-sync.js';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SYNC_STATUS_TTL_MS = 60 * 1000; // 1 minute for sync status

interface CostReportCacheEntry {
  data: OmniRouteCostReport;
  timestamp: number;
  lastFetchAttempt: number;
  fetchSuccess: boolean;
}

interface SyncStatusCacheEntry {
  data: CostSyncResponse;
  timestamp: number;
  workflowId: string;
}

let _costReportCache: CostReportCacheEntry | null = null;

const _syncStatusCache = new Map<string, SyncStatusCacheEntry>();
const _isSyncing = new Set<string>();

// ── Cost Report Cache ─────────────────────────────────────────────────────

/**
 * Get cached cost report if available and fresh
 */
export function getCachedCostReport(): OmniRouteCostReport | null {
  if (!_costReportCache) return null;

  const now = Date.now();
  if (now - _costReportCache.timestamp > CACHE_TTL_MS) {
    return null; // Cache expired
  }

  return _costReportCache.data;
}

/**
 * Check if cost report cache is stale
 */
export function isCostReportCacheStale(): boolean {
  if (!_costReportCache) return true;

  const now = Date.now();
  return now - _costReportCache.timestamp > CACHE_TTL_MS;
}

/**
 * Get cost report cache age in milliseconds
 */
export function getCostReportCacheAge(): number {
  if (!_costReportCache) return 0;
  return Date.now() - _costReportCache.timestamp;
}

/**
 * Update cost report cache
 */
export function updateCostReportCache(data: OmniRouteCostReport, success = true): void {
  _costReportCache = {
    data,
    timestamp: Date.now(),
    lastFetchAttempt: Date.now(),
    fetchSuccess: success,
  };
}

/**
 * Clear cost report cache
 */
export function clearCostReportCache(): void {
  _costReportCache = null;
}

// ── Sync Status Cache ────────────────────────────────────────────────────

/**
 * Get cached sync status for a workflow
 */
export function getCachedSyncStatus(workflowId: string): CostSyncResponse | null {
  const entry = _syncStatusCache.get(workflowId);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.timestamp > SYNC_STATUS_TTL_MS) {
    _syncStatusCache.delete(workflowId);
    return null; // Cache expired
  }

  return entry.data;
}

/**
 * Check if sync status cache is stale for a workflow
 */
export function isSyncStatusCacheStale(workflowId: string): boolean {
  const entry = _syncStatusCache.get(workflowId);
  if (!entry) return true;

  const now = Date.now();
  return now - entry.timestamp > SYNC_STATUS_TTL_MS;
}

/**
 * Update sync status cache for a workflow
 */
export function updateSyncStatusCache(workflowId: string, data: CostSyncResponse): void {
  _syncStatusCache.set(workflowId, {
    data,
    timestamp: Date.now(),
    workflowId,
  });
}

/**
 * Clear sync status cache for a workflow
 */
export function clearSyncStatusCache(workflowId: string): void {
  _syncStatusCache.delete(workflowId);
}

/**
 * Clear all sync status cache
 */
export function clearAllSyncStatusCache(): void {
  _syncStatusCache.clear();
}

// ── Sync State Management ─────────────────────────────────────────────────

/**
 * Mark a workflow as currently syncing
 */
export function markSyncInProgress(workflowId: string): void {
  _isSyncing.add(workflowId);
}

/**
 * Mark a workflow as no longer syncing
 */
export function markSyncComplete(workflowId: string): void {
  _isSyncing.delete(workflowId);
}

/**
 * Check if a workflow is currently syncing
 */
export function isSyncInProgress(workflowId: string): boolean {
  return _isSyncing.has(workflowId);
}

/**
 * Get all workflows currently syncing
 */
export function getInProgressSyncs(): string[] {
  return Array.from(_isSyncing);
}

// ── Cache Statistics ─────────────────────────────────────────────────────

/**
 * Get cost report cache statistics
 */
export function getCostReportCacheStats() {
  return {
    hasCache: _costReportCache !== null,
    cacheAge: _costReportCache ? getCostReportCacheAge() : 0,
    isStale: isCostReportCacheStale(),
    lastFetchAttempt: _costReportCache?.lastFetchAttempt || 0,
    fetchSuccess: _costReportCache?.fetchSuccess || false,
    ttl: CACHE_TTL_MS,
  };
}

/**
 * Get sync status cache statistics
 */
export function getSyncStatusCacheStats() {
  const entries = Array.from(_syncStatusCache.values());
  const now = Date.now();

  return {
    totalEntries: entries.length,
    staleEntries: entries.filter((e) => now - e.timestamp > SYNC_STATUS_TTL_MS).length,
    inProgressSyncs: _isSyncing.size,
    ttl: SYNC_STATUS_TTL_MS,
  };
}

/**
 * Clear all caches
 */
export function clearAllCostCaches(): void {
  _costReportCache = null;
  _syncStatusCache.clear();
  _isSyncing.clear();
}