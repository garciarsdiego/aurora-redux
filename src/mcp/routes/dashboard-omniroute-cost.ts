// Sprint 4: OmniRoute Cost Sync Integration - Dashboard Routes
//
// Provides dashboard API endpoints for OmniRoute cost synchronization.
// These endpoints require dashboard authentication and expose cost data
// for visualization and management in the dashboard UI.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from './types.js';
import { readJsonBody } from './_shared.js';
import { getDbPath } from '../../utils/config.js';
import { initDb } from '../../db/client.js';
import {
  syncWorkflowCostsToOmniRoute,
  getOmniRouteCostReport,
  compareCosts,
} from '../../v2/omniroute-bridge/cost-sync.js';
import {
  getCachedSyncStatus,
  updateSyncStatusCache,
  getSyncStatusCacheStats,
  getCostReportCacheStats,
  clearAllCostCaches,
} from '../../v2/omniroute-bridge/cost-cache.js';
import {
  syncWorkflowCostsBatch,
  retryFailedSyncsOnHealthRestore,
  getWorkflowsWithFailedSyncs,
  isAutoCostSyncEnabled,
} from '../../v2/omniroute-bridge/cost-integration.js';
import {
  getWorkflowCostMetrics,
  getGlobalCostMetrics,
  getModelCostBreakdown,
  getCostAnalyticsSummary,
  refreshOmniRouteCostReport,
  forecastCost,
} from '../../v2/omniroute-bridge/cost-analytics.js';

