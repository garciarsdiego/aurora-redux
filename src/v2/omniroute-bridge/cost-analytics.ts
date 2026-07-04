/**
 * Cost Analytics Module
 *
 * Provides cost analytics and metrics for dashboard visualization.
 * Integrates with observability system for cost tracking over time.
 */

import type Database from 'better-sqlite3';
import { getLedgerForWorkflow, listModelCallsForWorkflow } from '../llm-ledger/store.js';
import type { OmniRouteCostReport } from './cost-sync.js';
import { getCachedCostReport, updateCostReportCache } from './cost-cache.js';
import { getOmniRouteCostReport } from './cost-sync.js';
import { logInfo, logWarn, logError } from '../observability/log-aggregation.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface CostMetrics {
  timestamp: number;
  workflow_id?: string;
  aurora_cost_usd: number;
  omniroute_cost_usd: number;
  discrepancy_usd: number;
  discrepancy_pct: number;
  total_calls: number;
  total_tokens: number;
  avg_cost_per_call: number;
}

export interface CostAnalyticsSummary {
  period_start: number;
  period_end: number;
  total_workflows: number;
  total_cost_usd: number;
  total_calls: number;
  avg_cost_per_workflow: number;
  top_models: Array<{ model: string; cost: number; calls: number }>;
  cost_trend: 'increasing' | 'decreasing' | 'stable';
  trend_pct: number;
}

export interface ModelCostBreakdown {
  model: string;
  provider: string | null;
  total_cost: number;
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_cost_per_call: number;
  avg_cost_per_1k_tokens: number;
}

// ── Cost Metrics Collection ───────────────────────────────────────────────

/**
 * Get current cost metrics for a specific workflow
 */
export function getWorkflowCostMetrics(
  db: Database.Database,
  workflowId: string,
): CostMetrics {
  const ledger = getLedgerForWorkflow(db, workflowId);
  const modelCalls = listModelCallsForWorkflow(db, workflowId);

  // Get OmniRoute cost report
  const omnirouteReport = getCachedCostReport();
  const omnirouteCost = omnirouteReport?.total_usd || 0;

  const discrepancy = Math.abs(ledger.totalUsd - omnirouteCost);
  const discrepancyPct = ledger.totalUsd > 0 ? (discrepancy / ledger.totalUsd) * 100 : 0;
  const avgCostPerCall = ledger.totalCalls > 0 ? ledger.totalUsd / ledger.totalCalls : 0;
  const totalTokens = ledger.totalInputTokens + ledger.totalOutputTokens;

  return {
    timestamp: Date.now(),
    workflow_id: workflowId,
    aurora_cost_usd: ledger.totalUsd,
    omniroute_cost_usd: omnirouteCost,
    discrepancy_usd: discrepancy,
    discrepancy_pct: discrepancyPct,
    total_calls: ledger.totalCalls,
    total_tokens: totalTokens,
    avg_cost_per_call: avgCostPerCall,
  };
}

/**
 * Get global cost metrics (across all workflows)
 */
