/**
 * OmniRoute Health Monitoring Module (Sprint 3)
 *
 * Provides continuous background health monitoring for OmniRoute.
 * Runs periodic health checks and integrates with failover logic.
 */

import { refreshHealthStatus } from './health-cache.js';
import { detailedHealthFallback, tallyProviderHealth, type DetailedHealthResult } from './client.js';
import { evaluateAndCheckFailover, getFailoverState, type FailoverState } from './failover.js';
import { logInfo, logWarn, logError } from '../observability/log-aggregation.js';

export interface HealthMonitorConfig {
  /** Interval between health checks in milliseconds (default: 30 seconds) */
  checkIntervalMs: number;
  /** Whether to automatically evaluate failover on each check */
  autoEvaluateFailover: boolean;
  /** Whether to log detailed health status on each check */
  verboseLogging: boolean;
  /** Callback function when health status changes */
  onHealthChange?: (oldStatus: string, newStatus: string, health: DetailedHealthResult) => void;
  /** Callback function when failover state changes */
  onFailoverChange?: (oldState: FailoverState, newState: FailoverState) => void;
}

export interface HealthMonitorStats {
  isRunning: boolean;
  checkCount: number;
  lastCheckAt: number | null;
  lastCheckDuration: number | null;
  lastHealthStatus: string;
  failoverState: FailoverState;
  uptimeMs: number | null;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 30 * 1000, // 30 seconds
  autoEvaluateFailover: true,
  verboseLogging: false,
};

