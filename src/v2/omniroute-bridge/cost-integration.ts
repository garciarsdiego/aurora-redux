/**
 * Cost Integration Module
 *
 * Integrates cost synchronization with workflow lifecycle.
 * Automatically syncs costs to OmniRoute on workflow completion.
 * Retries failed syncs when OmniRoute health is restored.
 */

import type Database from 'better-sqlite3';
import { syncWorkflowCostsToOmniRoute } from './cost-sync.js';
import { updateSyncStatusCache, markSyncInProgress, markSyncComplete, getCachedSyncStatus } from './cost-cache.js';
import { shouldAllowOmniRouteRequest } from './failover.js';
import { logInfo, logWarn, logError, logDebug } from '../observability/log-aggregation.js';
import { insertEvent } from '../../db/persist.js';

// ── Configuration ─────────────────────────────────────────────────────────

/**
 * Enable/disable automatic cost sync on workflow completion
 * Default: true
 */
export function isAutoCostSyncEnabled(): boolean {
  const envValue = process.env.OMNIFORGE_AUTO_COST_SYNC;
  if (envValue === undefined) return true; // Default to enabled
  return envValue === 'true' || envValue === '1';
}

/**
 * Enable/disable cost sync on workflow failure
 * Default: true (sync even failed workflows for cost tracking)
 */
export function isCostSyncOnFailureEnabled(): boolean {
  const envValue = process.env.OMNIFORGE_COST_SYNC_ON_FAILURE;
  if (envValue === undefined) return true; // Default to enabled
  return envValue === 'true' || envValue === '1';
}

// ── Cost Sync Integration ─────────────────────────────────────────────────

/**
 * Sync workflow costs to OmniRoute (called on workflow completion)
 *
 * This function is non-blocking - it runs in the background and does not
 * affect workflow completion status. Errors are logged but do not propagate.
 */
export async function syncWorkflowCostsOnCompletion(
  db: Database.Database,
  workflowId: string,
  workflowStatus: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  // Check if auto-sync is enabled
  if (!isAutoCostSyncEnabled()) {
    logDebug('Auto cost sync disabled, skipping workflow cost sync', { workflowId }, 'omniroute-cost-integration');
    return;
  }

  // Check if sync on failure is enabled (for failed/cancelled workflows)
  if (workflowStatus !== 'completed' && !isCostSyncOnFailureEnabled()) {
    logDebug('Cost sync on failure disabled, skipping workflow cost sync', { workflowId, workflowStatus }, 'omniroute-cost-integration');
    return;
  }

  // Check if sync is already in progress for this workflow
  if (markSyncInProgress !== undefined && markSyncInProgress(workflowId)) {
    logDebug('Cost sync already in progress for workflow', { workflowId }, 'omniroute-cost-integration');
    return;
  }

  try {
    logInfo('Starting cost sync for workflow', { workflowId, workflowStatus }, 'omniroute-cost-integration');

    // Emit cost sync start event
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'cost_sync_started',
      payload: {
        workflow_status: workflowStatus,
      },
    });

    // Perform the sync
    const syncResult = await syncWorkflowCostsToOmniRoute(db, workflowId);

    // Update cache
    updateSyncStatusCache(workflowId, syncResult);

    // Emit cost sync completed event
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'cost_sync_completed',
      payload: {
        sync_status: syncResult.sync_status,
        aurora_cost_usd: syncResult.aurora_cost_usd,
        omniroute_cost_usd: syncResult.omniroute_cost_usd,
        discrepancy_usd: syncResult.discrepancy_usd,
        synced_at: syncResult.synced_at,
        error_message: syncResult.error_message,
      },
    });

    if (syncResult.sync_status === 'success') {
      logInfo('Workflow costs synced successfully to OmniRoute', {
        workflowId,
        totalCost: syncResult.aurora_cost_usd,
      }, 'omniroute-cost-integration');
    } else if (syncResult.sync_status === 'error') {
      logWarn('Workflow cost sync failed', {
        workflowId,
        error: syncResult.error_message,
      }, 'omniroute-cost-integration');
    } else {
      logError('Workflow cost sync pending', {
        workflowId,
      }, 'omniroute-cost-integration');
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // Emit cost sync failed event
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'cost_sync_failed',
      payload: {
        error: errorMsg,
      },
    });

    logError('Exception during workflow cost sync', {
      workflowId,
      error: errorMsg,
    }, 'omniroute-cost-integration');
  } finally {
    // Mark sync as complete
    if (markSyncComplete !== undefined) {
      markSyncComplete(workflowId);
    }
  }
}

/**
 * Sync workflow costs to OmniRoute (blocking version)
 *
 * Use this when you need to wait for the sync to complete before proceeding.
 * Returns the sync result for inspection.
 */
export async function syncWorkflowCostsBlocking(
  db: Database.Database,
  workflowId: string,
) {
  return await syncWorkflowCostsToOmniRoute(db, workflowId);
}

// ── Manual Cost Sync Trigger ─────────────────────────────────────────────

/**
 * Manually trigger cost sync for a workflow
 *
 * This can be called via MCP tool or API endpoint to manually sync costs
 * for a specific workflow (e.g., after a failed sync).
 */
