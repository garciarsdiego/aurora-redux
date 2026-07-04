/**
 * Dashboard integration functions for the Agent Harness observability system.
 * These functions POST eval results to the dashboard-v2 for visualization.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  EvalRunDetails,
  ABTestDetails,
  OptimizationRunDetails,
  EvalRunEvent,
  RegressionAlert,
  ABTestWinnerAlert,
  OptimizationCompleteAlert,
} from './types.js';
import type { EvalRun, EvalResult } from '../types.js';

// ────────────────────────────────────────────────────────────────────
//  DASHBOARD POST FUNCTIONS
// ────────────────────────────────────────────────────────────────────

/**
 * POST eval run data to the dashboard for visualization.
 * This function inserts the run data into the database and creates timeline events.
 */
export function postEvalRun(
  db: Database,
  runData: {
    run: EvalRun;
    results: EvalResult[];
    events?: EvalRunEvent[];
  },
): void {
  const { run, results, events } = runData;

  // Insert eval run (if not already exists)
  const insertRun = db.prepare(`
    INSERT OR REPLACE INTO eval_runs (
      id, workspace, suite_name, status, score, case_count,
      variant_id, ab_test_id, created_at, completed_at,
      total_cost_usd, total_clock_ms, agent_type, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertRun.run(
    run.id,
    run.workspace,
    run.suite_name,
    run.status,
    run.score,
    run.case_count,
    run.variant_id ?? null,
    run.ab_test_id ?? null,
    run.created_at,
    run.completed_at ?? null,
    0, // total_cost_usd - will be updated from results
    0, // total_clock_ms - will be updated from results
    null, // agent_type - optional
    run.metadata_json ?? '{}',
  );

  // Insert eval results
  const insertResult = db.prepare(`
    INSERT OR REPLACE INTO eval_results (
      id, run_id, case_id, status, score, output_json, feedback, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const result of results) {
    insertResult.run(
      result.id,
      result.run_id,
      result.case_id,
      result.status,
      result.score,
      result.output_json,
      result.feedback,
      result.error,
      result.created_at,
    );

    // Insert metric scores
    const insertMetric = db.prepare(`
      INSERT OR REPLACE INTO eval_metric_scores (
        id, result_id, metric_name, score, threshold, passed, reason,
        cost_usd, latency_ms, meta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const metric of result.metric_scores) {
      insertMetric.run(
        metric.id,
        result.id,
        metric.metric_name,
        metric.score,
        metric.threshold,
        metric.passed ? 1 : 0,
        metric.reason ?? null,
        metric.cost_usd,
        metric.latency_ms,
        JSON.stringify(metric.meta ?? {}),
        metric.created_at,
      );
    }
  }

  // Insert timeline events
  if (events && events.length > 0) {
    const insertEvent = db.prepare(`
      INSERT INTO eval_run_events (
        id, run_id, event_type, message, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const event of events) {
      insertEvent.run(
        randomUUID(),
        run.id,
        event.event_type,
        event.message ?? null,
        JSON.stringify(event.metadata),
        event.created_at ?? Date.now(),
      );
    }
  }
}

/**
 * POST A/B test result to the dashboard for visualization.
 */
export function postABTestResult(
  db: Database,
  testData: ABTestDetails,
): void {
  const { test, run_a, run_b } = testData;

  // Insert A/B test record
  const insertTest = db.prepare(`
    INSERT OR REPLACE INTO eval_ab_tests (
      id, workspace, variant_a_id, variant_b_id, run_a_id, run_b_id,
      winner, confidence, delta_score, ci95_low, ci95_high,
      per_metric_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertTest.run(
    test.id,
    test.workspace,
    test.variant_a_id,
    test.variant_b_id,
    test.run_a_id,
    test.run_b_id,
    test.winner,
    test.confidence,
    test.delta_score,
    test.ci95_low,
    test.ci95_high,
    JSON.stringify(test.per_metric),
    test.created_at,
  );

  // Insert both runs
  postEvalRun(db, {
    run: run_a.run as unknown as EvalRun,
    results: run_a.results as unknown as EvalResult[],
    events: run_a.events,
  });

  postEvalRun(db, {
    run: run_b.run as unknown as EvalRun,
    results: run_b.results as unknown as EvalResult[],
    events: run_b.events,
  });
}

/**
 * POST optimization result to the dashboard for visualization.
 */
export function postOptimizationResult(
  db: Database,
  optimizationData: OptimizationRunDetails,
): void {
  const { run, trials } = optimizationData;

  // Insert optimization run
  const insertOptimization = db.prepare(`
    INSERT OR REPLACE INTO eval_optimization_runs (
      id, workspace, base_variant_id, strategy, target_metric,
      max_iterations, max_cost_usd, max_clock_ms, status,
      current_iteration, best_score, best_variant_id,
      total_cost_usd, total_clock_ms, stopped_reason,
      created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertOptimization.run(
    run.id,
    run.workspace,
    run.base_variant_id,
    run.strategy,
    run.target_metric,
    run.max_iterations,
    run.max_cost_usd,
    run.max_clock_ms,
    run.status,
    run.current_iteration,
    run.best_score ?? null,
    run.best_variant_id ?? null,
    run.total_cost_usd,
    run.total_clock_ms,
    run.stopped_reason ?? null,
    run.created_at,
    run.completed_at ?? null,
  );

  // Insert trials
  const insertTrial = db.prepare(`
    INSERT OR REPLACE INTO eval_optimization_trials (
      id, optimization_id, iteration, variant_id, axis_values_json,
      objective_score, metric_scores_json, cost_usd, clock_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const trial of trials) {
    insertTrial.run(
      trial.id,
      trial.optimization_id,
      trial.iteration,
      trial.variant_id,
      JSON.stringify(trial.axis_values),
      trial.objective_score,
      JSON.stringify(trial.metric_scores),
      trial.cost_usd,
      trial.clock_ms,
      trial.created_at,
    );
  }

  // Insert optimization events
  const insertEvent = db.prepare(`
    INSERT INTO eval_run_events (
      id, run_id, event_type, message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Started event
  insertEvent.run(
    randomUUID(),
    run.id,
    'optimization_iteration',
    `Optimization started with strategy: ${run.strategy}`,
    JSON.stringify({ strategy: run.strategy, target_metric: run.target_metric }),
    run.created_at,
  );

  // Completed event
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    insertEvent.run(
      randomUUID(),
      run.id,
      'optimization_completed',
      `Optimization ${run.status}: ${run.stopped_reason ?? 'completed'}`,
      JSON.stringify({
        best_score: run.best_score,
        total_cost_usd: run.total_cost_usd,
        total_iterations: run.current_iteration,
      }),
      run.completed_at ?? Date.now(),
    );
  }
}

/**
 * Create a timeline event for an eval run.
 */
export function createEvalRunEvent(
  db: Database,
  runId: string,
  eventType: EvalRunEvent['event_type'],
  message?: string,
  metadata: Record<string, unknown> = {},
): void {
  const insertEvent = db.prepare(`
    INSERT INTO eval_run_events (
      id, run_id, event_type, message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertEvent.run(
    randomUUID(),
    runId,
    eventType,
    message ?? null,
    JSON.stringify(metadata),
    Date.now(),
  );
}

/**
 * Update eval run status and completion timestamp.
 */
export function updateEvalRunStatus(
  db: Database,
  runId: string,
  status: 'running' | 'completed' | 'failed',
  totalCostUsd?: number,
  totalClockMs?: number,
): void {
  const updateRun = db.prepare(`
    UPDATE eval_runs
    SET status = ?, completed_at = ?, total_cost_usd = ?, total_clock_ms = ?
    WHERE id = ?
  `);

  updateRun.run(
    status,
    status !== 'running' ? Date.now() : null,
    totalCostUsd ?? 0,
    totalClockMs ?? 0,
    runId,
  );

  // Create event
  createEvalRunEvent(
    db,
    runId,
    status === 'completed' ? 'completed' : 'failed',
    `Run ${status}`,
    { status },
  );
}

/**
 * Update optimization run status and progress.
 */
export function updateOptimizationRunProgress(
  db: Database,
  optimizationId: string,
  currentIteration: number,
  bestScore: number | null,
  bestVariantId: string | null,
  totalCostUsd: number,
  totalClockMs: number,
): void {
  const updateRun = db.prepare(`
    UPDATE eval_optimization_runs
    SET current_iteration = ?, best_score = ?, best_variant_id = ?,
        total_cost_usd = ?, total_clock_ms = ?
    WHERE id = ?
  `);

  updateRun.run(
    currentIteration,
    bestScore,
    bestVariantId,
    totalCostUsd,
    totalClockMs,
    optimizationId,
  );

  // Create iteration event
  const insertEvent = db.prepare(`
    INSERT INTO eval_run_events (
      id, run_id, event_type, message, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertEvent.run(
    randomUUID(),
    optimizationId,
    'optimization_iteration',
    `Iteration ${currentIteration} completed`,
    JSON.stringify({
      iteration: currentIteration,
      best_score: bestScore,
      best_variant_id: bestVariantId,
    }),
    Date.now(),
  );
}