class HealthMonitor {
  private config: HealthMonitorConfig;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private checkCount: number = 0;
  private lastCheckAt: number | null = null;
  private lastCheckDuration: number | null = null;
  private lastHealthStatus: string = 'unknown';
  private lastFailoverState: FailoverState | null = null;
  private startedAt: number | null = null;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the health monitoring loop
   */
  start(): void {
    if (this.isRunning) {
      logWarn('Health monitor is already running', {}, 'omniroute-health-monitor');
      return;
    }

    this.isRunning = true;
    this.startedAt = Date.now();
    logInfo('OmniRoute health monitor STARTED', { intervalMs: this.config.checkIntervalMs }, 'omniroute-health-monitor');

    // Run initial check immediately
    this.runHealthCheck();

    // Schedule periodic checks
    this.intervalId = setInterval(() => {
      this.runHealthCheck();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the health monitoring loop
   */
  stop(): void {
    if (!this.isRunning) {
      logWarn('Health monitor is not running', {}, 'omniroute-health-monitor');
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const uptime = this.startedAt ? Date.now() - this.startedAt : 0;
    logInfo('OmniRoute health monitor STOPPED', { uptimeMs: uptime, checkCount: this.checkCount }, 'omniroute-health-monitor');
    this.startedAt = null;
  }

  /**
   * Run a single health check
   */
  private async runHealthCheck(): Promise<void> {
    if (!this.isRunning && this.checkCount > 0) {
      // Allow first check even if not started, but skip subsequent checks
      return;
    }

    const startTime = Date.now();
    this.checkCount++;

    try {
      // Refresh health status from OmniRoute
      const result = await refreshHealthStatus();
      this.lastCheckAt = Date.now();
      this.lastCheckDuration = this.lastCheckAt - startTime;

      if (result.ok && result.data) {
        const newStatus = this.determineHealthStatus(result.data);
        const oldStatus = this.lastHealthStatus;

        // Log health status
        if (this.config.verboseLogging || newStatus !== oldStatus) {
          logInfo('OmniRoute health check completed', {
            status: newStatus,
            providerCount: Object.keys(result.data.providers || {}).length,
            durationMs: this.lastCheckDuration,
            checkCount: this.checkCount,
          }, 'omniroute-health-monitor');
        }

        // Detect health status change
        if (newStatus !== oldStatus) {
          logWarn('OmniRoute health status CHANGED', {
            oldStatus,
            newStatus,
          }, 'omniroute-health-monitor');
          this.lastHealthStatus = newStatus;
          this.config.onHealthChange?.(oldStatus, newStatus, result.data);
        }

        // Auto-evaluate failover if enabled
        if (this.config.autoEvaluateFailover) {
          const failoverResult = await evaluateAndCheckFailover();
          const newFailoverState = failoverResult.state;

          // Detect failover state change
          if (this.lastFailoverState && JSON.stringify(newFailoverState) !== JSON.stringify(this.lastFailoverState)) {
            logWarn('OmniRoute failover state CHANGED', {
              wasActive: this.lastFailoverState.isFailoverActive,
              isActive: newFailoverState.isFailoverActive,
              consecutiveFailures: newFailoverState.consecutiveFailures,
            }, 'omniroute-health-monitor');
            this.config.onFailoverChange?.(this.lastFailoverState, newFailoverState);
          }

          this.lastFailoverState = newFailoverState;
        }
      } else {
        // Health check failed
        logError('OmniRoute health check FAILED', {
          error: result.error,
          durationMs: this.lastCheckDuration,
        }, 'omniroute-health-monitor');

        this.markUnhealthy();
      }
    } catch (error) {
      this.lastCheckAt = Date.now();
      this.lastCheckDuration = this.lastCheckAt - startTime;

      const errorMsg = error instanceof Error ? error.message : String(error);
      logError('OmniRoute health check EXCEPTION', {
        error: errorMsg,
        durationMs: this.lastCheckDuration,
      }, 'omniroute-health-monitor');

      this.markUnhealthy();
    }
  }

  /**
   * Transition to 'unhealthy' status, notifying onHealthChange with the
   * correct oldStatus (captured before lastHealthStatus is overwritten).
   */
  private markUnhealthy(): void {
    const newStatus = 'unhealthy';
    if (newStatus !== this.lastHealthStatus) {
      const oldStatus = this.lastHealthStatus;
      this.lastHealthStatus = newStatus;
      this.config.onHealthChange?.(oldStatus, newStatus, detailedHealthFallback());
    }
  }

  /**
   * Determine overall health status from detailed health result
   */
  private determineHealthStatus(health: DetailedHealthResult): string {
    if (health.status === 'error') {
      return 'unhealthy';
    }

    const tally = tallyProviderHealth(health.providers || {});

    if (tally.providerCount === 0) {
      return health.status === 'ok' ? 'healthy' : 'unhealthy';
    }

    // Shared rule: >50% unhealthy → unhealthy; all healthy → healthy; else degraded
    return tally.status;
  }

  /**
   * Get monitor statistics
   */
  getStats(): HealthMonitorStats {
    return {
      isRunning: this.isRunning,
      checkCount: this.checkCount,
      lastCheckAt: this.lastCheckAt,
      lastCheckDuration: this.lastCheckDuration,
      lastHealthStatus: this.lastHealthStatus,
      failoverState: getFailoverState(),
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
    };
  }

  /**
   * Update monitor configuration
   */
  updateConfig(config: Partial<HealthMonitorConfig>): void {
    const wasRunning = this.isRunning;
    const oldInterval = this.config.checkIntervalMs;

    this.config = { ...this.config, ...config };

    logInfo('Health monitor configuration updated', {
      oldIntervalMs: oldInterval,
      newIntervalMs: this.config.checkIntervalMs,
    }, 'omniroute-health-monitor');

    // Restart if interval changed and monitor is running
    if (wasRunning && oldInterval !== this.config.checkIntervalMs) {
      this.stop();
      this.start();
    }
  }

  /**
   * Manually trigger a health check (useful for testing or on-demand checks)
   */
  async triggerManualCheck(): Promise<void> {
    logInfo('Manual health check triggered', {}, 'omniroute-health-monitor');
    await this.runHealthCheck();
  }
}

/**
 * Global health monitor instance
 */
export const healthMonitor = new HealthMonitor();

/**
 * Start the health monitor with optional config
 */
export function startHealthMonitor(config?: Partial<HealthMonitorConfig>): void {
  if (config) {
    healthMonitor.updateConfig(config);
  }
  healthMonitor.start();
}

/**
 * Stop the health monitor
 */
export function stopHealthMonitor(): void {
  healthMonitor.stop();
}

/**
 * Get health monitor statistics
 */
export function getHealthMonitorStats(): HealthMonitorStats {
  return healthMonitor.getStats();
}

/**
 * Trigger a manual health check
 */
export async function triggerManualHealthCheck(): Promise<void> {
  await healthMonitor.triggerManualCheck();
}

/**
 * Check if health monitor is running
 */
export function isHealthMonitorRunning(): boolean {
  return healthMonitor.getStats().isRunning;
}