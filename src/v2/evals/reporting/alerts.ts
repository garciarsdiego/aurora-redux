/**
 * Alerting functions for the Agent Harness observability system.
 * Provides regression detection and Telegram notification integration.
 */

import type { Database } from 'better-sqlite3';
import type {
  RegressionAlert,
  ABTestWinnerAlert,
  OptimizationCompleteAlert,
  EvalRunDetails,
  ABTestDetails,
  OptimizationRunDetails,
} from './types.js';
import { notifyTelegram } from '../../../utils/telegram-notify.js';

// ────────────────────────────────────────────────────────────────────
//  REGRESSION DETECTION
// ────────────────────────────────────────────────────────────────────

/**
 * Configuration for regression detection.
 */
export interface RegressionDetectionConfig {
  /** Threshold for regression detection (default: 5% drop) */
  threshold_pct?: number;
  /** Minimum number of samples required for comparison (default: 3) */
  min_samples?: number;
  /** Metrics to check (if empty, checks all metrics) */
  metrics?: string[];
}

/**
 * Check for score regression by comparing current run against baseline.
 * Returns array of regression alerts (empty if no regression detected).
 */
export function checkRegression(
  db: Database,
  currentRun: EvalRunDetails,
  baselineRunId: string,
  config: RegressionDetectionConfig = {},
): RegressionAlert[] {
  const {
    threshold_pct = 5,
    min_samples = 3,
    metrics: metricsToCheck = [],
  } = config;

  // Fetch baseline run details
  const baselineRun = db.prepare(`
    SELECT
      er.id, er.workspace, er.suite_name, er.status, er.score, er.case_count,
      er.created_at, er.completed_at
    FROM eval_runs er
    WHERE er.id = ?
  `).get(baselineRunId) as {
    id: string;
    workspace: string;
    suite_name: string;
    status: string;
    score: number;
    case_count: number;
    created_at: number;
    completed_at: number | null;
  } | undefined;

  if (!baselineRun) {
    console.warn(`[checkRegression] Baseline run ${baselineRunId} not found`);
    return [];
  }

  // Fetch baseline metric scores
  const baselineMetrics = db.prepare(`
    SELECT
      ems.metric_name,
      AVG(ems.score) as mean_score,
      COUNT(*) as sample_count
    FROM eval_metric_scores ems
    INNER JOIN eval_results er ON ems.result_id = er.id
    WHERE er.run_id = ?
    GROUP BY ems.metric_name
  `).all(baselineRunId) as Array<{
    metric_name: string;
    mean_score: number;
    sample_count: number;
  }>;

  // Build baseline metric map
  const baselineMetricMap = new Map<string, { mean_score: number; sample_count: number }>();
  for (const m of baselineMetrics) {
    baselineMetricMap.set(m.metric_name, { mean_score: m.mean_score, sample_count: m.sample_count });
  }

  // Fetch current metric scores
  const currentMetrics = db.prepare(`
    SELECT
      ems.metric_name,
      AVG(ems.score) as mean_score,
      COUNT(*) as sample_count
    FROM eval_metric_scores ems
    INNER JOIN eval_results er ON ems.result_id = er.id
    WHERE er.run_id = ?
    GROUP BY ems.metric_name
  `).all(currentRun.run.id) as Array<{
    metric_name: string;
    mean_score: number;
    sample_count: number;
  }>;

  // Build current metric map
  const currentMetricMap = new Map<string, { mean_score: number; sample_count: number }>();
  for (const m of currentMetrics) {
    currentMetricMap.set(m.metric_name, { mean_score: m.mean_score, sample_count: m.sample_count });
  }

  // Check for regressions
  const regressions: RegressionAlert[] = [];
  const metricsToCheckSet = new Set(metricsToCheck);

  for (const [metricName, current] of currentMetricMap) {
    // Skip if not in metricsToCheck (if specified)
    if (metricsToCheckSet.size > 0 && !metricsToCheckSet.has(metricName)) {
      continue;
    }

    const baseline = baselineMetricMap.get(metricName);
    if (!baseline) {
      continue; // New metric in current run, skip
    }

    // Skip if sample count is too low
    if (baseline.sample_count < min_samples || current.sample_count < min_samples) {
      continue;
    }

    // Calculate delta percentage
    const deltaPct = ((current.mean_score - baseline.mean_score) / baseline.mean_score) * 100;

    // Check for regression (drop beyond threshold)
    if (deltaPct < -threshold_pct) {
      regressions.push({
        run_id: currentRun.run.id,
        workspace: currentRun.run.workspace,
        suite_name: currentRun.run.suite_name,
        baseline_run_id: baselineRunId,
        metric: metricName,
        baseline_score: baseline.mean_score,
        current_score: current.mean_score,
        delta_pct: deltaPct,
        threshold_pct,
        timestamp: Date.now(),
      });
    }
  }

  return regressions;
}

