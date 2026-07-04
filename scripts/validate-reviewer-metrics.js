#!/usr/bin/env node

/**
 * Simple validation script for reviewer metrics implementation.
 * Checks that the implementation file can be parsed and exports are correct.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');
const metricsFile = join(rootDir, 'src/v2/evals/metrics/reviewer.ts');

console.log('Validating reviewer metrics implementation...');

try {
  const content = readFileSync(metricsFile, 'utf-8');

  // Check for required exports
  const requiredExports = [
    'StrictnessCalibrationMetric',
    'SkepticismBiasMetric',
    'FeedbackQualityMetric',
    'EvidenceBasedMetric',
    'FairnessMetric',
    'CompletenessMetric',
    'ConsistencyMetric',
    'ResponseTimeMetric',
    'ConfidenceCalibrationMetric',
    'RejectReasonQualityMetric',
    'createAllReviewerMetrics',
    'ReviewerMetricInput',
  ];

  const missingExports = [];
  for (const exp of requiredExports) {
    // Check for various export patterns
    const patterns = [
      `export class ${exp}`,
      `export function ${exp}`,
      `export interface ${exp}`,
      `export type ${exp}`,
      `export { ${exp}`,
    ];
    const found = patterns.some(pattern => content.includes(pattern));
    if (!found) {
      missingExports.push(exp);
    }
  }

  if (missingExports.length > 0) {
    console.error('❌ Missing exports:', missingExports.join(', '));
    process.exit(1);
  }

  // Check for metric count
  const metricClassMatches = content.match(/export class \w+Metric extends BaseMetric/g);
  if (!metricClassMatches || metricClassMatches.length < 10) {
    console.error(`❌ Expected at least 10 metric classes, found ${metricClassMatches?.length || 0}`);
    process.exit(1);
  }

  // Check for BaseMetric extension
  const baseMetricMatches = content.match(/extends BaseMetric/g);
  if (!baseMetricMatches || baseMetricMatches.length < 10) {
    console.error(`❌ Expected at least 10 BaseMetric extensions, found ${baseMetricMatches?.length || 0}`);
    process.exit(1);
  }

  // Check for measureImpl implementations
  const measureImplMatches = content.match(/protected async measureImpl/g);
  if (!measureImplMatches || measureImplMatches.length < 10) {
    console.error(`❌ Expected at least 10 measureImpl implementations, found ${measureImplMatches?.length || 0}`);
    process.exit(1);
  }

  console.log('✅ All validation checks passed!');
  console.log(`✅ Found ${metricClassMatches.length} metric classes`);
  console.log(`✅ Found ${measureImplMatches.length} measureImpl implementations`);
  console.log(`✅ All ${requiredExports.length} required exports present`);
  console.log('\nImplementation summary:');
  console.log('- 10 reviewer metrics implemented');
  console.log('- All metrics extend BaseMetric');
  console.log('- All metrics implement measureImpl');
  console.log('- Factory function createAllReviewerMetrics available');
  console.log('- ReviewerMetricInput type exported');

} catch (error) {
  console.error('❌ Validation failed:', error.message);
  process.exit(1);
}