export function getGlobalCostMetrics(db: Database.Database): CostMetrics {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(*) AS total_calls,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS total_output_tokens
       FROM model_calls`,
    )
    .get() as {
      total_cost: number;
      total_calls: number;
      total_input_tokens: number;
      total_output_tokens: number;
    };

  const omnirouteReport = getCachedCostReport();
  const omnirouteCost = omnirouteReport?.total_usd || 0;

  const discrepancy = Math.abs(row.total_cost - omnirouteCost);
  const discrepancyPct = row.total_cost > 0 ? (discrepancy / row.total_cost) * 100 : 0;
  const avgCostPerCall = row.total_calls > 0 ? row.total_cost / row.total_calls : 0;
  const totalTokens = row.total_input_tokens + row.total_output_tokens;

  return {
    timestamp: Date.now(),
    aurora_cost_usd: row.total_cost,
    omniroute_cost_usd: omnirouteCost,
    discrepancy_usd: discrepancy,
    discrepancy_pct: discrepancyPct,
    total_calls: row.total_calls,
    total_tokens: totalTokens,
    avg_cost_per_call: avgCostPerCall,
  };
}

// ── Cost Analytics ────────────────────────────────────────────────────────

/**
 * Get cost breakdown by model
 */
export function getModelCostBreakdown(
  db: Database.Database,
  workflowId?: string,
): ModelCostBreakdown[] {
  const query = workflowId
    ? `SELECT model,
              provider,
              COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(*) AS total_calls,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS total_output_tokens
       FROM model_calls
       WHERE workflow_id = ?
       GROUP BY model, provider
       ORDER BY total_cost DESC`
    : `SELECT model,
              provider,
              COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(*) AS total_calls,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS total_output_tokens
       FROM model_calls
       GROUP BY model, provider
       ORDER BY total_cost DESC`;

  const params = workflowId ? [workflowId] : [];
  const rows = db.prepare(query).all(...params) as Array<{
    model: string;
    provider: string | null;
    total_cost: number;
    total_calls: number;
    total_input_tokens: number;
    total_output_tokens: number;
  }>;

  return rows.map((row) => {
    const totalTokens = row.total_input_tokens + row.total_output_tokens;
    const avgCostPerCall = row.total_calls > 0 ? row.total_cost / row.total_calls : 0;
    const avgCostPer1kTokens = totalTokens > 0 ? (row.total_cost / totalTokens) * 1000 : 0;

    return {
      model: row.model,
      provider: row.provider,
      total_cost: row.total_cost,
      total_calls: row.total_calls,
      total_input_tokens: row.total_input_tokens,
      total_output_tokens: row.total_output_tokens,
      avg_cost_per_call: avgCostPerCall,
      avg_cost_per_1k_tokens: avgCostPer1kTokens,
    };
  });
}

/**
 * Get cost analytics summary for a time period
 */
export function getCostAnalyticsSummary(
  db: Database.Database,
  periodMs: number = 24 * 60 * 60 * 1000, // Default: 24 hours
): CostAnalyticsSummary {
  const now = Date.now();
  const periodStart = now - periodMs;

  // Get workflow count and total cost for the period
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT workflow_id) AS total_workflows,
              COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(*) AS total_calls
       FROM model_calls
       WHERE created_at >= ?`,
    )
    .get(periodStart) as {
      total_workflows: number;
      total_cost: number;
      total_calls: number;
    };

  const avgCostPerWorkflow = row.total_workflows > 0 ? row.total_cost / row.total_workflows : 0;

  // Get top models by cost
  const topModelsRows = db
    .prepare(
      `SELECT model,
              COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(*) AS total_calls
       FROM model_calls
       WHERE created_at >= ?
       GROUP BY model
       ORDER BY total_cost DESC
       LIMIT 5`,
    )
    .all(periodStart) as Array<{ model: string; total_cost: number; total_calls: number }>;

  const topModels = topModelsRows.map((row) => ({
    model: row.model,
    cost: row.total_cost,
    calls: row.total_calls,
  }));

  // Calculate trend (compare with previous period)
  const previousPeriodStart = periodStart - periodMs;
  const previousRow = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
       FROM model_calls
       WHERE created_at >= ? AND created_at < ?`,
    )
    .get(previousPeriodStart, periodStart) as { total_cost: number };

  const currentCost = row.total_cost;
  const previousCost = previousRow.total_cost;

  let costTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  let trendPct = 0;

  if (previousCost > 0) {
    const change = ((currentCost - previousCost) / previousCost) * 100;
    trendPct = Math.abs(change);
    if (change > 5) costTrend = 'increasing';
    else if (change < -5) costTrend = 'decreasing';
  }

  return {
    period_start: periodStart,
    period_end: now,
    total_workflows: row.total_workflows,
    total_cost_usd: row.total_cost,
    total_calls: row.total_calls,
    avg_cost_per_workflow: avgCostPerWorkflow,
    top_models: topModels,
    cost_trend: costTrend,
    trend_pct: trendPct,
  };
}

// ── Cost Report Refresh ─────────────────────────────────────────────────

/**
 * Refresh OmniRoute cost report and update cache
 */
export async function refreshOmniRouteCostReport(): Promise<boolean> {
  try {
    const result = await getOmniRouteCostReport();

    if (result.ok && result.data) {
      updateCostReportCache(result.data, true);
      logInfo('OmniRoute cost report refreshed and cached', {
        totalCost: result.data.total_usd,
      }, 'omniroute-cost-analytics');
      return true;
    } else {
      updateCostReportCache(
        {
          total_usd: 0,
          by_task: [],
          by_model: {},
          timestamp: Date.now(),
        },
        false,
      );
      logWarn('Failed to refresh OmniRoute cost report', {
        error: result.error,
      }, 'omniroute-cost-analytics');
      return false;
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError('Exception refreshing OmniRoute cost report', {
      error: errorMsg,
    }, 'omniroute-cost-analytics');
    return false;
  }
}

// ── Cost Forecasting ────────────────────────────────────────────────────

/**
 * Simple cost forecasting based on historical data
 */
export interface CostForecast {
  period_ms: number;
  forecasted_cost_usd: number;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export function forecastCost(
  db: Database.Database,
  periodMs: number = 24 * 60 * 60 * 1000, // Default: forecast next 24 hours
): CostForecast {
  const now = Date.now();
  const historicalPeriodMs = periodMs; // Use same period for historical data
  const historicalStart = now - historicalPeriodMs;

  // Get historical cost
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_cost,
              COUNT(*) AS total_calls
       FROM model_calls
       WHERE created_at >= ?`,
    )
    .get(historicalStart) as { total_cost: number; total_calls: number };

  const historicalCost = row.total_cost;
  const historicalCalls = row.total_calls;

  // Simple forecast: assume similar usage pattern
  const forecastedCost = historicalCost;

  // Determine confidence based on data volume
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let reasoning = '';

  if (historicalCalls >= 100) {
    confidence = 'high';
    reasoning = `Based on ${historicalCalls} calls in the last period`;
  } else if (historicalCalls >= 20) {
    confidence = 'medium';
    reasoning = `Based on ${historicalCalls} calls in the last period`;
  } else {
    confidence = 'low';
    reasoning = 'Insufficient historical data for accurate forecast';
  }

  return {
    period_ms: periodMs,
    forecasted_cost_usd: forecastedCost,
    confidence,
    reasoning,
  };
}