/**
 * Check for regression against the most recent successful run in the same workspace/suite.
 */
export function checkRegressionAgainstLatest(
  db: Database,
  currentRun: EvalRunDetails,
  config: RegressionDetectionConfig = {},
): RegressionAlert[] {
  // Find the most recent completed run for the same workspace/suite
  const latestRun = db.prepare(`
    SELECT id
    FROM eval_runs
    WHERE workspace = ?
      AND suite_name = ?
      AND status = 'completed'
      AND id != ?
    ORDER BY completed_at DESC
    LIMIT 1
  `).get(
    currentRun.run.workspace,
    currentRun.run.suite_name,
    currentRun.run.id,
  ) as { id: string } | undefined;

  if (!latestRun) {
    console.warn(`[checkRegressionAgainstLatest] No baseline run found for ${currentRun.run.workspace}/${currentRun.run.suite_name}`);
    return [];
  }

  return checkRegression(db, currentRun, latestRun.id, config);
}

// ────────────────────────────────────────────────────────────────────
//  TELEGRAM ALERTS
// ────────────────────────────────────────────────────────────────────

/**
 * Send regression alert via Telegram.
 */
export async function sendRegressionAlert(alert: RegressionAlert): Promise<{ sent: boolean; error?: string }> {
  const message = `
🚨 <b>Eval Regression Detected</b>

<b>Workspace:</b> ${alert.workspace}
<b>Suite:</b> ${alert.suite_name}
<b>Run ID:</b> ${alert.run_id}
<b>Baseline Run:</b> ${alert.baseline_run_id}

<b>Metric:</b> ${alert.metric}
<b>Baseline Score:</b> ${(alert.baseline_score * 100).toFixed(1)}%
<b>Current Score:</b> ${(alert.current_score * 100).toFixed(1)}%
<b>Delta:</b> ${alert.delta_pct.toFixed(1)}% (threshold: -${alert.threshold_pct}%)

<b>Timestamp:</b> ${new Date(alert.timestamp).toISOString()}
  `.trim();

  return notifyTelegram(message);
}

/**
 * Send A/B test winner alert via Telegram.
 */
export async function sendABTestWinnerAlert(alert: ABTestWinnerAlert): Promise<{ sent: boolean; error?: string }> {
  const winnerText = alert.winner === 'tie' ? '🤝 Tie' : alert.winner === 'a' ? '🏆 Variant A' : '🏆 Variant B';
  const variantName = alert.winner === 'a' ? alert.variant_a_name : alert.variant_b_name;

  const message = `
📊 <b>A/B Test Completed</b>

<b>Test ID:</b> ${alert.test_id}
<b>Workspace:</b> ${alert.workspace}

<b>Result:</b> ${winnerText}
${alert.winner !== 'tie' ? `<b>Winner:</b> ${variantName}` : ''}

<b>Variants:</b>
  • A: ${alert.variant_a_name}
  • B: ${alert.variant_b_name}

<b>Delta Score:</b> ${(alert.delta_score * 100).toFixed(2)}%
<b>Confidence:</b> ${(alert.confidence * 100).toFixed(1)}%

<b>Timestamp:</b> ${new Date(alert.timestamp).toISOString()}
  `.trim();

  return notifyTelegram(message);
}

/**
 * Send optimization complete alert via Telegram.
 */
