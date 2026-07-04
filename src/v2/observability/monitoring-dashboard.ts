/**
 * Monitoring Dashboard Module (Sprint 0)
 *
 * Provides comprehensive system monitoring metrics for the Omniforge Aurora dashboard.
 * Integrates with existing health checks, tracing, and persona metrics systems.
 *
 * Metrics categories:
 * - System Health: uptime, daemon status, resource usage
 * - Performance: build times, test durations, API latency
 * - Workflows: active/completed/failed counts, success rates
 * - LLM Usage: token consumption, costs, model distribution
 * - OmniRoute: health status, provider performance
 */

import type Database from 'better-sqlite3';
import { getDbPath } from '../../utils/config.js';
import { initDb } from '../../db/client.js';
import { getDaemonState } from '../../db/persist.js';
import { readDaemonHeartbeat } from '../../db/daemon-heartbeat.js';
import { getPersonaMetrics, getPersonaVsLegacyShare } from './persona-metrics.js';
import { exportTraceSpans } from './tracing.js';
import { getAnalyticsReport } from './analytics.js';

export interface SystemHealthMetrics {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime_ms: number;
  daemon_alive_at_age_ms: number | null;
  last_schedule_tick_age_ms: number | null;
  api_version: string;
  version: string;
  commit: string | null;
}

export interface PerformanceMetrics {
  avg_build_time_ms: number | null;
  avg_test_time_ms: number | null;
  p95_build_time_ms: number | null;
  p95_test_time_ms: number | null;
  avg_api_latency_ms: number | null;
  p95_api_latency_ms: number | null;
}

export interface WorkflowMetrics {
  total_workflows: number;
  active_workflows: number;
  completed_workflows: number;
  failed_workflows: number;
  success_rate_pct: number;
  avg_workflow_duration_ms: number | null;
  avg_tasks_per_workflow: number | null;
}

export interface LLMUsageMetrics {
  total_tokens: number;
  total_cost_usd: number;
  avg_tokens_per_call: number | null;
  total_calls: number;
  model_distribution: Record<string, number>;
  cache_hit_rate_pct: number | null;
}

export interface OmniRouteMetrics {
  health_status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  provider_count: number;
  active_providers: number;
  avg_latency_ms: number | null;
  last_sync_age_ms: number | null;
  // Sprint 4: Cost sync metrics
  cost_sync_enabled: boolean;
  cost_sync_status: 'ok' | 'error' | 'syncing' | 'unknown';
  pending_syncs: number;
  failed_syncs: number;
}

export interface MonitoringDashboardData {
  timestamp: number;
  system_health: SystemHealthMetrics;
  performance: PerformanceMetrics;
  workflows: WorkflowMetrics;
  llm_usage: LLMUsageMetrics;
  omniroute: OmniRouteMetrics;
  persona_metrics: {
    total_invocations: number;
    persona_path_share_pct: number;
    top_personas: Array<{
      agent_id: string;
      total_started: number;
      avg_latency_ms: number | null;
    }>;
  };
  // Sprint 8: Advanced Analytics
  analytics?: {
    performance_trends: Record<string, any>;
    cost_analytics: any;
    routing_analytics: any;
    insights: any[];
  };
}

/**
 * Fetch system health metrics from the daemon state and heartbeat.
 */
export function getSystemHealthMetrics(ctx: {
  version: { version: string; commit?: string };
  serverStartMs: number;
}): SystemHealthMetrics {
  let scheduleTickAgeMs: number | null = null;
  let aliveAtAgeMs: number | null = null;
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  try {
    const db = initDb(getDbPath());
    try {
      const entry = getDaemonState(db, 'schedule_tick');
      if (entry) {
        scheduleTickAgeMs = entry.updated_at > 0 ? Date.now() - entry.updated_at : null;
      }
      const heartbeat = readDaemonHeartbeat(db);
      aliveAtAgeMs = heartbeat ? heartbeat.age_ms : null;

      // Health status determination
      if (aliveAtAgeMs !== null) {
        if (aliveAtAgeMs > 30000) { // 30 seconds
          status = 'unhealthy';
        } else if (aliveAtAgeMs > 15000) { // 15 seconds
          status = 'degraded';
        }
      }

      if (scheduleTickAgeMs !== null && scheduleTickAgeMs > 120000) { // 2 minutes
        status = status === 'healthy' ? 'degraded' : status;
      }
    } finally {
      db.close();
    }
  } catch (err) {
    status = 'unhealthy';
  }

  return {
    status,
    uptime_ms: Date.now() - ctx.serverStartMs,
    daemon_alive_at_age_ms: aliveAtAgeMs,
    last_schedule_tick_age_ms: scheduleTickAgeMs,
    api_version: '1', // From API_VERSION in routes/_shared.ts
    version: ctx.version.version,
    commit: ctx.version.commit ?? null,
  };
}

