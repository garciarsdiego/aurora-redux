/**
 * OmniRoute Health Observability Integration (Sprint 3)
 *
 * Integrates health checks with the observability system (tracing, metrics, logging).
 * Provides structured health metrics and trace spans for monitoring dashboards.
 */

import type Database from 'better-sqlite3';
import { startTraceSpan, endTraceSpan, type TraceSpanKind } from '../observability/tracing.js';
import { logInfo, logWarn, logError, logDebug } from '../observability/log-aggregation.js';
import { checkBasicHealth, checkDetailedHealth, type HealthCheckResult, type DetailedHealthResult } from './client.js';
import { getCachedHealth, getCacheStats } from './health-cache.js';
import { getFailoverState, type FailoverState } from './failover.js';
import { getHealthMonitorStats, type HealthMonitorStats } from './health-monitor.js';

export interface HealthMetrics {
  timestamp: number;
  omniroute_status: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  provider_count: number;
  healthy_providers: number;
  degraded_providers: number;
  unhealthy_providers: number;
  avg_latency_ms: number | null;
  cache_age_ms: number;
  cache_hit: boolean;
  failover_active: boolean;
  consecutive_failures: number;
  monitor_running: boolean;
  monitor_check_count: number;
  monitor_last_check_age_ms: number | null;
}

export interface HealthObservabilityConfig {
  /** Whether to create trace spans for health checks */
  enableTracing: boolean;
  /** Whether to log detailed health metrics */
  enableDetailedLogging: boolean;
  /** Default workflow ID for trace spans (can be overridden) */
  defaultWorkflowId: string;
}

const DEFAULT_CONFIG: HealthObservabilityConfig = {
  enableTracing: true,
  enableDetailedLogging: true,
  defaultWorkflowId: 'omniroute-health-check',
};

class HealthObservability {
  private config: HealthObservabilityConfig;
  private metricsHistory: HealthMetrics[] = [];
  private maxHistorySize = 1000;

