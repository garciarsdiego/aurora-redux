/**
 * Rate Limit Configuration Sync
 *
 * Synchronizes rate limit configuration between Aurora and OmniRoute.
 * Fetches OmniRoute's reported limits and updates adaptive limiters accordingly.
 */

import type { OmniRouteRateLimitInfo } from './types.js';
import type { AdaptiveLimiter } from './adaptive-limiter.js';
import { checkDetailedHealth } from '../omniroute-bridge/client.js';

export interface ConfigSyncOptions {
  /** Sync interval in milliseconds. */
  syncIntervalMs?: number;
  /** Whether to enable auto-sync on a timer. */
  autoSync?: boolean;
  /** Callback when sync completes. */
  onSyncComplete?: (limits: Map<string, OmniRouteRateLimitInfo>) => void;
  /** Callback when sync fails. */
  onSyncError?: (error: Error) => void;
}

export class RateLimitConfigSync {
  private readonly syncIntervalMs: number;
  private readonly autoSync: boolean;
  private readonly onSyncComplete?: (limits: Map<string, OmniRouteRateLimitInfo>) => void;
  private readonly onSyncError?: (error: Error) => void;
  private adaptiveLimiters: Set<AdaptiveLimiter>;
  private syncTimer?: ReturnType<typeof setInterval>;
  private isRunning: boolean;
  private lastSyncTime: number;
  private cachedLimits: Map<string, OmniRouteRateLimitInfo>;

  constructor(opts: ConfigSyncOptions = {}) {
    this.syncIntervalMs = opts.syncIntervalMs ?? 60_000; // Default 1 minute
    this.autoSync = opts.autoSync ?? false;
    this.onSyncComplete = opts.onSyncComplete;
    this.onSyncError = opts.onSyncError;
    this.adaptiveLimiters = new Set();
    this.isRunning = false;
    this.lastSyncTime = 0;
    this.cachedLimits = new Map();
  }

  /**
   * Register an adaptive limiter to receive sync updates.
   */
  registerLimiter(limiter: AdaptiveLimiter): void {
    this.adaptiveLimiters.add(limiter);
  }

  /**
   * Unregister an adaptive limiter.
   */
  unregisterLimiter(limiter: AdaptiveLimiter): void {
    this.adaptiveLimiters.delete(limiter);
  }

  /**
   * Start auto-sync timer.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;

    if (this.autoSync) {
      this.syncTimer = setInterval(() => {
        this.sync().catch((err) => {
          if (this.onSyncError) {
            this.onSyncError(err);
          }
        });
      }, this.syncIntervalMs);
    }

    // Initial sync
    this.sync().catch((err) => {
      if (this.onSyncError) {
        this.onSyncError(err);
      }
    });
  }

  /**
   * Stop auto-sync timer.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  /**
   * Manually trigger a sync with OmniRoute.
   */
  async sync(): Promise<Map<string, OmniRouteRateLimitInfo>> {
    try {
      const limits = await this.fetchOmniRouteLimits();
      this.cachedLimits = limits;

      // Update all registered adaptive limiters
      for (const limiter of this.adaptiveLimiters) {
        for (const limitInfo of limits.values()) {
          limiter.updateOmniRouteLimit(limitInfo);
        }
      }

      this.lastSyncTime = Date.now();

      if (this.onSyncComplete) {
        this.onSyncComplete(limits);
      }

      return limits;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (this.onSyncError) {
        this.onSyncError(err);
      }
      throw err;
    }
  }

  /**
   * Get the last sync time.
   */
  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  /**
   * Get cached limits.
   */
  getCachedLimits(): Map<string, OmniRouteRateLimitInfo> {
    return new Map(this.cachedLimits);
  }

  /**
   * Check if sync is currently running.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Fetch rate limits from OmniRoute health endpoint.
   */
  private async fetchOmniRouteLimits(): Promise<Map<string, OmniRouteRateLimitInfo>> {
    const limits = new Map<string, OmniRouteRateLimitInfo>();

    try {
      const healthResult = await checkDetailedHealth();

      if (healthResult.ok && healthResult.data) {
        const { rate_limits } = healthResult.data;

        // Convert rate_limits to our format
        for (const [endpoint, limit] of Object.entries(rate_limits)) {
          limits.set(endpoint, {
            endpoint,
            remaining: limit.remaining,
            resetIn: limit.reset_in,
          });
        }
      }
    } catch (error) {
      // If OmniRoute health check fails, return empty map
      // Adaptive limiters will fall back to their base RPM
      console.warn('[rate-limit-config-sync] Failed to fetch OmniRoute limits:', error);
    }

    return limits;
  }
}

/**
 * Global config sync instance (singleton pattern).
 */
let globalConfigSync: RateLimitConfigSync | null = null;

/**
 * Get or create the global config sync instance.
 */
export function getGlobalConfigSync(opts?: ConfigSyncOptions): RateLimitConfigSync {
  if (!globalConfigSync) {
    globalConfigSync = new RateLimitConfigSync(opts);
  }
  return globalConfigSync;
}

/**
 * Reset the global config sync instance (test-only).
 */
export function __testing_resetGlobalConfigSync(): void {
  if (globalConfigSync) {
    globalConfigSync.stop();
    globalConfigSync = null;
  }
}