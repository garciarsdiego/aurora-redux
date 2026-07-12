/**
 * OmniRoute Cost Sync Module (Sprint 4)
 *
 * Implements cost synchronization between OmniRoute and the local ledger.
 * Tracks costs by workflow and provides cost-based decision support for routing.
 */

import type Database from 'better-sqlite3';
import { costReport, type CostReportResult, type CostReportEntry } from './client.js';
import { logInfo, logWarn, logError, logDebug } from '../observability/log-aggregation.js';
import { sumModelCallCostForWorkflow, recordModelCall } from '../llm-ledger/store.js';

// ── Additional Types for Compatibility with Existing Modules ─────────────

export interface OmniRouteCostReport {
  total_usd: number;
  by_task: CostReportEntry[];
  by_model: Record<string, number>;
  timestamp: number;
}

export interface CostSyncResponse {
  sync_status: 'success' | 'error' | 'pending';
  workflow_id: string;
  aurora_cost_usd: number;
  omniroute_cost_usd: number;
  discrepancy_usd: number;
  synced_at: number | null;
  error_message: string | null;
}

export interface CostSyncConfig {
  /** Interval between cost syncs in milliseconds (default: 60 seconds) */
  syncIntervalMs: number;
  /** Whether to automatically sync costs for active workflows */
  autoSync: boolean;
  /** Whether to log detailed cost sync information */
  verboseLogging: boolean;
  /** Maximum number of workflow IDs to track in sync queue */
  maxQueueSize: number;
}

export interface WorkflowCostSummary {
  workflowId: string;
  localCostUsd: number;
  remoteCostUsd: number;
  syncedAt: number | null;
  lastSyncError: string | null;
  syncStatus: 'pending' | 'synced' | 'error';
}

export interface CostSyncStats {
  isRunning: boolean;
  syncCount: number;
  lastSyncAt: number | null;
  lastSyncDuration: number | null;
  queueSize: number;
  totalWorkflowsTracked: number;
  successfulSyncs: number;
  failedSyncs: number;
}

const DEFAULT_CONFIG: CostSyncConfig = {
  syncIntervalMs: 60 * 1000, // 60 seconds
  autoSync: true,
  verboseLogging: false,
  maxQueueSize: 100,
};

/**
 * Fetch the local (ledger) and remote (OmniRoute) cost for a workflow.
 * Shared by the sync loop and the compatibility functions below.
 */
async function fetchCostPair(
  db: Database.Database,
  workflowId: string,
): Promise<{ localCost: number; remoteCost: number; error: string | null; report: CostReportResult | null }> {
  // Get local cost from ledger
  const localCost = sumModelCallCostForWorkflow(db, workflowId);

  // Get remote cost from OmniRoute
  const remoteResult = await costReport(workflowId);

  if (!remoteResult.ok || !remoteResult.data) {
    return { localCost, remoteCost: 0, error: remoteResult.error ?? 'Unknown error', report: null };
  }

  return { localCost, remoteCost: remoteResult.data.total_usd, error: null, report: remoteResult.data };
}

class CostSync {
  private config: CostSyncConfig;
  private db: Database.Database | null = null;
  private isRunning: boolean = false;
  private intervalId: NodeJS.Timeout | null = null;
  private syncQueue: Set<string> = new Set();
  private workflowCosts: Map<string, WorkflowCostSummary> = new Map();
  private syncCount: number = 0;
  private lastSyncAt: number | null = null;
  private lastSyncDuration: number | null = null;
  private successfulSyncs: number = 0;
  private failedSyncs: number = 0;

