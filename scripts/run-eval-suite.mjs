#!/usr/bin/env node

/**
 * Agent Harness Eval Suite Runner
 *
 * Runs the eval harness suite with configurable modes:
 * - quick: Run a subset of golden cases (fast, ~1-2 min)
 * - full: Run all golden cases with all metrics (~5-10 min)
 * - regression: Run only regression-critical metrics on golden cases (~2-3 min)
 *
 * Generates a JSON report with:
 * - Total score per metric
 * - Pass/fail per test case
 * - Cost breakdown by agent
 * - Comparison with baseline (if available)
 *
 * Exits with non-zero if:
 * - Regression detected (score drop > threshold)
 * - Cost exceeds max cost
 * - Any mandatory metric fails
 *
 * Usage:
 *   node scripts/run-eval-suite.mjs --mode quick --workspace ci --max-cost 2.00
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    flags[key] = value;
    if (value !== true) i++;
  }
}

const MODE = flags.mode || 'quick';
const WORKSPACE = flags.workspace || 'ci';
const MAX_COST_USD = parseFloat(flags['max-cost'] || '2.00');
const REGRESSION_THRESHOLD = parseFloat(flags['regression-threshold'] || '0.05');
const OUTPUT_PATH = flags.output || join(__dirname, '..', 'dist', 'eval-report.json');

// Ensure output directory exists
const outputDir = dirname(OUTPUT_PATH);
if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

// Database path
const DB_PATH = join(__dirname, '..', 'data', 'omniforge.db');

// Baseline path
const BASELINE_PATH = join(__dirname, '..', 'data', 'eval-baseline.json');

// Mandatory metrics (strict=true in decomposer.ts)
const MANDATORY_METRICS = [
  'H2-FanOut',
  'H3-CriticalPath',
  'H7-FalsifiableCriteria',
  'H10-ModelCliCompatibility',
  'PlanFeasibility',
  'LogicalOrder',
  'ObjectiveClarity',
];

console.log('🧪 Agent Harness Eval Suite Runner');
console.log('='.repeat(60));
console.log(`Mode: ${MODE}`);
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Max Cost: $${MAX_COST_USD.toFixed(2)} USD`);
console.log(`Regression Threshold: ${(REGRESSION_THRESHOLD * 100).toFixed(1)}%`);
console.log(`Output: ${OUTPUT_PATH}`);
console.log('');

// Open database
const db = new Database(DB_PATH);

// Track costs
const costTracker = {
  decomposer: 0,
  planner: 0,
  reviewer: 0,
  total: 0,
};

// Track results
const results = {
  passed: 0,
  failed: 0,
  errors: 0,
  skipped: 0,
};

// Metric scores
const metricScores = {};

// Failed cases for reporting
const failedCases = [];

// All case results for database persistence
const caseResults = [];

// Regressions detected
const regressions = [];

const startTime = Date.now();

try {
  console.log('📊 Loading golden cases from database...');

  // Load golden cases from eval_cases table
  const cases = db.prepare(`
    SELECT
      id,
      workspace,
      name,
      input_json,
      expected_json,
      tags_json,
      suite,
      context_json,
      source,
      created_at
    FROM eval_cases
    WHERE workspace = ?
      AND (tags_json LIKE '%golden%' OR tags_json LIKE '%ci%')
    ORDER BY created_at ASC
  `).all(WORKSPACE);

  console.log(`Found ${cases.length} golden cases`);

  if (cases.length === 0) {
    console.warn('⚠️  No golden cases found. Seeding default cases...');
    // Seed default golden cases from golden-suite.ts
    // This would require importing the TypeScript module
    // For now, we'll create a minimal synthetic case
    const syntheticCase = {
      id: `gc_synthetic_${Date.now()}`,
      workspace: WORKSPACE,
      name: 'synthetic-dag-validation',
      input_json: JSON.stringify({
        kind: 'dag_validate',
        dag: {
          tasks: [
            { id: 't0', name: 'Plan gate', kind: 'llm_call', depends_on: [] },
            { id: 't1', name: 'Task 1', kind: 'llm_call', depends_on: ['t0'] },
            { id: 't2', name: 'Task 2', kind: 'llm_call', depends_on: ['t0'] },
          ],
        },
      }),
      expected_json: JSON.stringify({
        ok: true,
        taskCount: 3,
        errorRules: [],
      }),
      tags_json: JSON.stringify(['golden', 'ci', 'synthetic']),
      suite: 'decomposer',
      context_json: '{}',
      source: 'synthetic',
      created_at: Math.floor(Date.now() / 1000),
    };

    try {
      db.prepare(`
        INSERT INTO eval_cases
          (id, workspace, name, input_json, expected_json, tags_json, suite, context_json, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        syntheticCase.id,
        syntheticCase.workspace,
        syntheticCase.name,
        syntheticCase.input_json,
        syntheticCase.expected_json,
        syntheticCase.tags_json,
        syntheticCase.suite,
        syntheticCase.context_json,
        syntheticCase.source,
        syntheticCase.created_at,
      );
      cases.push(syntheticCase);
      console.log('✅ Seeded synthetic golden case');
    } catch (err) {
      console.error('❌ Failed to seed synthetic case:', err.message);
    }
  }

  // Filter cases based on mode
  let casesToRun = cases;
  if (MODE === 'quick') {
    // Quick mode: run first 3 cases
    casesToRun = cases.slice(0, Math.min(3, cases.length));
    console.log(`Quick mode: running ${casesToRun.length} cases`);
  } else if (MODE === 'regression') {
    // Regression mode: run all cases but only critical metrics
    casesToRun = cases;
    console.log(`Regression mode: running ${casesToRun.length} cases with critical metrics`);
  } else {
    // Full mode: run all cases
    casesToRun = cases;
    console.log(`Full mode: running ${casesToRun.length} cases`);
  }

  console.log('');

  // Run eval for each case
  for (let i = 0; i < casesToRun.length; i++) {
    const testCase = casesToRun[i];
    console.log(`[${i + 1}/${casesToRun.length}] Running: ${testCase.name}`);

    try {
      const input = JSON.parse(testCase.input_json);
      const expected = JSON.parse(testCase.expected_json);
      const tags = JSON.parse(testCase.tags_json);

      // Determine which metrics to run based on suite
      const metricsToRun = determineMetricsForSuite(testCase.suite, MODE);

      // Run metrics
      const caseResult = runMetrics(testCase, input, expected, metricsToRun);

      // Track results
      if (caseResult.status === 'passed') {
        results.passed++;
      } else if (caseResult.status === 'failed') {
        results.failed++;
        failedCases.push({
          name: testCase.name,
          id: testCase.id,
          reason: caseResult.reason,
          metrics: caseResult.metricScores,
        });
      } else if (caseResult.status === 'error') {
        results.errors++;
        failedCases.push({
          name: testCase.name,
          id: testCase.id,
          reason: caseResult.error,
          metrics: caseResult.metricScores,
        });
      }

      // Store result for database persistence
      caseResults.push({
        caseId: testCase.id,
        passed: caseResult.status === 'passed',
        score: caseResult.score || 0,
        output: caseResult.output || null,
        feedback: caseResult.feedback || null,
        error: caseResult.error || null,
        metrics: caseResult.metricScores || {},
      });

      // Accumulate metric scores
      for (const [metricName, score] of Object.entries(caseResult.metricScores)) {
        if (!metricScores[metricName]) {
          metricScores[metricName] = {
            scores: [],
            threshold: score.threshold,
            strict: score.strict,
          };
        }
        metricScores[metricName].scores.push(score.score);
      }

      // Accumulate costs
      costTracker.decomposer += caseResult.costs.decomposer || 0;
      costTracker.planner += caseResult.costs.planner || 0;
      costTracker.reviewer += caseResult.costs.reviewer || 0;
      costTracker.total += caseResult.costs.total || 0;

      console.log(`  Status: ${caseResult.status} | Cost: $${(caseResult.costs.total || 0).toFixed(4)}`);
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      results.errors++;
      failedCases.push({
        name: testCase.name,
        id: testCase.id,
        reason: err.message,
      });
    }
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('📊 Summary');
  console.log('='.repeat(60));
  console.log(`Total cases: ${casesToRun.length}`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`Errors: ${results.errors}`);
  console.log(`Skipped: ${results.skipped}`);
  console.log('');

  // Calculate metric summaries
  const metricSummaries = {};
  for (const [metricName, data] of Object.entries(metricScores)) {
    const scores = data.scores;
    const mean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const min = scores.length > 0 ? Math.min(...scores) : 0;
    const max = scores.length > 0 ? Math.max(...scores) : 0;
    const passRate = scores.length > 0 ? scores.filter(s => s >= data.threshold).length / scores.length : 0;

    metricSummaries[metricName] = {
      mean,
      min,
      max,
      passRate,
      threshold: data.threshold,
      strict: data.strict,
      n: scores.length,
    };
  }

  console.log('📈 Metric Scores');
  console.log('='.repeat(60));
  for (const [metricName, summary] of Object.entries(metricSummaries)) {
    const mandatory = MANDATORY_METRICS.includes(metricName) ? ' [MANDATORY]' : '';
    const status = summary.passRate >= summary.threshold ? '✅' : '❌';
    console.log(`${status} ${metricName}${mandatory}`);
    console.log(`  Mean: ${(summary.mean * 100).toFixed(1)}% | Pass Rate: ${(summary.passRate * 100).toFixed(1)}% | Threshold: ${(summary.threshold * 100).toFixed(1)}%`);
    console.log(`  Range: [${(summary.min * 100).toFixed(1)}%, ${(summary.max * 100).toFixed(1)}%] | N: ${summary.n}`);
  }

  console.log('');
  console.log('💰 Cost Breakdown');
  console.log('='.repeat(60));
  console.log(`Decomposer: $${costTracker.decomposer.toFixed(4)}`);
  console.log(`Planner: $${costTracker.planner.toFixed(4)}`);
  console.log(`Reviewer: $${costTracker.reviewer.toFixed(4)}`);
  console.log(`Total: $${costTracker.total.toFixed(4)}`);

  // Check cost threshold
  if (costTracker.total > MAX_COST_USD) {
    console.log(`❌ Cost exceeded threshold: $${costTracker.total.toFixed(4)} > $${MAX_COST_USD.toFixed(2)}`);
  } else {
    console.log(`✅ Cost within threshold: $${costTracker.total.toFixed(4)} <= $${MAX_COST_USD.toFixed(2)}`);
  }

  console.log('');

  // Load baseline and check for regressions
  let baseline = null;
  if (existsSync(BASELINE_PATH)) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
      console.log('📊 Baseline loaded from:', BASELINE_PATH);
      console.log('');
    } catch (err) {
      console.warn('⚠️  Failed to load baseline:', err.message);
    }
  }

  let hasRegression = false;
  if (baseline && baseline.metrics) {
    console.log('🔍 Regression Check');
    console.log('='.repeat(60));

    for (const metricName of MANDATORY_METRICS) {
      const current = metricSummaries[metricName];
      const baselineMetric = baseline.metrics[metricName];

      if (current && baselineMetric !== undefined && baselineMetric !== null) {
        // Handle both direct value (number) and object with mean property
        const baselineValue = typeof baselineMetric === 'number' ? baselineMetric : baselineMetric.mean;
        const delta = current.mean - baselineValue;
        const deltaPct = baselineValue > 0 ? (delta / baselineValue) * 100 : 0;

        if (delta < -REGRESSION_THRESHOLD) {
          hasRegression = true;
          regressions.push({
            metric: metricName,
            baselineMean: baselineValue,
            currentMean: current.mean,
            deltaPct,
          });
          console.log(`❌ ${metricName}: ${baselineValue.toFixed(3)} → ${current.mean.toFixed(3)} (${deltaPct.toFixed(1)}%) [REGRESSION]`);
        } else {
          console.log(`✅ ${metricName}: ${baselineValue.toFixed(3)} → ${current.mean.toFixed(3)} (${deltaPct.toFixed(1)}%)`);
        }
      }
    }
    console.log('');
  }

  // Determine overall pass/fail
  const mandatoryMetricsPassed = MANDATORY_METRICS.every(metric => {
    const summary = metricSummaries[metric];
    return summary && summary.passRate >= summary.threshold;
  });

  const costPassed = costTracker.total <= MAX_COST_USD;
  const regressionPassed = !hasRegression;

  const overallPassed = mandatoryMetricsPassed && costPassed && regressionPassed;

  console.log('='.repeat(60));
  console.log(`Overall Status: ${overallPassed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('='.repeat(60));

  if (!mandatoryMetricsPassed) {
    console.log('❌ Failed: One or more mandatory metrics did not pass threshold');
  }
  if (!costPassed) {
    console.log('❌ Failed: Cost exceeded threshold');
  }
  if (!regressionPassed) {
    console.log('❌ Failed: Regression detected in mandatory metrics');
  }

  // Persist results to database
  console.log('\n💾 Persisting results to database...');
  const runId = `run_${Date.now()}`;
  const now = Math.floor(Date.now() / 1000);

  // Calculate overall score
  const totalScore = caseResults.reduce((sum, r) => sum + r.score, 0);
  const avgScore = cases.length > 0 ? totalScore / cases.length : 0;

  // Insert eval run
  const insertRun = db.prepare(`
    INSERT INTO eval_runs (
      id, workspace, suite_name, status, score, case_count,
      variant_id, ab_test_id, created_at, completed_at,
      total_cost_usd, total_clock_ms, agent_type, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertRun.run(
    runId,
    WORKSPACE,
    'golden-suite',
    'completed',
    avgScore,
    cases.length,
    null, // variant_id
    null, // ab_test_id
    now,
    now,
    costTracker.total,
    Date.now() - startTime,
    'decomposer', // agent_type
    JSON.stringify({ mode: MODE, regression_threshold: REGRESSION_THRESHOLD })
  );

  // Insert eval results and metric scores
  const insertResult = db.prepare(`
    INSERT INTO eval_results (
      id, run_id, case_id, status, score, output_json, feedback, error, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMetricScore = db.prepare(`
    INSERT INTO eval_metric_scores (
      id, result_id, metric_name, score, threshold, passed, cost_usd, latency_ms, meta_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const caseResult of caseResults) {
    const resultId = `result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    insertResult.run(
      resultId,
      runId,
      caseResult.caseId,
      caseResult.passed ? 'passed' : 'failed',
      caseResult.score || 0,
      JSON.stringify(caseResult.output),
      caseResult.feedback || null,
      caseResult.error || null,
      now
    );

    // Insert metric scores for this result
    for (const [metricName, metricData] of Object.entries(caseResult.metrics)) {
      const metricScoreId = `metric_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      insertMetricScore.run(
        metricScoreId,
        resultId,
        metricName,
        metricData.score || 0,
        metricData.threshold || 0,
        metricData.passed ? 1 : 0,
        metricData.cost || 0,
        metricData.latency || 0,
        JSON.stringify(metricData.meta || {}),
        now
      );
    }
  }

  console.log('✅ Results persisted to database');

  // Generate report
  const report = {
    mode: MODE,
    workspace: WORKSPACE,
    passed: overallPassed,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    summary: results,
    metrics: metricSummaries,
    costs: costTracker,
    totalCostUsd: costTracker.total,
    maxCostUsd: MAX_COST_USD,
    regressions: regressions.length > 0 ? regressions : undefined,
    failedCases: failedCases.length > 0 ? failedCases : undefined,
    baseline: baseline ? {
      path: BASELINE_PATH,
      timestamp: baseline.timestamp,
    } : undefined,
  };

  // Write report
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n✅ Report written to: ${OUTPUT_PATH}`);

  db.close();

  // Exit with appropriate code
  if (!overallPassed) {
    process.exit(1);
  }

  process.exit(0);
} catch (err) {
  console.error('❌ Fatal error:', err);
  db.close();
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────
//  HELPER FUNCTIONS
// ────────────────────────────────────────────────────────────────────

function determineMetricsForSuite(suite, mode) {
  // Return which metrics to run based on suite and mode
  const allMetrics = [
    'H1-Granularity',
    'H2-FanOut',
    'H3-CriticalPath',
    'H4-OutputScope',
    'H6-DownstreamSelectors',
    'H7-FalsifiableCriteria',
    'H8-ExplicitReviewer',
    'H10-ModelCliCompatibility',
    'H11-PlanGate',
    'PlanFeasibility',
    'LogicalOrder',
    'ObjectiveClarity',
  ];

  const criticalMetrics = [
    'H2-FanOut',
    'H3-CriticalPath',
    'H7-FalsifiableCriteria',
    'H10-ModelCliCompatibility',
    'PlanFeasibility',
    'LogicalOrder',
    'ObjectiveClarity',
  ];

  if (mode === 'regression') {
    return criticalMetrics;
  }

  return allMetrics;
}

function runMetrics(testCase, input, expected, metricsToRun) {
  // This would call the actual metric implementations from src/v2/evals/metrics/
  // For now, we'll simulate the results

  const metricScores = {};
  const costs = {
    decomposer: 0,
    planner: 0,
    reviewer: 0,
    total: 0,
  };

  let allPassed = true;
  let failureReason = null;

  for (const metricName of metricsToRun) {
    const result = simulateMetricEvaluation(metricName, input, expected);
    metricScores[metricName] = result;

    if (!result.passed) {
      allPassed = false;
      if (!failureReason) {
        failureReason = `${metricName} failed: ${result.reason}`;
      }
    }

    // Simulate costs based on metric type
    if (metricName.startsWith('H') || metricName.includes('Plan')) {
      costs.decomposer += result.costUsd || 0.0001;
    } else if (metricName.includes('Logical') || metricName.includes('Objective')) {
      costs.planner += result.costUsd || 0.0001;
    } else {
      costs.reviewer += result.costUsd || 0.0001;
    }
  }

  costs.total = costs.decomposer + costs.planner + costs.reviewer;

  return {
    status: allPassed ? 'passed' : 'failed',
    reason: failureReason,
    metricScores,
    costs,
  };
}

function simulateMetricEvaluation(metricName, input, expected) {
  // Simulate metric evaluation with deterministic results based on input
  // In production, this would call the actual metric implementations

  const hash = simpleHash(JSON.stringify(input) + metricName);
  const score = 0.7 + (hash % 30) / 100; // 0.7-1.0 range
  const threshold = MANDATORY_METRICS.includes(metricName) ? 1.0 : 0.8;
  const passed = score >= threshold;
  const costUsd = 0.0001 + (hash % 50) / 100000; // $0.0001-$0.0005

  return {
    score,
    threshold,
    passed,
    strict: MANDATORY_METRICS.includes(metricName),
    reason: passed ? 'Metric passed' : `Score ${(score * 100).toFixed(1)}% below threshold ${(threshold * 100).toFixed(1)}%`,
    costUsd,
  };
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}