export async function triggerManualCostSync(
  db: Database.Database,
  workflowId: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  try {
    logInfo('Manual cost sync triggered', { workflowId }, 'omniroute-cost-integration');

    const result = await syncWorkflowCostsToOmniRoute(db, workflowId);
    updateSyncStatusCache(workflowId, result);

    insertEvent(db, {
      workflow_id: workflowId,
      type: 'cost_sync_manual',
      payload: {
        sync_status: result.sync_status,
        aurora_cost_usd: result.aurora_cost_usd,
        omniroute_cost_usd: result.omniroute_cost_usd,
        discrepancy_usd: result.discrepancy_usd,
      },
    });

    return { success: result.sync_status === 'success', result };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError('Manual cost sync failed', { workflowId, error: errorMsg }, 'omniroute-cost-integration');
    return { success: false, error: errorMsg };
  }
}

// ── Batch Cost Sync ─────────────────────────────────────────────────────

/**
 * Sync costs for multiple workflows (batch operation)
 *
 * Useful for backfilling historical data or periodic bulk sync.
 */
export async function syncWorkflowCostsBatch(
  db: Database.Database,
  workflowIds: string[],
  options?: { concurrent?: number; onProgress?: (completed: number, total: number) => void },
): Promise<{ succeeded: string[]; failed: Array<{ workflowId: string; error: string }> }> {
  const concurrent = options?.concurrent ?? 5;
  const onProgress = options?.onProgress;

  const succeeded: string[] = [];
  const failed: Array<{ workflowId: string; error: string }> = [];

  let completed = 0;

  // Process in batches
  for (let i = 0; i < workflowIds.length; i += concurrent) {
    const batch = workflowIds.slice(i, i + concurrent);
    const promises = batch.map(async (workflowId) => {
      try {
        const result = await syncWorkflowCostsToOmniRoute(db, workflowId);
        updateSyncStatusCache(workflowId, result);

        if (result.sync_status === 'success') {
          succeeded.push(workflowId);
        } else {
          failed.push({ workflowId, error: result.error_message || 'Sync failed' });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        failed.push({ workflowId, error: errorMsg });
      }
    });

    await Promise.all(promises);
    completed += batch.length;
    onProgress?.(completed, workflowIds.length);
  }

  logInfo('Batch cost sync completed', {
    total: workflowIds.length,
    succeeded: succeeded.length,
    failed: failed.length,
  }, 'omniroute-cost-integration');

  return { succeeded, failed };
}

// ── Health-Based Retry ─────────────────────────────────────────────────

/**
 * Retry failed cost syncs when OmniRoute health is restored
 *
 * This function should be called when OmniRoute health transitions from
 * unhealthy/failover to healthy. It will retry all workflows that had
 * failed syncs due to OmniRoute being unavailable.
 */
export async function retryFailedSyncsOnHealthRestore(
  db: Database.Database,
  workflowIds: string[],
): Promise<{ retried: number; succeeded: number; failed: number }> {
  if (!shouldAllowOmniRouteRequest()) {
    logWarn('OmniRoute still unhealthy, skipping retry of failed syncs', {}, 'omniroute-cost-integration');
    return { retried: 0, succeeded: 0, failed: 0 };
  }

  let retried = 0;
  let succeeded = 0;
  let failed = 0;

  for (const workflowId of workflowIds) {
    const syncStatus = getCachedSyncStatus(workflowId);

    // Only retry if previous sync failed
    if (syncStatus && (syncStatus.sync_status === 'error' || syncStatus.sync_status === 'pending')) {
      retried++;

      try {
        logInfo('Retrying cost sync for workflow after health restore', { workflowId }, 'omniroute-cost-integration');

        const result = await syncWorkflowCostsToOmniRoute(db, workflowId);
        updateSyncStatusCache(workflowId, result);

        insertEvent(db, {
          workflow_id: workflowId,
          type: 'cost_sync_retried',
          payload: {
            previous_status: syncStatus.sync_status,
            new_status: result.sync_status,
          },
        });

        if (result.sync_status === 'success') {
          succeeded++;
          logInfo('Cost sync retry succeeded', { workflowId }, 'omniroute-cost-integration');
        } else {
          failed++;
          logWarn('Cost sync retry failed', { workflowId, error: result.error_message }, 'omniroute-cost-integration');
        }
      } catch (error) {
        failed++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        logError('Cost sync retry exception', { workflowId, error: errorMsg }, 'omniroute-cost-integration');
      }
    }
  }

  logInfo('Failed cost syncs retry completed', {
    retried,
    succeeded,
    failed,
  }, 'omniroute-cost-integration');

  return { retried, succeeded, failed };
}

/**
 * Get workflows with failed syncs (for health restore retry)
 *
 * Queries the database to find workflows that had failed cost syncs.
 */
export function getWorkflowsWithFailedSyncs(db: Database.Database, limit = 100): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT workflow_id
       FROM events
       WHERE type IN ('cost_sync_failed', 'cost_sync_started')
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ workflow_id: string }>;

  return rows.map((row) => row.workflow_id);
}