// ── Local response helpers ────────────────────────────────────────────────
//
// NOTE: this file intentionally responds with a bare
// 'Content-Type: application/json' header set (no SECURITY_HEADERS /
// X-Omniforge-Api-Version), matching its historical behavior. Unifying with
// jsonOk/badRequest from _shared.ts would change response headers — do that
// as a separate, conscious step.

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function respondError(res: ServerResponse, err: unknown): void {
  respondJson(res, 500, {
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * GET /api/dashboard/omniroute/cost/sync/workflow/:workflowId
 * Sync costs for a specific workflow to OmniRoute
 */
async function handleSyncWorkflow(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      respondJson(res, 400, { error: 'workflowId is required' });
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const result = await syncWorkflowCostsToOmniRoute(db, workflowId);
      updateSyncStatusCache(workflowId, result);

      respondJson(res, 200, result);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/sync/batch
 * Sync costs for multiple workflows (batch operation)
 */
async function handleSyncBatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // readJsonBody enforces the shared 256 KB anti-buffer-bomb cap; a parse
  // failure answers 400 instead of surfacing as a generic 500.
  let parsed: unknown;
  try {
    parsed = await readJsonBody(req);
  } catch (err) {
    respondJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  try {
    const { workflowIds, concurrent } = parsed as { workflowIds?: string[]; concurrent?: number };

    if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
      respondJson(res, 400, { error: 'workflowIds array is required' });
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const result = await syncWorkflowCostsBatch(db, workflowIds, {
        concurrent: concurrent || 5,
      });

      respondJson(res, 200, result);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/sync/retry-failed
 * Retry failed cost syncs when OmniRoute health is restored
 */
async function handleRetryFailed(res: ServerResponse): Promise<boolean> {
  try {
    const db = initDb(getDbPath());
    try {
      const workflowIds = getWorkflowsWithFailedSyncs(db, 100);
      const result = await retryFailedSyncsOnHealthRestore(db, workflowIds);

      respondJson(res, 200, result);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/sync/status/:workflowId
 * Get sync status for a specific workflow
 */
async function handleGetSyncStatus(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      respondJson(res, 400, { error: 'workflowId is required' });
      return true;
    }

    const status = getCachedSyncStatus(workflowId);

    respondJson(res, 200, status ?? {
      sync_status: 'pending',
      total_cost: 0,
      omniroute_cost: 0,
      discrepancy: 0,
      synced_count: 0,
      failed_count: 0,
    });
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/sync/cache-stats
 * Get cost sync cache statistics
 */
async function handleGetSyncCacheStats(res: ServerResponse): Promise<boolean> {
  try {
    const stats = getSyncStatusCacheStats();
    const costReportStats = getCostReportCacheStats();

    respondJson(res, 200, {
      sync_status: stats,
      cost_report: costReportStats,
    });
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/sync/clear-cache
 * Clear all cost sync caches
 */
async function handleClearCache(res: ServerResponse): Promise<boolean> {
  try {
    clearAllCostCaches();

    respondJson(res, 200, { success: true });
  } catch (err) {
    respondJson(res, 500, {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/report
 * Get cost report from OmniRoute
 */
async function handleGetCostReport(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const workflowId = url.searchParams.get('workflow_id');

    const result = await getOmniRouteCostReport({
      workflow_id: workflowId || undefined,
    });

    if (result.ok && result.data) {
      respondJson(res, 200, result.data);
    } else {
      respondJson(res, 200, { error: result.error });
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/report/refresh
 * Refresh OmniRoute cost report and update cache
 */
async function handleRefreshCostReport(res: ServerResponse): Promise<boolean> {
  try {
    const success = await refreshOmniRouteCostReport();

    respondJson(res, 200, { success });
  } catch (err) {
    respondJson(res, 500, {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/compare/:workflowId
 * Compare Aurora costs with OmniRoute costs for a workflow
 */
async function handleCompareCosts(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      respondJson(res, 400, { error: 'workflowId is required' });
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const result = await compareCosts(db, workflowId);

      respondJson(res, 200, result);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/metrics/workflow/:workflowId
 * Get cost metrics for a specific workflow
 */
async function handleGetWorkflowMetrics(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      respondJson(res, 400, { error: 'workflowId is required' });
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const metrics = getWorkflowCostMetrics(db, workflowId);

      respondJson(res, 200, metrics);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/metrics/global
 * Get global cost metrics (across all workflows)
 */
async function handleGetGlobalMetrics(res: ServerResponse): Promise<boolean> {
  try {
    const db = initDb(getDbPath());
    try {
      const metrics = getGlobalCostMetrics(db);

      respondJson(res, 200, metrics);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/breakdown
 * Get cost breakdown by model
 */
async function handleGetModelBreakdown(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const workflowId = url.searchParams.get('workflow_id');

    const db = initDb(getDbPath());
    try {
      const breakdown = getModelCostBreakdown(db, workflowId || undefined);

      respondJson(res, 200, breakdown);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/analytics/summary
 * Get cost analytics summary for a time period
 */
async function handleGetAnalyticsSummary(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const periodMs = url.searchParams.get('period_ms');
    const period = periodMs ? parseInt(periodMs, 10) : 24 * 60 * 60 * 1000; // Default 24 hours

    const db = initDb(getDbPath());
    try {
      const summary = getCostAnalyticsSummary(db, period);

      respondJson(res, 200, summary);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/forecast
 * Get cost forecast for a future period
 */
async function handleGetForecast(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const periodMs = url.searchParams.get('period_ms');
    const period = periodMs ? parseInt(periodMs, 10) : 24 * 60 * 60 * 1000; // Default 24 hours

    const db = initDb(getDbPath());
    try {
      const forecast = forecastCost(db, period);

      respondJson(res, 200, forecast);
    } finally {
      db.close();
    }
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/config
 * Get cost sync configuration
 */
async function handleGetConfig(res: ServerResponse): Promise<boolean> {
  try {
    const config = {
      auto_sync_enabled: isAutoCostSyncEnabled(),
      // Add other config options here as needed
    };

    respondJson(res, 200, config);
  } catch (err) {
    respondError(res, err);
  }

  return true;
}

export const omnirouteCostRouter: Router = async (req, url, res, _ctx) => {
  // Only handle requests under /api/dashboard/omniroute/cost
  if (!url.pathname.startsWith('/api/dashboard/omniroute/cost')) {
    return false;
  }

  // Sync endpoints
  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/sync\/workflow\/[^/]+$/)) {
    return await handleSyncWorkflow(url, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/sync/batch') {
    return await handleSyncBatch(req, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/sync/retry-failed') {
    return await handleRetryFailed(res);
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/sync\/status\/[^/]+$/)) {
    return await handleGetSyncStatus(url, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/sync/cache-stats') {
    return await handleGetSyncCacheStats(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/sync/clear-cache') {
    return await handleClearCache(res);
  }

  // Report endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/report') {
    return await handleGetCostReport(url, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/report/refresh') {
    return await handleRefreshCostReport(res);
  }

  // Compare endpoint
  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/compare\/[^/]+$/)) {
    return await handleCompareCosts(url, res);
  }

  // Metrics endpoints
  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/metrics\/workflow\/[^/]+$/)) {
    return await handleGetWorkflowMetrics(url, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/metrics/global') {
    return await handleGetGlobalMetrics(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/breakdown') {
    return await handleGetModelBreakdown(url, res);
  }

  // Analytics endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/analytics/summary') {
    return await handleGetAnalyticsSummary(url, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/forecast') {
    return await handleGetForecast(url, res);
  }

  // Config endpoint
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/config') {
    return await handleGetConfig(res);
  }

  return false;
};
