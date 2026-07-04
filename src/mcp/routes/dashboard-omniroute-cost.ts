// Sprint 4: OmniRoute Cost Sync Integration - Dashboard Routes
//
// Provides dashboard API endpoints for OmniRoute cost synchronization.
// These endpoints require dashboard authentication and expose cost data
// for visualization and management in the dashboard UI.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext, Router } from './types.js';
import { getDbPath } from '../../utils/config.js';
import { initDb } from '../../db/client.js';
import {
  syncWorkflowCostsToOmniRoute,
  getOmniRouteCostReport,
  compareCosts,
  type CostSyncResponse,
} from '../../v2/omniroute-bridge/cost-sync.js';
import {
  getCachedSyncStatus,
  updateSyncStatusCache,
  getSyncStatusCacheStats,
  getCostReportCacheStats,
  clearAllCostCaches,
} from '../../v2/omniroute-bridge/cost-cache.js';
import {
  triggerManualCostSync,
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

/**
 * GET /api/dashboard/omniroute/cost/sync/workflow/:workflowId
 * Sync costs for a specific workflow to OmniRoute
 */
async function handleSyncWorkflow(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'workflowId is required' }));
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const result = await syncWorkflowCostsToOmniRoute(db, workflowId);
      updateSyncStatusCache(workflowId, result);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/sync/batch
 * Sync costs for multiple workflows (batch operation)
 */
async function handleSyncBatch(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const body = await new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => data += chunk);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

    const { workflowIds, concurrent } = JSON.parse(body) as { workflowIds?: string[]; concurrent?: number };

    if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'workflowIds array is required' }));
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const result = await syncWorkflowCostsBatch(db, workflowIds, {
        concurrent: concurrent || 5,
        onProgress: (completed, total) => {
          // Progress could be sent via SSE in the future
        },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/sync/retry-failed
 * Retry failed cost syncs when OmniRoute health is restored
 */
async function handleRetryFailed(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const db = initDb(getDbPath());
    try {
      const workflowIds = getWorkflowsWithFailedSyncs(db, 100);
      const result = await retryFailedSyncsOnHealthRestore(db, workflowIds);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/sync/status/:workflowId
 * Get sync status for a specific workflow
 */
async function handleGetSyncStatus(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'workflowId is required' }));
      return true;
    }

    const status = getCachedSyncStatus(workflowId);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (status) {
      res.end(JSON.stringify(status));
    } else {
      res.end(JSON.stringify({
        sync_status: 'pending',
        total_cost: 0,
        omniroute_cost: 0,
        discrepancy: 0,
        synced_count: 0,
        failed_count: 0,
      }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/sync/cache-stats
 * Get cost sync cache statistics
 */
async function handleGetSyncCacheStats(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const stats = getSyncStatusCacheStats();
    const costReportStats = getCostReportCacheStats();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sync_status: stats,
      cost_report: costReportStats,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/sync/clear-cache
 * Clear all cost sync caches
 */
async function handleClearCache(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    clearAllCostCaches();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/report
 * Get cost report from OmniRoute
 */
async function handleGetCostReport(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const workflowId = url.searchParams.get('workflow_id');
    const startDate = url.searchParams.get('start_date');
    const endDate = url.searchParams.get('end_date');
    const provider = url.searchParams.get('provider');

    const result = await getOmniRouteCostReport({
      workflow_id: workflowId || undefined,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (result.ok && result.data) {
      res.end(JSON.stringify(result.data));
    } else {
      res.end(JSON.stringify({
        error: result.error,
      }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/cost/report/refresh
 * Refresh OmniRoute cost report and update cache
 */
async function handleRefreshCostReport(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const success = await refreshOmniRouteCostReport();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/compare/:workflowId
 * Compare Aurora costs with OmniRoute costs for a workflow
 */
async function handleCompareCosts(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'workflowId is required' }));
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const result = await compareCosts(db, workflowId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/metrics/workflow/:workflowId
 * Get cost metrics for a specific workflow
 */
async function handleGetWorkflowMetrics(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const workflowId = url.pathname.split('/').pop();

    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'workflowId is required' }));
      return true;
    }

    const db = initDb(getDbPath());
    try {
      const metrics = getWorkflowCostMetrics(db, workflowId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/metrics/global
 * Get global cost metrics (across all workflows)
 */
async function handleGetGlobalMetrics(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const db = initDb(getDbPath());
    try {
      const metrics = getGlobalCostMetrics(db);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metrics));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/breakdown
 * Get cost breakdown by model
 */
async function handleGetModelBreakdown(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const workflowId = url.searchParams.get('workflow_id');

    const db = initDb(getDbPath());
    try {
      const breakdown = getModelCostBreakdown(db, workflowId || undefined);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(breakdown));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/analytics/summary
 * Get cost analytics summary for a time period
 */
async function handleGetAnalyticsSummary(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const periodMs = url.searchParams.get('period_ms');
    const period = periodMs ? parseInt(periodMs, 10) : 24 * 60 * 60 * 1000; // Default 24 hours

    const db = initDb(getDbPath());
    try {
      const summary = getCostAnalyticsSummary(db, period);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/forecast
 * Get cost forecast for a future period
 */
async function handleGetForecast(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const periodMs = url.searchParams.get('period_ms');
    const period = periodMs ? parseInt(periodMs, 10) : 24 * 60 * 60 * 1000; // Default 24 hours

    const db = initDb(getDbPath());
    try {
      const forecast = forecastCost(db, period);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(forecast));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/cost/config
 * Get cost sync configuration
 */
async function handleGetConfig(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const config = {
      auto_sync_enabled: isAutoCostSyncEnabled(),
      // Add other config options here as needed
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

export const omnirouteCostRouter: Router = async (req, url, res, ctx) => {
  // Only handle requests under /api/dashboard/omniroute/cost
  if (!url.pathname.startsWith('/api/dashboard/omniroute/cost')) {
    return false;
  }

  // Sync endpoints
  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/sync\/workflow\/[^/]+$/)) {
    return await handleSyncWorkflow(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/sync/batch') {
    return await handleSyncBatch(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/sync/retry-failed') {
    return await handleRetryFailed(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/sync\/status\/[^/]+$/)) {
    return await handleGetSyncStatus(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/sync/cache-stats') {
    return await handleGetSyncCacheStats(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/sync/clear-cache') {
    return await handleClearCache(req, res, ctx);
  }

  // Report endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/report') {
    return await handleGetCostReport(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/cost/report/refresh') {
    return await handleRefreshCostReport(req, res, ctx);
  }

  // Compare endpoint
  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/compare\/[^/]+$/)) {
    return await handleCompareCosts(req, res, ctx);
  }

  // Metrics endpoints
  if (req.method === 'GET' && url.pathname.match(/^\/api\/dashboard\/omniroute\/cost\/metrics\/workflow\/[^/]+$/)) {
    return await handleGetWorkflowMetrics(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/metrics/global') {
    return await handleGetGlobalMetrics(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/breakdown') {
    return await handleGetModelBreakdown(req, res, ctx);
  }

  // Analytics endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/analytics/summary') {
    return await handleGetAnalyticsSummary(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/forecast') {
    return await handleGetForecast(req, res, ctx);
  }

  // Config endpoint
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/cost/config') {
    return await handleGetConfig(req, res, ctx);
  }

  return false;
};