/**
 * Fetch workflow metrics from the database.
 */
export function getWorkflowMetrics(db: Database.Database): WorkflowMetrics {
  try {
    const totalWorkflows = db.prepare('SELECT COUNT(*) as count FROM workflows').get() as { count: number };
    const activeWorkflows = db.prepare("SELECT COUNT(*) as count FROM workflows WHERE status = 'running'").get() as { count: number };
    const completedWorkflows = db.prepare("SELECT COUNT(*) as count FROM workflows WHERE status = 'completed'").get() as { count: number };
    const failedWorkflows = db.prepare("SELECT COUNT(*) as count FROM workflows WHERE status = 'failed'").get() as { count: number };

    const successRate = totalWorkflows.count > 0
      ? (completedWorkflows.count / totalWorkflows.count) * 100
      : 0;

    // Average workflow duration
    const durationResult = db.prepare(
      'SELECT AVG(completed_at - created_at) as avg_duration FROM workflows WHERE status = "completed" AND completed_at IS NOT NULL'
    ).get() as { avg_duration: number | null };

    // Average tasks per workflow
    const tasksResult = db.prepare(`
      SELECT AVG(task_count) as avg_tasks
      FROM (
        SELECT COUNT(*) as task_count
        FROM tasks
        GROUP BY workflow_id
      )
    `).get() as { avg_tasks: number | null };

    return {
      total_workflows: totalWorkflows.count,
      active_workflows: activeWorkflows.count,
      completed_workflows: completedWorkflows.count,
      failed_workflows: failedWorkflows.count,
      success_rate_pct: Math.round(successRate * 100) / 100,
      avg_workflow_duration_ms: durationResult.avg_duration ? Math.round(durationResult.avg_duration) : null,
      avg_tasks_per_workflow: tasksResult.avg_tasks ? Math.round(tasksResult.avg_tasks * 100) / 100 : null,
    };
  } catch (err) {
    // If tables don't exist yet, return zeros
    return {
      total_workflows: 0,
      active_workflows: 0,
      completed_workflows: 0,
      failed_workflows: 0,
      success_rate_pct: 0,
      avg_workflow_duration_ms: null,
      avg_tasks_per_workflow: null,
    };
  }
}

/**
 * Fetch LLM usage metrics from the events table.
 */
export function getLLMUsageMetrics(db: Database.Database): LLMUsageMetrics {
  try {
    const llmCalls = db.prepare("SELECT payload_json FROM events WHERE type = 'llm_call'").all() as Array<{ payload_json: string | null }>;

    let totalTokens = 0;
    let totalCost = 0;
    const modelDistribution: Record<string, number> = {};
    let totalCalls = 0;

    for (const row of llmCalls) {
      if (!row.payload_json) continue;
      try {
        const payload = JSON.parse(row.payload_json) as {
          total_tokens?: number;
          cost_usd?: number;
          model?: string;
        };
        
        if (payload.total_tokens) totalTokens += payload.total_tokens;
        if (payload.cost_usd) totalCost += payload.cost_usd;
        if (payload.model) {
          modelDistribution[payload.model] = (modelDistribution[payload.model] || 0) + 1;
        }
        totalCalls++;
      } catch {
        // Skip malformed payloads
      }
    }

    const avgTokens = totalCalls > 0 ? Math.round(totalTokens / totalCalls) : null;

    // Cache hit rate from trace spans
    let cacheHits = 0;
    let totalCacheLookups = 0;
    try {
      const spans = db.prepare("SELECT attributes_json FROM trace_spans WHERE kind = 'llm_call'").all() as Array<{ attributes_json: string | null }>;
      for (const span of spans) {
        if (!span.attributes_json) continue;
        try {
          const attrs = JSON.parse(span.attributes_json) as { cache_read_input_tokens?: number };
          totalCacheLookups++;
          if (attrs.cache_read_input_tokens && attrs.cache_read_input_tokens > 0) {
            cacheHits++;
          }
        } catch {
          // Skip malformed attributes
        }
      }
    } catch {
      // trace_spans might not exist yet
    }

    const cacheHitRate = totalCacheLookups > 0 ? Math.round((cacheHits / totalCacheLookups) * 100) : null;

    return {
      total_tokens: totalTokens,
      total_cost_usd: Math.round(totalCost * 10000) / 10000, // Round to 4 decimal places
      avg_tokens_per_call: avgTokens,
      total_calls: totalCalls,
      model_distribution: modelDistribution,
      cache_hit_rate_pct: cacheHitRate,
    };
  } catch (err) {
    return {
      total_tokens: 0,
      total_cost_usd: 0,
      avg_tokens_per_call: null,
      total_calls: 0,
      model_distribution: {},
      cache_hit_rate_pct: null,
    };
  }
}