  constructor(config: Partial<HealthObservabilityConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Perform a health check with observability integration
   */
  async healthCheckWithObservability(
    db: Database.Database,
    options: {
      workflowId?: string;
      taskId?: string;
      parentSpanId?: string;
      detailed?: boolean;
    } = {}
  ): Promise<HealthCheckResult> {
    const workflowId = options.workflowId || this.config.defaultWorkflowId;
    const spanName = options.detailed ? 'omniroute.detailed_health_check' : 'omniroute.basic_health_check';
    const spanKind: TraceSpanKind = 'custom';

    let spanId: string | null = null;

    // Start trace span if tracing is enabled
    if (this.config.enableTracing) {
      const span = startTraceSpan(db, {
        workflowId,
        taskId: options.taskId || null,
        parentSpanId: options.parentSpanId || null,
        name: spanName,
        kind: spanKind,
        attributes: {
          check_type: options.detailed ? 'detailed' : 'basic',
        },
      });
      spanId = span.id;
    }

    const startTime = Date.now();

    try {
      // Perform the actual health check
      const result = options.detailed
        ? await checkDetailedHealth()
        : await checkBasicHealth();

      const duration = Date.now() - startTime;

      // End trace span
      if (spanId) {
        endTraceSpan(db, spanId, {
          status: result.ok ? 'ok' : 'error',
          attributes: {
            duration_ms: duration,
            success: result.ok,
            error: result.error || null,
            ...this.extractHealthAttributes(result.data),
          },
        });
      }

      // Log result
      if (this.config.enableDetailedLogging) {
        if (result.ok) {
          logInfo('OmniRoute health check completed', {
            type: options.detailed ? 'detailed' : 'basic',
            duration_ms: duration,
            status: result.data?.status,
          }, 'omniroute-health-observability');
        } else {
          logError('OmniRoute health check failed', {
            type: options.detailed ? 'detailed' : 'basic',
            duration_ms: duration,
            error: result.error,
          }, 'omniroute-health-observability');
        }
      }

      // Record metrics
      this.recordMetrics(result, duration);

      return result as any;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // End trace span with error
      if (spanId) {
        endTraceSpan(db, spanId, {
          status: 'error',
          attributes: {
            duration_ms: duration,
            error: errorMsg,
          },
        });
      }

      logError('OmniRoute health check exception', {
        type: options.detailed ? 'detailed' : 'basic',
        duration_ms: duration,
        error: errorMsg,
      }, 'omniroute-health-observability');

      throw error;
    }
  }

  /**
   * Extract health attributes for trace spans
   */
  private extractHealthAttributes(data?: DetailedHealthResult | { status: string; timestamp: string }): Record<string, unknown> {
    if (!data) return {};

    const attrs: Record<string, unknown> = {
      health_status: data.status,
      timestamp: data.timestamp,
    };

    if ('providers' in data && data.providers) {
      const providers = data.providers as Record<string, { status: string; latency_ms: number }>;
      const providerEntries = Object.entries(providers);
      attrs.provider_count = providerEntries.length;
      attrs.healthy_providers = providerEntries.filter(([, p]) => p.status === 'healthy').length;
      attrs.degraded_providers = providerEntries.filter(([, p]) => p.status === 'degraded').length;
      attrs.unhealthy_providers = providerEntries.filter(([, p]) => p.status === 'unhealthy').length;

      const latencies = providerEntries.map(([, p]) => p.latency_ms).filter((l): l is number => l != null);
      if (latencies.length > 0) {
        attrs.avg_latency_ms = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
      }
    }

    return attrs;
  }

  /**
   * Record health metrics
   */
  private recordMetrics(result: any, durationMs: number): void {
    const now = Date.now();
    const failoverState = getFailoverState();
    const monitorStats = getHealthMonitorStats();
    const cacheStats = getCacheStats();

    let omnirouteStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown' = 'unknown';
    let providerCount = 0;
    let healthyProviders = 0;
    let degradedProviders = 0;
    let unhealthyProviders = 0;
    let avgLatencyMs: number | null = null;

    if (result.ok && result.data && 'providers' in result.data) {
      const providers = result.data.providers as Record<string, { status: string; latency_ms: number }>;
      const providerEntries = Object.entries(providers);
      providerCount = providerEntries.length;
      healthyProviders = providerEntries.filter(([, p]) => p.status === 'healthy').length;
      degradedProviders = providerEntries.filter(([, p]) => p.status === 'degraded').length;
      unhealthyProviders = providerEntries.filter(([, p]) => p.status === 'unhealthy').length;

      const latencies = providerEntries.map(([, p]) => p.latency_ms).filter((l): l is number => l != null);
      if (latencies.length > 0) {
        avgLatencyMs = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
      }

      if (unhealthyProviders / providerCount > 0.5) {
        omnirouteStatus = 'unhealthy';
      } else if (healthyProviders === providerCount) {
        omnirouteStatus = 'healthy';
      } else {
        omnirouteStatus = 'degraded';
      }
    } else if (result.ok) {
      omnirouteStatus = 'healthy';
    } else {
      omnirouteStatus = 'unhealthy';
    }

    const metrics: HealthMetrics = {
      timestamp: now,
      omniroute_status: omnirouteStatus,
      provider_count: providerCount,
      healthy_providers: healthyProviders,
      degraded_providers: degradedProviders,
      unhealthy_providers: unhealthyProviders,
      avg_latency_ms: avgLatencyMs,
      cache_age_ms: cacheStats.cacheAge,
      cache_hit: !cacheStats.isStale,
      failover_active: failoverState.isFailoverActive,
      consecutive_failures: failoverState.consecutiveFailures,
      monitor_running: monitorStats.isRunning,
      monitor_check_count: monitorStats.checkCount,
      monitor_last_check_age_ms: monitorStats.lastCheckAt ? now - monitorStats.lastCheckAt : null,
    };

    this.metricsHistory.push(metrics);

    // Trim history
    if (this.metricsHistory.length > this.maxHistorySize) {
      this.metricsHistory = this.metricsHistory.slice(-this.maxHistorySize);
    }
  }

  /**
   * Get current health metrics
   */
  getCurrentMetrics(): HealthMetrics | null {
    return this.metricsHistory.length > 0 ? this.metricsHistory[this.metricsHistory.length - 1] : null;
  }

  /**
   * Get metrics history
   */
  getMetricsHistory(since?: number): HealthMetrics[] {
    if (!since) {
      return [...this.metricsHistory];
    }
    return this.metricsHistory.filter(m => m.timestamp >= since);
  }

  /**
   * Get aggregated health statistics over a time window
   */
  getHealthStatistics(windowMs: number = 5 * 60 * 1000): {
    total_checks: number;
    healthy_count: number;
    degraded_count: number;
    unhealthy_count: number;
    avg_latency_ms: number | null;
    failover_count: number;
    uptime_percentage: number;
  } {
    const now = Date.now();
    const cutoff = now - windowMs;
    const recentMetrics = this.metricsHistory.filter(m => m.timestamp >= cutoff);

    if (recentMetrics.length === 0) {
      return {
        total_checks: 0,
        healthy_count: 0,
        degraded_count: 0,
        unhealthy_count: 0,
        avg_latency_ms: null,
        failover_count: 0,
        uptime_percentage: 0,
      };
    }

    const healthyCount = recentMetrics.filter(m => m.omniroute_status === 'healthy').length;
    const degradedCount = recentMetrics.filter(m => m.omniroute_status === 'degraded').length;
    const unhealthyCount = recentMetrics.filter(m => m.omniroute_status === 'unhealthy').length;
    const failoverCount = recentMetrics.filter(m => m.failover_active).length;

    const latencies = recentMetrics
      .map(m => m.avg_latency_ms)
      .filter((l): l is number => l != null);
    const avgLatency = latencies.length > 0
      ? latencies.reduce((sum, l) => sum + l, 0) / latencies.length
      : null;

    const uptimePercentage = ((healthyCount + degradedCount) / recentMetrics.length) * 100;

    return {
      total_checks: recentMetrics.length,
      healthy_count: healthyCount,
      degraded_count: degradedCount,
      unhealthy_count: unhealthyCount,
      avg_latency_ms: avgLatency,
      failover_count: failoverCount,
      uptime_percentage: Math.round(uptimePercentage * 100) / 100,
    };
  }

  /**
   * Clear metrics history
   */
  clearMetricsHistory(): void {
    this.metricsHistory = [];
  }

  /**
   * Update observability configuration
   */
  updateConfig(config: Partial<HealthObservabilityConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Global health observability instance
 */
export const healthObservability = new HealthObservability();

/**
 * Perform health check with observability (convenience function)
 */
export async function healthCheckWithObs(
  db: Database.Database,
  options?: {
    workflowId?: string;
    taskId?: string;
    parentSpanId?: string;
    detailed?: boolean;
  }
): Promise<HealthCheckResult> {
  return healthObservability.healthCheckWithObservability(db, options);
}

/**
 * Get current health metrics
 */
export function getHealthMetrics(): HealthMetrics | null {
  return healthObservability.getCurrentMetrics();
}

/**
 * Get health statistics
 */
export function getHealthStatistics(windowMs?: number) {
  return healthObservability.getHealthStatistics(windowMs);
}

/**
 * Get metrics history
 */
export function getHealthMetricsHistory(since?: number): HealthMetrics[] {
  return healthObservability.getMetricsHistory(since);
}