// Sprint 3: OmniRoute Health Integration - Dashboard Routes
//
// Provides dashboard API endpoints for OmniRoute health status monitoring.
// These endpoints require dashboard authentication and expose health data
// for visualization in the dashboard UI.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteContext, Router } from './types.js';
import {
  getHealthStatus,
  getCacheStats,
  refreshHealthStatus,
} from '../../v2/omniroute-bridge/health-cache.js';
import {
  getFailoverState,
  isFailoverActive,
  shouldAllowOmniRouteRequest,
  manualActivateFailover,
  manualDeactivateFailover,
} from '../../v2/omniroute-bridge/failover.js';
import {
  startHealthMonitor,
  stopHealthMonitor,
  getHealthMonitorStats,
  isHealthMonitorRunning,
  triggerManualHealthCheck,
} from '../../v2/omniroute-bridge/health-monitor.js';
import {
  getHealthMetrics,
  getHealthStatistics,
  getHealthMetricsHistory,
} from '../../v2/omniroute-bridge/health-observability.js';

/**
 * GET /api/dashboard/omniroute/health
 * Returns current OmniRoute health status (from cache or fresh)
 */
async function handleGetHealth(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const result = await getHealthStatus();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (result.ok && result.data) {
      res.end(JSON.stringify(result.data));
    } else {
      // Return error status but with degraded data
      res.end(JSON.stringify({
        status: 'error',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
        error: result.error,
      }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'error',
      timestamp: new Date().toISOString(),
      providers: {},
      rate_limits: {},
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  
  return true;
}

/**
 * GET /api/dashboard/omniroute/health/cache-stats
 * Returns health cache statistics for monitoring
 */
async function handleGetCacheStats(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const stats = getCacheStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }
  
  return true;
}

/**
 * POST /api/dashboard/omniroute/health/refresh
 * Forces a health status refresh from OmniRoute API
 */
async function handleRefreshHealth(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const result = await refreshHealthStatus();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (result.ok && result.data) {
      res.end(JSON.stringify(result.data));
    } else {
      res.end(JSON.stringify({
        status: 'error',
        timestamp: new Date().toISOString(),
        providers: {},
        rate_limits: {},
        error: result.error,
      }));
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'error',
      timestamp: new Date().toISOString(),
      providers: {},
      rate_limits: {},
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/failover
 * Returns current failover state
 */
async function handleGetFailover(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const state = getFailoverState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/failover/activate
 * Manually activate failover (for testing or emergency)
 */
async function handleActivateFailover(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    manualActivateFailover();
    const state = getFailoverState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      state,
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
 * POST /api/dashboard/omniroute/health/failover/deactivate
 * Manually deactivate failover (for testing or recovery)
 */
async function handleDeactivateFailover(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    manualDeactivateFailover();
    const state = getFailoverState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      state,
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
 * GET /api/dashboard/omniroute/health/monitor
 * Returns health monitor statistics
 */
async function handleGetMonitorStats(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const stats = getHealthMonitorStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * POST /api/dashboard/omniroute/health/monitor/start
 * Start the health monitor
 */
async function handleStartMonitor(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    startHealthMonitor();
    const stats = getHealthMonitorStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      stats,
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
 * POST /api/dashboard/omniroute/health/monitor/stop
 * Stop the health monitor
 */
async function handleStopMonitor(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    stopHealthMonitor();
    const stats = getHealthMonitorStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      stats,
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
 * POST /api/dashboard/omniroute/health/monitor/trigger
 * Trigger a manual health check
 */
async function handleTriggerCheck(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    await triggerManualHealthCheck();
    const stats = getHealthMonitorStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      stats,
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
 * GET /api/dashboard/omniroute/health/metrics
 * Returns current health metrics
 */
async function handleGetMetrics(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const metrics = getHealthMetrics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (metrics) {
      res.end(JSON.stringify(metrics));
    } else {
      res.end(JSON.stringify({
        error: 'No metrics available yet',
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
 * GET /api/dashboard/omniroute/health/metrics/history
 * Returns health metrics history
 */
async function handleGetMetricsHistory(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const since = url.searchParams.get('since');
    const sinceMs = since ? parseInt(since, 10) : undefined;

    const history = getHealthMetricsHistory(sinceMs);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

/**
 * GET /api/dashboard/omniroute/health/metrics/statistics
 * Returns health statistics over a time window
 */
async function handleGetStatistics(req: IncomingMessage, res: ServerResponse, ctx: RouteContext): Promise<boolean> {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const windowMs = url.searchParams.get('window');
    const window = windowMs ? parseInt(windowMs, 10) : 5 * 60 * 1000; // Default 5 minutes

    const stats = getHealthStatistics(window);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  return true;
}

export const omnirouteHealthRouter: Router = async (req, url, res, ctx) => {
  // Only handle requests under /api/dashboard/omniroute/health
  if (!url.pathname.startsWith('/api/dashboard/omniroute/health')) {
    return false;
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health') {
    return await handleGetHealth(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/cache-stats') {
    return await handleGetCacheStats(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/refresh') {
    return await handleRefreshHealth(req, res, ctx);
  }

  // Failover endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/failover') {
    return await handleGetFailover(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/failover/activate') {
    return await handleActivateFailover(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/failover/deactivate') {
    return await handleDeactivateFailover(req, res, ctx);
  }

  // Monitor endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/monitor') {
    return await handleGetMonitorStats(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/monitor/start') {
    return await handleStartMonitor(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/monitor/stop') {
    return await handleStopMonitor(req, res, ctx);
  }

  if (req.method === 'POST' && url.pathname === '/api/dashboard/omniroute/health/monitor/trigger') {
    return await handleTriggerCheck(req, res, ctx);
  }

  // Metrics endpoints
  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/metrics') {
    return await handleGetMetrics(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/metrics/history') {
    return await handleGetMetricsHistory(req, res, ctx);
  }

  if (req.method === 'GET' && url.pathname === '/api/dashboard/omniroute/health/metrics/statistics') {
    return await handleGetStatistics(req, res, ctx);
  }

  return false;
};