/**
 * Fetch OmniRoute metrics from health cache (Sprint 3 integration).
 * Enhanced with cost sync metrics (Sprint 4).
 */
export function getOmniRouteMetrics(): OmniRouteMetrics {
  try {
    // Import dynamically to avoid circular dependencies
    const { getCachedHealth, getCacheStats } = require('../../v2/omniroute-bridge/health-cache.js');
    const { getFailoverState } = require('../../v2/omniroute-bridge/failover.js');
    const { getHealthMonitorStats } = require('../../v2/omniroute-bridge/health-monitor.js');
    const { getHealthMetrics } = require('../../v2/omniroute-bridge/health-observability.js');
    const { isAutoCostSyncEnabled, getInProgressSyncs, getSyncStatusCacheStats } = require('../../v2/omniroute-bridge/cost-integration.js');

    const cachedHealth = getCachedHealth();
    const cacheStats = getCacheStats();
    const failoverState = getFailoverState();
    const monitorStats = getHealthMonitorStats();
    const healthMetrics = getHealthMetrics();

    // Cost sync metrics
    const costSyncEnabled = isAutoCostSyncEnabled();
    const pendingSyncs = getInProgressSyncs().length;
    const syncCacheStats = getSyncStatusCacheStats();
    const failedSyncs = syncCacheStats.staleEntries; // Approximate failed syncs as stale entries

    let costSyncStatus: 'ok' | 'error' | 'syncing' | 'unknown' = 'unknown';
    if (!costSyncEnabled) {
      costSyncStatus = 'unknown';
    } else if (pendingSyncs > 0) {
      costSyncStatus = 'syncing';
    } else if (failedSyncs > 0) {
      costSyncStatus = 'error';
    } else {
      costSyncStatus = 'ok';
    }

    if (!cachedHealth) {
      return {
        health_status: 'unknown',
        provider_count: 0,
        active_providers: 0,
        avg_latency_ms: null,
        last_sync_age_ms: null,
        cost_sync_enabled: costSyncEnabled,
        cost_sync_status: costSyncStatus,
        pending_syncs: pendingSyncs,
        failed_syncs: failedSyncs,
      };
    }

    const providers = cachedHealth.providers || {};
    const providerEntries = Object.entries(providers);
    const healthyProviders = providerEntries.filter(([, p]: [string, any]) => p.status === 'healthy').length;
    const degradedProviders = providerEntries.filter(([, p]: [string, any]) => p.status === 'degraded').length;
    const activeProviders = healthyProviders + degradedProviders;

    const latencies = providerEntries
      .map(([, p]: [string, any]) => p.latency_ms)
      .filter((l: number | null) => l != null);
    const avgLatency = latencies.length > 0
      ? latencies.reduce((sum: number, l: number) => sum + l, 0) / latencies.length
      : null;

    // Determine overall health status
    let healthStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' = 'unknown';
    if (failoverState.isFailoverActive) {
      healthStatus = 'unhealthy';
    } else if (cachedHealth.status === 'error') {
      healthStatus = 'unhealthy';
    } else if (healthyProviders === providerEntries.length && providerEntries.length > 0) {
      healthStatus = 'healthy';
    } else if (degradedProviders > 0 || healthyProviders > 0) {
      healthStatus = 'degraded';
    }

    // Use health metrics if available, otherwise fall back to cache stats
    const lastSyncAge = healthMetrics ? cacheStats.cacheAge : cacheStats.cacheAge;

    return {
      health_status: healthStatus,
      provider_count: providerEntries.length,
      active_providers: activeProviders,
      avg_latency_ms: avgLatency ? Math.round(avgLatency) : null,
      last_sync_age_ms: lastSyncAge,
      cost_sync_enabled: costSyncEnabled,
      cost_sync_status: costSyncStatus,
      pending_syncs: pendingSyncs,
      failed_syncs: failedSyncs,
    };
  } catch (err) {
    // If modules are not available, return unknown status
    return {
      health_status: 'unknown',
      provider_count: 0,
      active_providers: 0,
      avg_latency_ms: null,
      last_sync_age_ms: null,
      cost_sync_enabled: false,
      cost_sync_status: 'unknown',
      pending_syncs: 0,
      failed_syncs: 0,
    };
  }
}

