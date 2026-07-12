// Sprint 3: OmniRoute Health Integration - Dashboard Routes
//
// Provides dashboard API endpoints for OmniRoute health status monitoring.
// These endpoints require dashboard authentication and expose health data
// for visualization in the dashboard UI.

import type { ServerResponse } from 'node:http';
import type { Router } from './types.js';
import {
  getHealthStatus,
  getCacheStats,
  refreshHealthStatus,
} from '../../v2/omniroute-bridge/health-cache.js';
import {
  getFailoverState,
  manualActivateFailover,
  manualDeactivateFailover,
} from '../../v2/omniroute-bridge/failover.js';
import {
  startHealthMonitor,
  stopHealthMonitor,
  getHealthMonitorStats,
  triggerManualHealthCheck,
} from '../../v2/omniroute-bridge/health-monitor.js';
import {
  getHealthMetrics,
  getHealthStatistics,
  getHealthMetricsHistory,
} from '../../v2/omniroute-bridge/health-observability.js';

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * GET /api/dashboard/omniroute/health
 * Returns current OmniRoute health status (from cache or fresh)
 */
async function handleGetHealth(res: ServerResponse): Promise<boolean> {
  try {
    const result = await getHealthStatus();

    if (result.ok && result.data) {
      respondJson(res, 200, result.data);
    } else {
      // Return error status but with degraded data
      respondJson(res, 200, {
        status: 'error',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
        error: result.error,
      });
    }
  } catch (err) {
    respondJson(res, 500, {
      status: 'error',
      timestamp: new Date().toISOString(),
      providers: {},
      rate_limits: {},
      error: errorMessage(err),
    });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/cache-stats
 * Returns health cache statistics for monitoring
 */
async function handleGetCacheStats(res: ServerResponse): Promise<boolean> {
  try {
    const stats = getCacheStats();
    respondJson(res, 200, stats);
  } catch (err) {
    respondJson(res, 500, { error: errorMessage(err) });
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/refresh
 * Forces a health status refresh from OmniRoute API
 */
async function handleRefreshHealth(res: ServerResponse): Promise<boolean> {
  try {
    const result = await refreshHealthStatus();

    if (result.ok && result.data) {
      respondJson(res, 200, result.data);
    } else {
      respondJson(res, 200, {
        status: 'error',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
        error: result.error,
      });
    }
  } catch (err) {
    respondJson(res, 500, {
      status: 'error',
      timestamp: new Date().toISOString(),
      providers: {},
      rate_limits: {},
      error: errorMessage(err),
    });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/failover
 * Returns current failover state
 */
async function handleGetFailover(res: ServerResponse): Promise<boolean> {
  try {
    const state = getFailoverState();
    respondJson(res, 200, state);
  } catch (err) {
    respondJson(res, 500, { error: errorMessage(err) });
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/failover/activate
 * Manually activate failover (for testing or emergency)
 */
async function handleActivateFailover(res: ServerResponse): Promise<boolean> {
  try {
    manualActivateFailover();
    const state = getFailoverState();
    respondJson(res, 200, { success: true, state });
  } catch (err) {
    respondJson(res, 500, { success: false, error: errorMessage(err) });
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/failover/deactivate
 * Manually deactivate failover (for testing or recovery)
 */
async function handleDeactivateFailover(res: ServerResponse): Promise<boolean> {
  try {
    manualDeactivateFailover();
    const state = getFailoverState();
    respondJson(res, 200, { success: true, state });
  } catch (err) {
    respondJson(res, 500, { success: false, error: errorMessage(err) });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/monitor
 * Returns health monitor statistics
 */
async function handleGetMonitorStats(res: ServerResponse): Promise<boolean> {
  try {
    const stats = getHealthMonitorStats();
    respondJson(res, 200, stats);
  } catch (err) {
    respondJson(res, 500, { error: errorMessage(err) });
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/monitor/start
 * Start the health monitor
 */
async function handleStartMonitor(res: ServerResponse): Promise<boolean> {
  try {
    startHealthMonitor();
    const stats = getHealthMonitorStats();
    respondJson(res, 200, { success: true, stats });
  } catch (err) {
    respondJson(res, 500, { success: false, error: errorMessage(err) });
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/monitor/stop
 * Stop the health monitor
 */
async function handleStopMonitor(res: ServerResponse): Promise<boolean> {
  try {
    stopHealthMonitor();
    const stats = getHealthMonitorStats();
    respondJson(res, 200, { success: true, stats });
  } catch (err) {
    respondJson(res, 500, { success: false, error: errorMessage(err) });
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/monitor/trigger
 * Trigger a manual health check
 */
async function handleTriggerCheck(res: ServerResponse): Promise<boolean> {
  try {
    await triggerManualHealthCheck();
    const stats = getHealthMonitorStats();
    respondJson(res, 200, { success: true, stats });
  } catch (err) {
    respondJson(res, 500, { success: false, error: errorMessage(err) });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/metrics
 * Returns current health metrics
 */
async function handleGetMetrics(res: ServerResponse): Promise<boolean> {
  try {
    const metrics = getHealthMetrics();
    respondJson(res, 200, metrics ?? { error: 'No metrics available yet' });
  } catch (err) {
    respondJson(res, 500, { error: errorMessage(err) });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/metrics/history
 * Returns health metrics history
 */
async function handleGetMetricsHistory(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const since = url.searchParams.get('since');
    const sinceMs = since ? parseInt(since, 10) : undefined;

    const history = getHealthMetricsHistory(sinceMs);
    respondJson(res, 200, history);
  } catch (err) {
    respondJson(res, 500, { error: errorMessage(err) });
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/metrics/statistics
 * Returns health statistics over a time window
 */
async function handleGetStatistics(url: URL, res: ServerResponse): Promise<boolean> {
  try {
    const windowMs = url.searchParams.get('window');
    const window = windowMs ? parseInt(windowMs, 10) : 5 * 60 * 1000; // Default 5 minutes

    const stats = getHealthStatistics(window);
    respondJson(res, 200, stats);
  } catch (err) {
    respondJson(res, 500, { error: errorMessage(err) });
  }

  return true;
}

export const omnirouteHealthRouter: Router = async (req, url, res, _ctx) => {
  // Only handle requests under /api/dashboard/omniroute/health
  if (!url.pathname.startsWith('/api/dashboard/omniroute/health')) {
    return false;
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health') {
    return await handleGetHealth(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/cache-stats') {
    return await handleGetCacheStats(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/refresh') {
    return await handleRefreshHealth(res);
  }

  // Failover endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/failover') {
    return await handleGetFailover(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/failover/activate') {
    return await handleActivateFailover(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/failover/deactivate') {
    return await handleDeactivateFailover(res);
  }

  // Monitor endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/monitor') {
    return await handleGetMonitorStats(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/monitor/start') {
    return await handleStartMonitor(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/monitor/stop') {
    return await handleStopMonitor(res);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/monitor/trigger') {
    return await handleTriggerCheck(res);
  }

  // Metrics endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/metrics') {
    return await handleGetMetrics(res);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/metrics/history') {
    return await handleGetMetricsHistory(url, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/metrics/statistics') {
    return await handleGetStatistics(url, res);
  }

  return false;
};