export async function sendOptimizationCompleteAlert(alert: OptimizationCompleteAlert): Promise<{ sent: boolean; error?: string }> {
  const message = `
🔧 <b>Optimization Completed</b>

<b>Optimization ID:</b> ${alert.optimization_id}
<b>Workspace:</b> ${alert.workspace}
<b>Strategy:</b> ${alert.strategy}

<b>Results:</b>
  • Baseline Score: ${(alert.baseline_score * 100).toFixed(1)}%
  • Best Score: ${(alert.best_score * 100).toFixed(1)}%
  • Improvement: ${(alert.improvement * 100).toFixed(2)}%

<b>Budget Usage:</b>
  • Cost: $${alert.total_cost_usd.toFixed(4)}
  • Iterations: ${alert.total_iterations}

<b>Stopped Reason:</b> ${alert.stopped_reason}

<b>Timestamp:</b> ${new Date(alert.timestamp).toISOString()}
  `.trim();

  return notifyTelegram(message);
}

/**
 * Send a generic eval run completion alert via Telegram.
 */
export async function sendEvalRunCompleteAlert(
  runId: string,
  workspace: string,
  suiteName: string,
  status: 'completed' | 'failed',
  score: number,
  caseCount: number,
  costUsd: number,
): Promise<{ sent: boolean; error?: string }> {
  const emoji = status === 'completed' ? '✅' : '❌';

  const message = `
${emoji} <b>Eval Run ${status.toUpperCase()}</b>

<b>Run ID:</b> ${runId}
<b>Workspace:</b> ${workspace}
<b>Suite:</b> ${suiteName}

<b>Results:</b>
  • Score: ${(score * 100).toFixed(1)}%
  • Cases: ${caseCount}
  • Cost: $${costUsd.toFixed(4)}

<b>Timestamp:</b> ${new Date().toISOString()}
  `.trim();

  return notifyTelegram(message);
}

// ────────────────────────────────────────────────────────────────────
//  ALERT ORCHESTRATION
// ────────────────────────────────────────────────────────────────────

/**
 * Run regression detection and send alerts if regressions are found.
 */
export async function detectAndAlertRegressions(
  db: Database,
  currentRun: EvalRunDetails,
  config: RegressionDetectionConfig = {},
): Promise<void> {
  const regressions = checkRegressionAgainstLatest(db, currentRun, config);

  if (regressions.length > 0) {
    console.warn(`[detectAndAlertRegressions] Detected ${regressions.length} regression(s) for run ${currentRun.run.id}`);
    for (const regression of regressions) {
      await sendRegressionAlert(regression);
    }
  }
}

/**
 * Process A/B test completion and send winner alert.
 */
export async function processABTestCompletion(
  db: Database,
  testData: ABTestDetails,
): Promise<void> {
  const alert: ABTestWinnerAlert = {
    test_id: testData.test.id,
    workspace: testData.test.workspace,
    winner: testData.test.winner,
    variant_a_name: testData.test.variant_a_name,
    variant_b_name: testData.test.variant_b_name,
    confidence: testData.test.confidence,
    delta_score: testData.test.delta_score,
    timestamp: Date.now(),
  };

  await sendABTestWinnerAlert(alert);
}

/**
 * Process optimization completion and send alert.
 */
export async function processOptimizationCompletion(
  db: Database,
  optimizationData: OptimizationRunDetails,
  baselineScore: number,
): Promise<void> {
  const alert: OptimizationCompleteAlert = {
    optimization_id: optimizationData.run.id,
    workspace: optimizationData.run.workspace,
    strategy: optimizationData.run.strategy,
    best_score: optimizationData.run.best_score ?? 0,
    baseline_score: baselineScore,
    improvement: (optimizationData.run.best_score ?? 0) - baselineScore,
    total_cost_usd: optimizationData.run.total_cost_usd,
    total_iterations: optimizationData.run.current_iteration,
    stopped_reason: optimizationData.run.stopped_reason ?? 'completed',
    timestamp: Date.now(),
  };

  await sendOptimizationCompleteAlert(alert);
}