  constructor(config: Partial<CostSyncConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize the cost sync module with a database connection
   */
  initialize(db: Database.Database): void {
    this.db = db;
    logInfo('OmniRoute cost sync initialized', { config: this.config }, 'omniroute-cost-sync');
  }

  /**
   * Start the cost sync loop
   */
  start(): void {
    if (this.isRunning) {
      logWarn('Cost sync is already running', {}, 'omniroute-cost-sync');
      return;
    }

    if (!this.db) {
      logError('Cost sync cannot start: database not initialized', {}, 'omniroute-cost-sync');
      return;
    }

    this.isRunning = true;
    logInfo('OmniRoute cost sync STARTED', { intervalMs: this.config.syncIntervalMs }, 'omniroute-cost-sync');

    // Run initial sync immediately
    this.runSync();

    // Schedule periodic syncs
    this.intervalId = setInterval(() => {
      this.runSync();
    }, this.config.syncIntervalMs);
  }

  /**
   * Stop the cost sync loop
   */
  stop(): void {
    if (!this.isRunning) {
      logWarn('Cost sync is not running', {}, 'omniroute-cost-sync');
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logInfo('OmniRoute cost sync STOPPED', {
      syncCount: this.syncCount,
      successfulSyncs: this.successfulSyncs,
      failedSyncs: this.failedSyncs,
    }, 'omniroute-cost-sync');
  }

  /**
   * Add a workflow to the sync queue
   */
  enqueueWorkflow(workflowId: string): void {
    if (this.syncQueue.size >= this.config.maxQueueSize) {
      logWarn('Cost sync queue full, dropping oldest workflow', { queueSize: this.syncQueue.size }, 'omniroute-cost-sync');
      const oldest = this.syncQueue.values().next().value;
      if (oldest) this.syncQueue.delete(oldest);
    }

    this.syncQueue.add(workflowId);

    // Initialize workflow cost summary if not exists
    if (!this.workflowCosts.has(workflowId)) {
      this.workflowCosts.set(workflowId, {
        workflowId,
        localCostUsd: this.db ? sumModelCallCostForWorkflow(this.db, workflowId) : 0,
        remoteCostUsd: 0,
        syncedAt: null,
        lastSyncError: null,
        syncStatus: 'pending',
      });
    }

    logDebug('Workflow added to cost sync queue', { workflowId, queueSize: this.syncQueue.size }, 'omniroute-cost-sync');
  }

  /**
   * Remove a workflow from the sync queue
   */
  dequeueWorkflow(workflowId: string): void {
    this.syncQueue.delete(workflowId);
    logDebug('Workflow removed from cost sync queue', { workflowId }, 'omniroute-cost-sync');
  }

  /**
   * Run a single sync iteration for all queued workflows
   */
  private async runSync(): Promise<void> {
    if (!this.isRunning && this.syncCount > 0) {
      return;
    }

    const startTime = Date.now();
    this.syncCount++;

    try {
      if (this.syncQueue.size === 0) {
        if (this.config.verboseLogging) {
          logDebug('Cost sync queue empty, skipping sync', {}, 'omniroute-cost-sync');
        }
        return;
      }

      logInfo('Cost sync started', { queueSize: this.syncQueue.size }, 'omniroute-cost-sync');

      // Sync each workflow in the queue
      const workflowIds = Array.from(this.syncQueue);
      for (const workflowId of workflowIds) {
        await this.syncWorkflowCost(workflowId);
      }

      this.lastSyncAt = Date.now();
      this.lastSyncDuration = this.lastSyncAt - startTime;

      logInfo('Cost sync completed', {
        workflowCount: workflowIds.length,
        durationMs: this.lastSyncDuration,
        successfulSyncs: this.successfulSyncs,
        failedSyncs: this.failedSyncs,
      }, 'omniroute-cost-sync');
    } catch (error) {
      this.lastSyncAt = Date.now();
      this.lastSyncDuration = this.lastSyncAt - startTime;
      this.failedSyncs++;

      const errorMsg = error instanceof Error ? error.message : String(error);
      logError('Cost sync EXCEPTION', {
        error: errorMsg,
        durationMs: this.lastSyncDuration,
      }, 'omniroute-cost-sync');
    }
  }

  /**
   * Sync costs for a single workflow
   */
  private async syncWorkflowCost(workflowId: string): Promise<void> {
    if (!this.db) return;

    try {
      const { localCost, remoteCost, error: syncError, report } = await fetchCostPair(this.db, workflowId);

      if (!syncError) {
        // Update local ledger with remote cost data if available
        if (report?.by_task && report.by_task.length > 0) {
          await this.mergeRemoteCostData(workflowId, report.by_task);
        }

        this.successfulSyncs++;
      } else {
        this.failedSyncs++;

        if (this.config.verboseLogging) {
          logWarn('Cost sync failed for workflow', {
            workflowId,
            error: syncError,
          }, 'omniroute-cost-sync');
        }
      }

      // Update workflow cost summary
      const summary: WorkflowCostSummary = {
        workflowId,
        localCostUsd: localCost,
        remoteCostUsd: remoteCost,
        syncedAt: syncError ? null : Date.now(),
        lastSyncError: syncError,
        syncStatus: syncError ? 'error' : 'synced',
      };
      this.workflowCosts.set(workflowId, summary);

      // Remove from queue after sync (will be re-added if new costs incurred)
      this.syncQueue.delete(workflowId);

      if (this.config.verboseLogging) {
        logDebug('Workflow cost synced', {
          workflowId,
          localCostUsd: localCost,
          remoteCostUsd: remoteCost,
          syncStatus: summary.syncStatus,
        }, 'omniroute-cost-sync');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logError('Workflow cost sync EXCEPTION', {
        workflowId,
        error: errorMsg,
      }, 'omniroute-cost-sync');

      const summary = this.workflowCosts.get(workflowId);
      if (summary) {
        summary.lastSyncError = errorMsg;
        summary.syncStatus = 'error';
        this.workflowCosts.set(workflowId, summary);
      }
    }
  }

  /**
   * Merge remote cost data into local ledger
   */
  private async mergeRemoteCostData(workflowId: string, byTask: CostReportEntry[]): Promise<void> {
    if (!this.db) return;

    try {
      // This is a simplified merge - in production, you'd want more sophisticated
      // reconciliation logic to handle conflicts and ensure data consistency
      for (const entry of byTask) {
        // Check if we already have cost data for this task
        const existing = this.db
          .prepare(`SELECT * FROM model_calls WHERE task_id = ? AND workflow_id = ?`)
          .get(entry.task_id, workflowId) as { id: string } | undefined;

        if (!existing && entry.cost_usd > 0) {
          // Record the cost if we don't have it locally
          // Note: We don't have full token counts from the remote, so we record cost only
          recordModelCall(this.db, {
            workflowId,
            taskId: entry.task_id,
            model: 'omniroute-remote',
            provider: 'omniroute',
            costUsd: entry.cost_usd,
            source: 'cost-sync',
            kind: 'llm_call',
          });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logError('Failed to merge remote cost data', {
        workflowId,
        error: errorMsg,
      }, 'omniroute-cost-sync');
    }
  }

  /**
   * Get cost summary for a workflow
   */
  getWorkflowCostSummary(workflowId: string): WorkflowCostSummary | null {
    return this.workflowCosts.get(workflowId) ?? null;
  }

  /**
   * Get all workflow cost summaries
   */
  getAllWorkflowCostSummaries(): WorkflowCostSummary[] {
    return Array.from(this.workflowCosts.values());
  }

  /**
   * Get total cost across all tracked workflows
   */
  getTotalCost(): { localUsd: number; remoteUsd: number } {
    let localUsd = 0;
    let remoteUsd = 0;

    for (const summary of this.workflowCosts.values()) {
      localUsd += summary.localCostUsd;
      remoteUsd += summary.remoteCostUsd;
    }

    return { localUsd, remoteUsd };
  }

  /**
   * Get cost sync statistics
   */
  getStats(): CostSyncStats {
    return {
      isRunning: this.isRunning,
      syncCount: this.syncCount,
      lastSyncAt: this.lastSyncAt,
      lastSyncDuration: this.lastSyncDuration,
      queueSize: this.syncQueue.size,
      totalWorkflowsTracked: this.workflowCosts.size,
      successfulSyncs: this.successfulSyncs,
      failedSyncs: this.failedSyncs,
    };
  }

  /**
   * Update cost sync configuration
   */
  updateConfig(config: Partial<CostSyncConfig>): void {
    const wasRunning = this.isRunning;
    const oldInterval = this.config.syncIntervalMs;

    this.config = { ...this.config, ...config };

    logInfo('Cost sync configuration updated', {
      oldIntervalMs: oldInterval,
      newIntervalMs: this.config.syncIntervalMs,
    }, 'omniroute-cost-sync');

    // Restart if interval changed and sync is running
    if (wasRunning && oldInterval !== this.config.syncIntervalMs) {
      this.stop();
      this.start();
    }
  }

  /**
   * Manually trigger a sync for a specific workflow
   */
  async triggerManualSync(workflowId: string): Promise<void> {
    logInfo('Manual cost sync triggered', { workflowId }, 'omniroute-cost-sync');
    this.enqueueWorkflow(workflowId);
    await this.syncWorkflowCost(workflowId);
  }

  /**
   * Manually trigger a sync for all queued workflows
   */
  async triggerManualSyncAll(): Promise<void> {
    logInfo('Manual cost sync triggered for all workflows', {}, 'omniroute-cost-sync');
    await this.runSync();
  }
}

/**
 * Global cost sync instance
 */
export const costSync = new CostSync();

/**
 * Initialize the cost sync module with a database connection
 */
export function initializeCostSync(db: Database.Database): void {
  costSync.initialize(db);
}

/**
 * Start the cost sync with optional config
 */
export function startCostSync(config?: Partial<CostSyncConfig>): void {
  if (config) {
    costSync.updateConfig(config);
  }
  costSync.start();
}

/**
 * Stop the cost sync
 */
export function stopCostSync(): void {
  costSync.stop();
}

/**
 * Get cost sync statistics
 */
export function getCostSyncStats(): CostSyncStats {
  return costSync.getStats();
}

/**
 * Enqueue a workflow for cost syncing
 */
export function enqueueWorkflowForCostSync(workflowId: string): void {
  costSync.enqueueWorkflow(workflowId);
}

/**
 * Get cost summary for a workflow
 */
export function getWorkflowCostSummary(workflowId: string): WorkflowCostSummary | null {
  return costSync.getWorkflowCostSummary(workflowId);
}

/**
 * Get total cost across all tracked workflows
 */
export function getTotalTrackedCost(): { localUsd: number; remoteUsd: number } {
  return costSync.getTotalCost();
}

// ── Additional Functions for Compatibility with Existing Modules ─────────

/**
 * Sync workflow costs to OmniRoute (compatibility function)
 */
export async function syncWorkflowCostsToOmniRoute(
  db: Database.Database,
  workflowId: string,
): Promise<CostSyncResponse> {
  try {
    const { localCost, remoteCost, error } = await fetchCostPair(db, workflowId);

    if (error) {
      return {
        sync_status: 'error',
        workflow_id: workflowId,
        aurora_cost_usd: localCost,
        omniroute_cost_usd: 0,
        discrepancy_usd: localCost,
        synced_at: null,
        error_message: error,
      };
    }

    const discrepancy = Math.abs(localCost - remoteCost);

    return {
      sync_status: 'success',
      workflow_id: workflowId,
      aurora_cost_usd: localCost,
      omniroute_cost_usd: remoteCost,
      discrepancy_usd: discrepancy,
      synced_at: Date.now(),
      error_message: null,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      sync_status: 'error',
      workflow_id: workflowId,
      aurora_cost_usd: 0,
      omniroute_cost_usd: 0,
      discrepancy_usd: 0,
      synced_at: null,
      error_message: errorMsg,
    };
  }
}

/**
 * Get OmniRoute cost report (compatibility function)
 */
export async function getOmniRouteCostReport(
  params?: { workflow_id?: string },
): Promise<{ ok: boolean; data?: OmniRouteCostReport; error?: string }> {
  if (!params?.workflow_id) {
    return {
      ok: false,
      error: 'workflow_id is required',
    };
  }

  try {
    const result = await costReport(params.workflow_id);
    
    if (!result.ok || !result.data) {
      return {
        ok: false,
        error: result.error ?? 'Failed to get cost report',
      };
    }

    // Convert to OmniRouteCostReport format
    const byModel: Record<string, number> = {};
    for (const entry of result.data.by_task) {
      // Simple aggregation by model (in production, you'd have model info in the entry)
      byModel['unknown'] = (byModel['unknown'] ?? 0) + entry.cost_usd;
    }

    const report: OmniRouteCostReport = {
      total_usd: result.data.total_usd,
      by_task: result.data.by_task,
      by_model: byModel,
      timestamp: Date.now(),
    };

    return {
      ok: true,
      data: report,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: errorMsg,
    };
  }
}

/**
 * Compare costs between Aurora and OmniRoute (compatibility function)
 */
export async function compareCosts(
  db: Database.Database,
  workflowId: string,
): Promise<{
  aurora_cost_usd: number;
  omniroute_cost_usd: number;
  discrepancy_usd: number;
  discrepancy_pct: number;
}> {
  const { localCost, remoteCost } = await fetchCostPair(db, workflowId);

  const discrepancy = Math.abs(localCost - remoteCost);
  const discrepancyPct = remoteCost > 0 ? (discrepancy / remoteCost) * 100 : 0;

  return {
    aurora_cost_usd: localCost,
    omniroute_cost_usd: remoteCost,
    discrepancy_usd: discrepancy,
    discrepancy_pct: discrepancyPct,
  };
}