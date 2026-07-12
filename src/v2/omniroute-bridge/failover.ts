/**
 * OmniRoute Failover Module (Sprint 3)
 *
 * Implements automatic failover logic when OmniRoute is unhealthy.
 * Tracks failure history, determines when to trigger failover,
 * and provides fallback strategies.
 */

import { checkDetailedHealth, tallyProviderHealth, type HealthCheckResult, type DetailedHealthResult, type ProviderHealthStatus } from './client.js';
import { getCachedHealth, getCacheStats } from './health-cache.js';
import { logError, logWarn, logInfo } from '../observability/log-aggregation.js';

export interface FailoverConfig {
  /** Number of consecutive failures before triggering failover */
  failureThreshold: number;
  /** Time window in ms to consider failures (default: 5 minutes) */
  failureWindowMs: number;
  /** Minimum health percentage required to avoid failover (0-100) */
  minHealthPercentage: number;
  /** Whether to fail open (allow requests) or fail closed (block requests) */
  failOpen: boolean;
  /** Time in ms to wait before retrying after failover */
  retryAfterMs: number;
}

export interface FailureEvent {
  timestamp: number;
  error: string;
  healthStatus?: 'ok' | 'error';
  providerStatuses?: Record<string, ProviderHealthStatus>;
}

export interface FailoverState {
  isFailoverActive: boolean;
  failoverActivatedAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  failureHistory: FailureEvent[];
  lastHealthCheckAt: number | null;
  currentHealthStatus: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
}

const DEFAULT_CONFIG: FailoverConfig = {
  failureThreshold: 3,
  failureWindowMs: 5 * 60 * 1000, // 5 minutes
  minHealthPercentage: 50, // At least 50% of providers must be healthy
  failOpen: true, // Default to fail open for better availability
  retryAfterMs: 60 * 1000, // 1 minute
};

class FailoverManager {
  private config: FailoverConfig;
  private state: FailoverState;
  private failureHistory: FailureEvent[] = [];
  private maxHistorySize = 100;