/**
 * Fetch performance metrics from recent builds/tests.
 * In a real implementation, this would read from a performance metrics store.
 */
export function getPerformanceMetrics(): PerformanceMetrics {
  // Placeholder - would be populated from CI performance baselines
  return {
    avg_build_time_ms: null,
    avg_test_time_ms: null,
    p95_build_time_ms: null,
    p95_test_time_ms: null,
    avg_api_latency_ms: null,
    p95_api_latency_ms: null,
  };
}

/**
 * Compile all monitoring dashboard data.
 */
export function getMonitoringDashboardData(ctx: {
  version: { version: string; commit?: string };
  serverStartMs: number;
  includeAnalytics?: boolean; // Sprint 8: Optional analytics inclusion
}): MonitoringDashboardData {
  const db = initDb(getDbPath());
  try {
    const systemHealth = getSystemHealthMetrics(ctx);
    const workflows = getWorkflowMetrics(db);
    const llmUsage = getLLMUsageMetrics(db);
    const omniroute = getOmniRouteMetrics();
    const performance = getPerformanceMetrics();
    
    // Persona metrics
    const personaStats = getPersonaMetrics(db);
    const personaShare = getPersonaVsLegacyShare(db);
    
    const totalInvocations = personaStats.reduce((sum, p) => sum + p.total_started + p.total_rejected, 0);
    const topPersonas = personaStats.slice(0, 5).map(p => ({
      agent_id: p.agent_id,
      total_started: p.total_started,
      avg_latency_ms: p.avg_latency_ms,
    }));

    const result: MonitoringDashboardData = {
      timestamp: Date.now(),
      system_health: systemHealth,
      performance,
      workflows,
      llm_usage: llmUsage,
      omniroute,
      persona_metrics: {
        total_invocations: totalInvocations,
        persona_path_share_pct: personaShare.persona_path_share_pct,
        top_personas: topPersonas,
      },
    };

    // Sprint 8: Include advanced analytics if requested
    if (ctx.includeAnalytics) {
      try {
        const analyticsReport = getAnalyticsReport();
        result.analytics = {
          performance_trends: analyticsReport.performance_trends,
          cost_analytics: analyticsReport.cost_analytics,
          routing_analytics: analyticsReport.routing_analytics,
          insights: analyticsReport.insights,
        };
      } catch (err) {
        // Analytics optional - don't fail if it errors
        console.warn('Failed to fetch analytics data:', err);
      }
    }

    return result;
  } finally {
    db.close();
  }
}

/**
 * Health check threshold configuration (Sprint 0 targets).
 */
export const HEALTH_THRESHOLDS = {
  // System health
  DAEMON_ALIVE_THRESHOLD_MS: 15000, // 15 seconds
  SCHEDULE_TICK_THRESHOLD_MS: 120000, // 2 minutes
  
  // Performance targets (Sprint 0)
  BUILD_TIME_TARGET_MS: 180000, // 3 minutes
  TEST_TIME_TARGET_MS: 45000, // 45 seconds
  API_LATENCY_TARGET_P95_MS: 100, // 100ms
  
  // Workflow targets
  SUCCESS_RATE_TARGET_PCT: 95, // 95%
  
  // Cache targets
  CACHE_HIT_RATE_TARGET_PCT: 80, // 80%
} as const;