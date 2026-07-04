#!/usr/bin/env node

/**
 * Update Eval Baseline from Report
 *
 * Extracts metric scores from an eval report and updates the baseline file.
 * This should be run after intentional improvements to metrics.
 *
 * Usage:
 *   node scripts/update-baseline.mjs dist/eval-report.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REPORT_PATH = process.argv[2] || join(__dirname, '..', 'dist', 'eval-report.json');
const BASELINE_PATH = join(__dirname, '..', 'data', 'eval-baseline.json');

// Mandatory metrics that should be in the baseline
const MANDATORY_METRICS = [
  'H2-FanOut',
  'H3-CriticalPath',
  'H7-FalsifiableCriteria',
  'H10-ModelCliCompatibility',
  'PlanFeasibility',
  'LogicalOrder',
  'ObjectiveClarity',
];

console.log('📊 Updating Eval Baseline');
console.log('='.repeat(60));
console.log(`Report: ${REPORT_PATH}`);
console.log(`Baseline: ${BASELINE_PATH}`);
console.log('');

try {
  // Read report
  const reportContent = readFileSync(REPORT_PATH, 'utf8');
  const report = JSON.parse(reportContent);

  console.log(`Report mode: ${report.mode}`);
  console.log(`Report workspace: ${report.workspace}`);
  console.log(`Report passed: ${report.passed}`);
  console.log('');

  // Read existing baseline
  let baseline = {};
  if (readFileSync(BASELINE_PATH, 'utf8')) {
    try {
      baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
      console.log('Loaded existing baseline');
    } catch (err) {
      console.warn('Could not parse existing baseline, creating new one');
    }
  }

  // Extract metric scores from report
  const newMetrics = {};
  let updatedCount = 0;

  for (const metricName of MANDATORY_METRICS) {
    const metricData = report.metrics[metricName];
    if (metricData) {
      const oldScore = baseline.metrics?.[metricName];
      const newScore = metricData.mean;

      newMetrics[metricName] = newScore;
      updatedCount++;

      if (oldScore !== undefined) {
        const delta = newScore - oldScore;
        const deltaPct = oldScore > 0 ? (delta / oldScore) * 100 : 0;
        const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
        console.log(`${arrow} ${metricName}: ${(oldScore * 100).toFixed(1)}% → ${(newScore * 100).toFixed(1)}% (${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`);
      } else {
        console.log(`+ ${metricName}: ${(newScore * 100).toFixed(1)}% (new)`);
      }
    }
  }

  console.log('');
  console.log(`Updated ${updatedCount} metrics`);

  // Update baseline structure
  const newBaseline = {
    _comment: "Agent Harness Eval Baseline",
    _description: "This file stores baseline scores for mandatory metrics. The eval runner compares current scores against these baselines to detect regressions. Update this file after intentional changes that improve metrics.",
    _version: "1.0.0",
    _last_updated: new Date().toISOString(),
    _updated_by: process.env.USER || 'unknown',
    _commit: process.env.GITHUB_SHA || 'local',
    metrics: {
      ...baseline.metrics,
      ...newMetrics,
    },
    _instructions: {
      update: "Run the eval suite locally with --mode full, then copy the metric scores from the report into this file",
      regression_threshold: "0.05 (5%) - fails if any mandatory metric drops more than 5% from baseline",
      mandatory_metrics: MANDATORY_METRICS,
    },
  };

  // Write updated baseline
  writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2), 'utf8');
  console.log('');
  console.log(`✅ Baseline updated: ${BASELINE_PATH}`);
  console.log('');
  console.log('⚠️  Review the changes before committing:');
  console.log('   git diff data/eval-baseline.json');
  console.log('');
  console.log('Commit with a descriptive message:');
  console.log('   git add data/eval-baseline.json');
  console.log('   git commit -m "chore: update eval baseline after <change>"');

} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}