/**
 * Dashboard Monitoring Routes (Sprint 0)
 *
 * HTTP endpoints for the monitoring dashboard.
 * Provides comprehensive system metrics for the Aurora dashboard.
 */

import type { ServerResponse } from 'node:http';
import type { RouteContext, Router } from './types.js';
import { API_VERSION } from './_shared.js';
import { getMonitoringDashboardData, HEALTH_THRESHOLDS } from '../../v2/observability/monitoring-dashboard.js';
import { exportTracesJaeger, exportTracesZipkin, getTraceStatistics } from '../../v2/observability/tracing.js';
import { logAggregator, type LogQuery } from '../../v2/observability/log-aggregation.js';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
// Sprint 8: Advanced Analytics
import {
  getAnalyticsReport,
  getPerformanceTrend,
  getCostAnalytics,
  getRoutingAnalytics,
  detectAnomalies,
  getCapacityPlanning,
  generateInsights,
} from '../../v2/observability/analytics.js';
import { getCachedAnalytics } from '../../v2/observability/analytics-cache.js';

/**
 * GET /api/monitoring/dashboard
 * 
 * Returns comprehensive monitoring dashboard data.
 * Sprint 8: Added optional analytics parameter.
 */
function handleMonitoringDashboard(res: ServerResponse, url: URL, ctx: RouteContext): void {
  try {
    const includeAnalytics = url.searchParams.get('analytics') === 'true';
    const data = getMonitoringDashboardData({
      version: ctx.version,
      serverStartMs: ctx.serverStartMs,
      includeAnalytics,
    });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch monitoring data',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/health
 * 
 * Returns simplified health status with threshold comparisons.
 */
function handleHealthCheck(res: ServerResponse, ctx: RouteContext): void {
  try {
    const data = getMonitoringDashboardData({
      version: ctx.version,
      serverStartMs: ctx.serverStartMs,
    });

    const health = data.system_health;
    const issues: string[] = [];

    // Check daemon health
    if (health.daemon_alive_at_age_ms !== null && health.daemon_alive_at_age_ms > HEALTH_THRESHOLDS.DAEMON_ALIVE_THRESHOLD_MS) {
      issues.push(`Daemon heartbeat stale (${health.daemon_alive_at_age_ms}ms > ${HEALTH_THRESHOLDS.DAEMON_ALIVE_THRESHOLD_MS}ms)`);
    }

    // Check schedule tick
    if (health.last_schedule_tick_age_ms !== null && health.last_schedule_tick_age_ms > HEALTH_THRESHOLDS.SCHEDULE_TICK_THRESHOLD_MS) {
      issues.push(`Schedule tick stale (${health.last_schedule_tick_age_ms}ms > ${HEALTH_THRESHOLDS.SCHEDULE_TICK_THRESHOLD_MS}ms)`);
    }

    // Check workflow success rate
    if (data.workflows.success_rate_pct < HEALTH_THRESHOLDS.SUCCESS_RATE_TARGET_PCT && data.workflows.total_workflows > 10) {
      issues.push(`Workflow success rate below target (${data.workflows.success_rate_pct}% < ${HEALTH_THRESHOLDS.SUCCESS_RATE_TARGET_PCT}%)`);
    }

    const overallHealth = issues.length === 0 ? 'healthy' : (health.status === 'unhealthy' ? 'unhealthy' : 'degraded');

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      status: overallHealth,
      system_health: health,
      issues,
      thresholds: HEALTH_THRESHOLDS,
      timestamp: data.timestamp,
    }));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch health status',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/metrics
 * 
 * Returns metrics in Prometheus-compatible format for external monitoring systems.
 */
function handleMetricsExport(res: ServerResponse, ctx: RouteContext): void {
  try {
    const data = getMonitoringDashboardData({
      version: ctx.version,
      serverStartMs: ctx.serverStartMs,
    });

    // Convert to Prometheus format
    const prometheusMetrics = [
      `# HELP omniforge_system_uptime_seconds System uptime in seconds`,
      `# TYPE omniforge_system_uptime_seconds gauge`,
      `omniforge_system_uptime_seconds ${data.system_health.uptime_ms / 1000}`,
      ``,
      `# HELP omniforge_workflows_total Total number of workflows`,
      `# TYPE omniforge_workflows_total gauge`,
      `omniforge_workflows_total ${data.workflows.total_workflows}`,
      ``,
      `# HELP omniforge_workflows_active Number of active workflows`,
      `# TYPE omniforge_workflows_active gauge`,
      `omniforge_workflows_active ${data.workflows.active_workflows}`,
      ``,
      `# HELP omniforge_workflows_success_rate Workflow success rate percentage`,
      `# TYPE omniforge_workflows_success_rate gauge`,
      `omniforge_workflows_success_rate ${data.workflows.success_rate_pct}`,
      ``,
      `# HELP omniforge_llm_tokens_total Total LLM tokens consumed`,
      `# TYPE omniforge_llm_tokens_total counter`,
      `omniforge_llm_tokens_total ${data.llm_usage.total_tokens}`,
      ``,
      `# HELP omniforge_llm_cost_usd_total Total LLM cost in USD`,
      `# TYPE omniforge_llm_cost_usd_total counter`,
      `omniforge_llm_cost_usd_total ${data.llm_usage.total_cost_usd}`,
      ``,
      `# HELP omniforge_llm_calls_total Total LLM API calls`,
      `# TYPE omniforge_llm_calls_total counter`,
      `omniforge_llm_calls_total ${data.llm_usage.total_calls}`,
      ``,
      `# HELP omniforge_cache_hit_rate Cache hit rate percentage`,
      `# TYPE omniforge_cache_hit_rate gauge`,
      `omniforge_cache_hit_rate ${data.llm_usage.cache_hit_rate_pct ?? 0}`,
      ``,
      `# HELP omniforge_persona_invocations_total Total persona invocations`,
      `# TYPE omniforge_persona_invocations_total counter`,
      `omniforge_persona_invocations_total ${data.persona_metrics.total_invocations}`,
      ``,
      `# HELP omniforge_persona_path_share_pct Persona path usage percentage`,
      `# TYPE omniforge_persona_path_share_pct gauge`,
      `omniforge_persona_path_share_pct ${data.persona_metrics.persona_path_share_pct}`,
    ];

    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(prometheusMetrics.join('\n'));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'text/plain',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(`# Error fetching metrics\n${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * GET /api/monitoring/traces/:workflowId/jaeger
 * 
 * Export traces in Jaeger-compatible format for distributed tracing systems.
 */
function handleJaegerTraceExport(res: ServerResponse, url: URL, ctx: RouteContext): void {
  try {
    const workflowId = url.pathname.split('/').slice(-2)[0]; // Extract workflow ID from path
    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow ID required' }));
      return;
    }

    const db = initDb(getDbPath());
    try {
      const traces = exportTracesJaeger(db, workflowId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Omniforge-Api-Version': String(API_VERSION),
      });
      res.end(JSON.stringify({ data: traces }));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to export Jaeger traces',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/traces/:workflowId/zipkin
 * 
 * Export traces in Zipkin v2 format for distributed tracing systems.
 */
function handleZipkinTraceExport(res: ServerResponse, url: URL, ctx: RouteContext): void {
  try {
    const workflowId = url.pathname.split('/').slice(-2)[0]; // Extract workflow ID from path
    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow ID required' }));
      return;
    }

    const db = initDb(getDbPath());
    try {
      const traces = exportTracesZipkin(db, workflowId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Omniforge-Api-Version': String(API_VERSION),
      });
      res.end(JSON.stringify(traces));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to export Zipkin traces',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/traces/:workflowId/statistics
 * 
 * Get trace statistics for a workflow.
 */
function handleTraceStatistics(res: ServerResponse, url: URL, ctx: RouteContext): void {
  try {
    const workflowId = url.pathname.split('/').slice(-2)[0]; // Extract workflow ID from path
    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow ID required' }));
      return;
    }

    const db = initDb(getDbPath());
    try {
      const stats = getTraceStatistics(db, workflowId);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Omniforge-Api-Version': String(API_VERSION),
      });
      res.end(JSON.stringify(stats));
    } finally {
      db.close();
    }
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to get trace statistics',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/logs
 * 
 * Query logs with optional filters.
 */
function handleLogsQuery(res: ServerResponse, url: URL): void {
  try {
    const params = url.searchParams;
    
    const query: LogQuery = {
      level: params.get('level') as LogQuery['level'] || undefined,
      context: params.get('context') || undefined,
      workflowId: params.get('workflowId') || undefined,
      taskId: params.get('taskId') || undefined,
      since: params.get('since') ? parseInt(params.get('since')!, 10) : undefined,
      until: params.get('until') ? parseInt(params.get('until')!, 10) : undefined,
      limit: params.get('limit') ? parseInt(params.get('limit')!, 10) : undefined,
      search: params.get('search') || undefined,
    };

    const logs = logAggregator.queryLogs(query);
    
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      logs,
      total: logs.length,
      query,
    }));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to query logs',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/logs/statistics
 * 
 * Get log statistics.
 */
function handleLogsStatistics(res: ServerResponse): void {
  try {
    const stats = logAggregator.getStatistics();
    
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(stats));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to get log statistics',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/logs/export
 * 
 * Export logs in specified format (json, csv, syslog).
 */
function handleLogsExport(res: ServerResponse, url: URL): void {
  try {
    const params = url.searchParams;
    const format = (params.get('format') as 'json' | 'csv' | 'syslog') || 'json';
    
    const query: LogQuery = {
      level: params.get('level') as LogQuery['level'] || undefined,
      context: params.get('context') || undefined,
      workflowId: params.get('workflowId') || undefined,
      taskId: params.get('taskId') || undefined,
      since: params.get('since') ? parseInt(params.get('since')!, 10) : undefined,
      until: params.get('until') ? parseInt(params.get('until')!, 10) : undefined,
      limit: params.get('limit') ? parseInt(params.get('limit')!, 10) : undefined,
      search: params.get('search') || undefined,
    };

    const exported = logAggregator.exportLogs(query, format);
    
    const contentType = format === 'json' 
      ? 'application/json' 
      : (format === 'csv' ? 'text/csv' : 'text/plain');
    
    res.writeHead(200, {
      'Content-Type': contentType,
      'X-Omniforge-Api-Version': String(API_VERSION),
      'Content-Disposition': `attachment; filename="logs.${format}"`,
    });
    res.end(exported);
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to export logs',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/analytics/report
 * 
 * Sprint 8: Returns comprehensive analytics report.
 */
function handleAnalyticsReport(res: ServerResponse): void {
  try {
    const report = getAnalyticsReport();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(report));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch analytics report',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/analytics/trend/:metric
 * 
 * Sprint 8: Returns performance trend for a specific metric.
 */
function handlePerformanceTrend(res: ServerResponse, url: URL): void {
  try {
    const metric = url.pathname.split('/').slice(-1)[0];
    const period = (url.searchParams.get('period') as 'hour' | 'day' | 'week' | 'month') || 'day';

    const trend = getPerformanceTrend(metric, period);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(trend));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch performance trend',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/analytics/cost
 * 
 * Sprint 8: Returns cost analytics.
 */
function handleCostAnalytics(res: ServerResponse): void {
  try {
    const analytics = getCostAnalytics();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(analytics));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch cost analytics',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/analytics/routing
 * 
 * Sprint 8: Returns routing analytics.
 */
function handleRoutingAnalytics(res: ServerResponse): void {
  try {
    const analytics = getRoutingAnalytics();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(analytics));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch routing analytics',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/analytics/anomalies
 * 
 * Sprint 8: Returns detected anomalies.
 */
function handleAnomalies(res: ServerResponse): void {
  try {
    const anomalies = detectAnomalies();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({ anomalies }));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to detect anomalies',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/analytics/capacity
 * 
 * Sprint 8: Returns capacity planning insights.
 */
function handleCapacityPlanning(res: ServerResponse): void {
  try {
    const capacity = getCapacityPlanning();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify(capacity));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to fetch capacity planning',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * GET /api/monitoring/analytics/insights
 * 
 * Sprint 8: Returns generated insights and recommendations.
 */
function handleInsights(res: ServerResponse): void {
  try {
    const insights = generateInsights();

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({ insights }));
  } catch (err) {
    res.writeHead(500, {
      'Content-Type': 'application/json',
      'X-Omniforge-Api-Version': String(API_VERSION),
    });
    res.end(JSON.stringify({
      error: 'Failed to generate insights',
      message: err instanceof Error ? err.message : String(err),
    }));
  }
}

export const monitoringRouter: Router = async (req, url, res, ctx) => {
  if (req.method === 'GET' && url.pathname === '/api/monitoring/dashboard') {
    handleMonitoringDashboard(res, url, ctx);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/health') {
    handleHealthCheck(res, ctx);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/metrics') {
    handleMetricsExport(res, ctx);
    return true;
  }
  // Sprint 0: Distributed tracing endpoints
  if (req.method === 'GET' && url.pathname.match(/^\/api\/monitoring\/traces\/[^/]+\/jaeger$/)) {
    handleJaegerTraceExport(res, url, ctx);
    return true;
  }
  if (req.method === 'GET' && url.pathname.match(/^\/api\/monitoring\/traces\/[^/]+\/zipkin$/)) {
    handleZipkinTraceExport(res, url, ctx);
    return true;
  }
  if (req.method === 'GET' && url.pathname.match(/^\/api\/monitoring\/traces\/[^/]+\/statistics$/)) {
    handleTraceStatistics(res, url, ctx);
    return true;
  }
  // Sprint 0: Log aggregation endpoints
  if (req.method === 'GET' && url.pathname === '/api/monitoring/logs') {
    handleLogsQuery(res, url);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/logs/statistics') {
    handleLogsStatistics(res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/logs/export') {
    handleLogsExport(res, url);
    return true;
  }
  // Sprint 8: Advanced Analytics endpoints
  if (req.method === 'GET' && url.pathname === '/api/monitoring/analytics/report') {
    handleAnalyticsReport(res);
    return true;
  }
  if (req.method === 'GET' && url.pathname.match(/^\/api\/monitoring\/analytics\/trend\/[^/]+$/)) {
    handlePerformanceTrend(res, url);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/analytics/cost') {
    handleCostAnalytics(res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/analytics/routing') {
    handleRoutingAnalytics(res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/analytics/anomalies') {
    handleAnomalies(res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/analytics/capacity') {
    handleCapacityPlanning(res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/monitoring/analytics/insights') {
    handleInsights(res);
    return true;
  }
  return false;
};