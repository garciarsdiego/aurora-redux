#!/usr/bin/env node
// Smart rerun helper: reads a completed harness-eval run, identifies failed tasks,
// and re-executes them via the matrix runner.
//
// USAGE
//   node scripts/rerun-failed-matrix-tasks.mjs --run-id harness-eval-1779559639035
//   node scripts/rerun-failed-matrix-tasks.mjs --run-id harness-eval-1779559639035 --filter T1,T3
//   node scripts/rerun-failed-matrix-tasks.mjs --run-id harness-eval-1779559639035 --concurrency 1
//   node scripts/rerun-failed-matrix-tasks.mjs --help

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = pathResolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { runId: null, filter: [], concurrency: 1 };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--run-id') {
      opts.runId = args[++i];
    } else if (a === '--filter') {
      opts.filter = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (a === '--concurrency') {
      const n = parseInt(args[++i], 10);
      if (Number.isNaN(n) || n < 1) { console.error('--concurrency must be a positive integer'); process.exit(2); }
      opts.concurrency = n;
    } else if (a === '--help' || a === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(0, 12).join('\n'));
      process.exit(0);
    }
  }
  if (!opts.runId) {
    console.error('Error: --run-id is required. Use --help for usage.');
    process.exit(2);
  }
  return opts;
}

function loadSummary(runId) {
  const summaryPath = join(repoRoot, 'data', 'harness-eval', runId, 'summary.json');
  if (!existsSync(summaryPath)) {
    console.error(`Error: summary.json not found at ${summaryPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(summaryPath, 'utf8'));
}

function identifyFailedTasks(summary, filter) {
  const { results } = summary;
  if (!Array.isArray(results)) {
    console.error('Error: summary.json has no "results" array.');
    process.exit(1);
  }
  // Deduplicate by taskId (in case of repeat runs, rerun all unique failed taskIds)
  const seen = new Set();
  const failed = [];
  for (const r of results) {
    if (r.status !== 'failed') continue;
    // Support both id (no-repeat) and taskId (repeat runs)
    const taskId = r.taskId ?? r.id;
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    failed.push(taskId);
  }
  if (filter.length > 0) {
    return failed.filter((id) => filter.some((f) => id.startsWith(f)));
  }
  return failed;
}

function runMatrixTask(taskId, concurrency) {
  return new Promise((resolve, reject) => {
    const args = [
      'scripts/run-harness-eval-matrix.mjs',
      '--id', taskId,
      '--concurrency', String(concurrency),
    ];
    const child = spawn('node', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.on('close', (code) => {
      if (code === 0) resolve(taskId);
      else reject(new Error(`Matrix runner exited with code ${code} for task ${taskId}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const opts = parseArgs();

  const sourceRunDir = join(repoRoot, 'data', 'harness-eval', opts.runId);
  if (!existsSync(sourceRunDir)) {
    console.error(`Error: run directory not found: ${sourceRunDir}`);
    process.exit(1);
  }

  const summary = loadSummary(opts.runId);
  const failedIds = identifyFailedTasks(summary, opts.filter);

  if (failedIds.length === 0) {
    console.log(`[rerun] No failed tasks found in run ${opts.runId}. Nothing to do.`);
    process.exit(0);
  }

  console.log(`\n[rerun] Source run: ${opts.runId}`);
  console.log(`[rerun] Failed tasks to rerun (${failedIds.length}): ${failedIds.join(', ')}`);
  console.log(`[rerun] Concurrency: ${opts.concurrency}\n`);

  // Create a new run dir to record this rerun's metadata
  const rerunId = `harness-eval-rerun-${Date.now()}`;
  const rerunDir = join(repoRoot, 'data', 'harness-eval', rerunId);
  mkdirSync(join(rerunDir, 'traces'), { recursive: true });

  // Persist a manifest so the rerun is traceable back to the source
  const manifest = {
    rerunId,
    sourceRunId: opts.runId,
    filter: opts.filter,
    concurrency: opts.concurrency,
    taskIds: failedIds,
    startedAt: new Date().toISOString(),
    status: 'running',
    childRunIds: [],
  };
  const manifestPath = join(rerunDir, 'summary.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Execute each failed task sequentially via the matrix runner.
  // Each invocation spawns its own run dir; we record the child runId here.
  // Note: the matrix runner always creates a new timestamped runId, so we
  // capture stdout to extract it.
  const successes = [];
  const failures = [];

  for (const taskId of failedIds) {
    console.log(`[rerun] Running ${taskId}...`);
    try {
      await runMatrixTask(taskId, opts.concurrency);
      successes.push(taskId);
    } catch (err) {
      console.error(`[rerun] ${taskId} failed: ${err.message}`);
      failures.push(taskId);
    }
  }

  // Update manifest with final status
  const finalManifest = {
    ...manifest,
    completedAt: new Date().toISOString(),
    status: failures.length === 0 ? 'completed' : 'partial',
    succeeded: successes,
    failed: failures,
  };
  writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2));

  console.log('\n[rerun] Done.');
  console.log(`[rerun] Succeeded: ${successes.length}  Failed: ${failures.length}`);
  console.log(`[rerun] Manifest: ${manifestPath}`);

  if (failures.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[rerun] fatal:', err);
  process.exit(1);
});