  constructor(config: Partial<FailoverConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      isFailoverActive: false,
      failoverActivatedAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      failureHistory: [],
      lastHealthCheckAt: null,
      currentHealthStatus: 'unknown',
    };
  }

  /**
   * Check if failover should be activated based on health check result
   */
  async evaluateFailover(): Promise<boolean> {
    const now = Date.now();
    this.state.lastHealthCheckAt = now;

    try {
      // First try to get cached health (fast path)
      const cached = getCachedHealth();
      let healthResult: HealthCheckResult;

      if (cached) {
        healthResult = { ok: true, data: cached };
        const cacheAge = now - new Date(cached.timestamp).getTime();
        logInfo('Using cached health status for failover evaluation', { cacheAge }, 'omniroute-failover');
      } else {
        // If no cache, perform detailed health check
        healthResult = await checkDetailedHealth();
      }

      if (!healthResult.ok || !healthResult.data) {
        this.recordFailure('Health check failed: ' + (healthResult.error || 'Unknown error'));
        return this.shouldTriggerFailover(now);
      }

      const health = healthResult.data;
      this.state.currentHealthStatus = this.determineOverallHealth(health);

      if (this.state.currentHealthStatus === 'unhealthy') {
        this.recordFailure('OmniRoute is unhealthy', health);
        return this.shouldTriggerFailover(now);
      }

      if (this.state.currentHealthStatus === 'degraded') {
        logWarn('OmniRoute is degraded but not failing over', { health }, 'omniroute-failover');
        // Don't fail over on degraded, just warn
        return false;
      }

      // Health is good - reset consecutive failures
      if (this.state.consecutiveFailures > 0) {
        logInfo('OmniRoute health recovered, resetting failure count', { consecutiveFailures: this.state.consecutiveFailures }, 'omniroute-failover');
      }
      this.state.consecutiveFailures = 0;

      // If failover was active, check if we can recover
      if (this.state.isFailoverActive && this.canRecoverFromFailover(now)) {
        this.deactivateFailover(now);
      }

      return false;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.recordFailure('Health check exception: ' + errorMsg);
      logError('Exception during health check evaluation', { error: errorMsg }, 'omniroute-failover');
      return this.shouldTriggerFailover(now);
    }
  }

  /**
   * Determine overall health status from detailed health result
   */
  private determineOverallHealth(health: DetailedHealthResult): 'healthy' | 'degraded' | 'unhealthy' {
    if (health.status === 'error') {
      return 'unhealthy';
    }

    const tally = tallyProviderHealth(health.providers || {});

    if (tally.providerCount === 0) {
      // No provider data - assume healthy if overall status is ok
      return health.status === 'ok' ? 'healthy' : 'unhealthy';
    }

    const healthPercentage = (tally.healthyCount / tally.providerCount) * 100;

    // If more than 50% are unhealthy, overall status is unhealthy
    if (tally.unhealthyCount / tally.providerCount > 0.5) {
      return 'unhealthy';
    }

    // If health percentage is below threshold, consider it degraded
    if (healthPercentage < this.config.minHealthPercentage) {
      return 'degraded';
    }

    // If any are degraded but overall is healthy, mark as degraded
    if (tally.degradedCount > 0) {
      return 'degraded';
    }

    return 'healthy';
  }

  /**
   * Record a failure event
   */
  private recordFailure(error: string, health?: DetailedHealthResult): void {
    const now = Date.now();
    const event: FailureEvent = {
      timestamp: now,
      error,
      healthStatus: health?.status,
      providerStatuses: health?.providers,
    };

    this.failureHistory.push(event);
    this.state.lastFailureAt = now;
    this.state.consecutiveFailures++;

    // Trim history
    if (this.failureHistory.length > this.maxHistorySize) {
      this.failureHistory = this.failureHistory.slice(-this.maxHistorySize);
    }

    // Clean old failures outside the window
    this.cleanOldFailures(now);
  }

  /**
   * Remove failure events outside the time window
   */
  private cleanOldFailures(now: number): void {
    const cutoff = now - this.config.failureWindowMs;
    this.failureHistory = this.failureHistory.filter(f => f.timestamp > cutoff);
    this.state.failureHistory = this.failureHistory;
  }

  /**
   * Determine if failover should be triggered based on failure history
   */
  private shouldTriggerFailover(now: number): boolean {
    this.cleanOldFailures(now);

    // Trigger when either the consecutive-failure threshold or the
    // total-failures-in-window threshold is exceeded
    if (
      this.state.consecutiveFailures >= this.config.failureThreshold ||
      this.failureHistory.length >= this.config.failureThreshold
    ) {
      if (!this.state.isFailoverActive) {
        this.activateFailover(now);
      }
      return true;
    }

    return false;
  }

  /**
   * Activate failover mode
   */
  private activateFailover(now: number): void {
    this.state.isFailoverActive = true;
    this.state.failoverActivatedAt = now;
    logError('OmniRoute failover ACTIVATED', {
      consecutiveFailures: this.state.consecutiveFailures,
      failureCount: this.failureHistory.length,
      failOpen: this.config.failOpen,
    }, 'omniroute-failover');
  }

  /**
   * Deactivate failover mode (recovery)
   */
  private deactivateFailover(now: number): void {
    const duration = this.state.failoverActivatedAt ? now - this.state.failoverActivatedAt : 0;
    this.state.isFailoverActive = false;
    this.state.failoverActivatedAt = null;
    logInfo('OmniRoute failover DEACTIVATED (recovered)', {
      durationMs: duration,
    }, 'omniroute-failover');
  }

  /**
   * Check if we can recover from failover
   */
  private canRecoverFromFailover(now: number): boolean {
    if (!this.state.failoverActivatedAt) {
      return true; // Not in failover
    }

    const timeSinceActivation = now - this.state.failoverActivatedAt;
    return timeSinceActivation >= this.config.retryAfterMs;
  }

  /**
   * Get current failover state
   */
  getFailoverState(): FailoverState {
    return { ...this.state, failureHistory: [...this.failureHistory] };
  }

  /**
   * Manually activate failover (for testing or emergency)
   */
  manualActivateFailover(): void {
    const now = Date.now();
    this.activateFailover(now);
  }

  /**
   * Manually deactivate failover (for testing or recovery)
   */
  manualDeactivateFailover(): void {
    const now = Date.now();
    this.deactivateFailover(now);
    this.state.consecutiveFailures = 0;
  }

  /**
   * Check if a request should be allowed based on failover state
   */
  shouldAllowRequest(): boolean {
    if (!this.state.isFailoverActive) {
      return true; // Not in failover, allow all requests
    }

    // In failover mode, check failOpen config
    return this.config.failOpen;
  }

  /**
   * Update failover configuration
   */
  updateConfig(config: Partial<FailoverConfig>): void {
    this.config = { ...this.config, ...config };
    logInfo('Failover configuration updated', { config: this.config }, 'omniroute-failover');
  }

  /**
   * Get failover statistics
   */
  getStats() {
    const now = Date.now();
    return {
      ...this.state,
      config: this.config,
      cacheStats: getCacheStats(),
      timeSinceLastFailure: this.state.lastFailureAt ? now - this.state.lastFailureAt : null,
      timeSinceFailoverActivation: this.state.failoverActivatedAt ? now - this.state.failoverActivatedAt : null,
    };
  }

  /**
   * Reset failover state (for testing)
   */
  reset(): void {
    this.state = {
      isFailoverActive: false,
      failoverActivatedAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      failureHistory: [],
      lastHealthCheckAt: null,
      currentHealthStatus: 'unknown',
    };
    this.failureHistory = [];
  }
}

/**
 * Global failover manager instance
 */
export const failoverManager = new FailoverManager();

/**
 * Convenience function to evaluate failover and get result
 */
export async function evaluateAndCheckFailover(): Promise<{
  shouldFailover: boolean;
  state: FailoverState;
  shouldAllowRequest: boolean;
}> {
  const shouldFailover = await failoverManager.evaluateFailover();
  const state = failoverManager.getFailoverState();
  const shouldAllowRequest = failoverManager.shouldAllowRequest();

  return { shouldFailover, state, shouldAllowRequest };
}

/**
 * Check if OmniRoute is currently in failover mode
 */
export function isFailoverActive(): boolean {
  return failoverManager.getFailoverState().isFailoverActive;
}

/**
 * Check if requests should be allowed based on failover state
 */
export function shouldAllowOmniRouteRequest(): boolean {
  return failoverManager.shouldAllowRequest();
}

/**
 * Get current failover state
 */
export function getFailoverState(): FailoverState {
  return failoverManager.getFailoverState();
}

/**
 * Manually activate failover mode
 * TODO: Implement proper manual failover activation
 */
export async function manualActivateFailover(): Promise<{ success: boolean; message: string }> {
  logWarn('Manual failover activation not yet implemented', {}, 'omniroute-failover');
  return { success: false, message: 'Manual failover activation not yet implemented' };
}

/**
 * Manually deactivate failover mode
 * TODO: Implement proper manual failover deactivation
 */
export async function manualDeactivateFailover(): Promise<{ success: boolean; message: string }> {
  logWarn('Manual failover deactivation not yet implemented', {}, 'omniroute-failover');
  return { success: false, message: 'Manual failover deactivation not yet implemented' };
}