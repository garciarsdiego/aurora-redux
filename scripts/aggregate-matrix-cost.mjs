#!/usr/bin/env node
/**
 * aggregate-matrix-cost.mjs
 * Aggregates real LLM cost from data/omniforge.db for harness-eval matrix runs.
 *
 * Usage:
 *   node scripts/aggregate-matrix-cost.mjs --run-id harness-eval-1779559639035
 *   node scripts/aggregate-matrix-cost.mjs --all-2026-05-23
 *   node scripts/aggregate-matrix-cost.mjs --since 2026-05-22
 *   node scripts/aggregate-matrix-cost.mjs --run-id harness-eval-1779559639035 --json
 */

import { createRequire } from 'module';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DB_PATH = join(REPO_ROOT, 'data', 'omniforge.db');
const HARNESS_DIR = join(REPO_ROOT, 'data', 'harness-eval');

// ── CLI arg parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    runId: null,
    all20260523: false,
    since: null,
    json: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--run-id' && args[i + 1]) {
      result.runId = args[++i];
    } else if (args[i] === '--all-2026-05-23') {
      result.all20260523 = true;
    } else if (args[i] === '--since' && args[i + 1]) {
      result.since = args[++i];
    } else if (args[i] === '--json') {
      result.json = true;
    }
  }
  return result;
}

// ── Harness-eval directory helpers ──────────────────────────────────────────

function listRunDirs() {
  if (!existsSync(HARNESS_DIR)) return [];
  return readdirSync(HARNESS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('harness-eval-'))
    .map(e => e.name);
}

function loadSummary(runId) {
  const p = join(HARNESS_DIR, runId, 'summary.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Return epoch ms embedded in a run-dir name (harness-eval-<timestamp>) */
function runDirTs(runId) {
  const ts = parseInt(runId.replace('harness-eval-', ''), 10);
  return isNaN(ts) ? null : ts;
}

function wfIdsFromSummary(summary) {
  if (!summary) return [];
  return (summary.results || []).map(r => r.wfId).filter(Boolean);
}

// ── DB queries (read-only) ───────────────────────────────────────────────────

function openDb() {
  if (!existsSync(DB_PATH)) {
    throw new Error(`DB not found: ${DB_PATH}`);
  }
  return new Database(DB_PATH, { readonly: true });
}

function queryRun(db, wfIds) {
  if (!wfIds.length) {
    return { total_cost: 0, null_cost_rows: 0, input_tokens: 0, output_tokens: 0, call_count: 0, per_model: [], per_task: [] };
  }
  const ph = wfIds.map(() => '?').join(',');

  const agg = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0)                                            AS total_cost,
      SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)                     AS null_cost_rows,
      COALESCE(SUM(input_tokens), 0)                                        AS input_tokens,
      COALESCE(SUM(output_tokens), 0)                                       AS output_tokens,
      COUNT(*)                                                               AS call_count
    FROM model_calls
    WHERE workflow_id IN (${ph})
  `).get(...wfIds);

  const per_model = db.prepare(`
    SELECT
      model,
      provider,
      COUNT(*)                                  AS calls,
      ROUND(AVG(latency_ms), 0)                 AS avg_latency_ms,
      COALESCE(SUM(cost_usd), 0)                AS sum_cost,
      SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS null_rows
    FROM model_calls
    WHERE workflow_id IN (${ph})
    GROUP BY model, provider
    ORDER BY sum_cost DESC
  `).all(...wfIds);

  const per_task = db.prepare(`
    SELECT
      task_id,
      workflow_id,
      COUNT(*)                           AS calls,
      COALESCE(SUM(cost_usd), 0)         AS sum_cost,
      COALESCE(SUM(input_tokens), 0)     AS input_tokens,
      COALESCE(SUM(output_tokens), 0)    AS output_tokens
    FROM model_calls
    WHERE workflow_id IN (${ph})
    GROUP BY task_id, workflow_id
    ORDER BY sum_cost DESC
    LIMIT 10
  `).all(...wfIds);

  return {
    total_cost: agg.total_cost,
    null_cost_rows: agg.null_cost_rows,
    input_tokens: agg.input_tokens,
    output_tokens: agg.output_tokens,
    call_count: agg.call_count,
    per_model,
    per_task,
  };
}

// ── Resolvers ────────────────────────────────────────────────────────────────

function resolveRunsByDate(dateStr) {
  // dateStr: YYYY-MM-DD — matches run dirs whose embedded timestamp falls on that UTC day
  const dayStart = new Date(dateStr + 'T00:00:00Z').getTime();
  const dayEnd = dayStart + 86_400_000;
  return listRunDirs().filter(id => {
    const ts = runDirTs(id);
    return ts !== null && ts >= dayStart && ts < dayEnd;
  });
}

function resolveRunsSince(dateStr) {
  const since = new Date(dateStr + 'T00:00:00Z').getTime();
  return listRunDirs().filter(id => {
    const ts = runDirTs(id);
    return ts !== null && ts >= since;
  });
}

// ── Formatters ───────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

function pad(str, n, right = false) {
  const s = String(str ?? '');
  return right ? s.padStart(n) : s.padEnd(n);
}

function fmtCost(v) { return `$${Number(v).toFixed(6)}`; }
function fmtInt(v) { return Number(v).toLocaleString(); }

function printRunReport(runId, wfIds, data) {
  const { total_cost, null_cost_rows, input_tokens, output_tokens, call_count, per_model, per_task } = data;
  const nullNote = null_cost_rows > 0 ? ` (${null_cost_rows} rows with NULL cost — lower bound)` : '';

  console.log(`\n${BOLD}${CYAN}Run: ${runId}${RESET}`);
  console.log(`  Workflow IDs tracked : ${wfIds.length}`);
  console.log(`  model_calls rows     : ${fmtInt(call_count)}`);
  console.log(`  Input tokens         : ${fmtInt(input_tokens)}`);
  console.log(`  Output tokens        : ${fmtInt(output_tokens)}`);
  console.log(`  Total tokens         : ${fmtInt(input_tokens + output_tokens)}`);
  console.log(`  ${BOLD}Total cost_usd       : ${fmtCost(total_cost)}${RESET}${YELLOW}${nullNote}${RESET}`);

  // Per-model breakdown
  if (per_model.length) {
    console.log(`\n  ${BOLD}Per-model breakdown:${RESET}`);
    const header = `  ${pad('Model', 36)} ${pad('Provider', 12)} ${pad('Calls', 6, true)} ${pad('AvgLatMs', 9, true)} ${pad('Cost USD', 12, true)} ${pad('NullRows', 8, true)}`;
    console.log(`${DIM}${header}${RESET}`);
    for (const r of per_model) {
      const line = `  ${pad(r.model, 36)} ${pad(r.provider ?? '-', 12)} ${pad(r.calls, 6, true)} ${pad(r.avg_latency_ms, 9, true)} ${pad(fmtCost(r.sum_cost), 12, true)} ${pad(r.null_rows, 8, true)}`;
      console.log(line);
    }
  }

  // Top-10 tasks by cost
  if (per_task.length) {
    console.log(`\n  ${BOLD}Top-10 tasks by cost:${RESET}`);
    const header = `  ${pad('task_id', 40)} ${pad('wf_id', 40)} ${pad('Calls', 5, true)} ${pad('Cost USD', 12, true)}`;
    console.log(`${DIM}${header}${RESET}`);
    for (const r of per_task) {
      const line = `  ${pad(r.task_id, 40)} ${pad(r.workflow_id, 40)} ${pad(r.calls, 5, true)} ${pad(fmtCost(r.sum_cost), 12, true)}`;
      console.log(line);
    }
  }
}

function printAggregateFooter(runResults) {
  const totalCost = runResults.reduce((s, r) => s + r.data.total_cost, 0);
  const totalNulls = runResults.reduce((s, r) => s + r.data.null_cost_rows, 0);
  const totalIn = runResults.reduce((s, r) => s + r.data.input_tokens, 0);
  const totalOut = runResults.reduce((s, r) => s + r.data.output_tokens, 0);
  const totalCalls = runResults.reduce((s, r) => s + r.data.call_count, 0);

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`${BOLD}AGGREGATE ACROSS ${runResults.length} RUN(S)${RESET}`);
  console.log(`  model_calls rows : ${fmtInt(totalCalls)}`);
  console.log(`  Input tokens     : ${fmtInt(totalIn)}`);
  console.log(`  Output tokens    : ${fmtInt(totalOut)}`);
  console.log(`  Total tokens     : ${fmtInt(totalIn + totalOut)}`);
  const nullNote = totalNulls > 0 ? `  ${YELLOW}(${totalNulls} rows with NULL cost — figure is a lower bound)${RESET}` : '';
  console.log(`  ${BOLD}Total cost_usd   : ${fmtCost(totalCost)}${RESET}`);
  if (nullNote) console.log(nullNote);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  let runIds = [];

  if (opts.runId) {
    runIds = [opts.runId];
  } else if (opts.all20260523) {
    runIds = resolveRunsByDate('2026-05-23');
    if (!runIds.length) {
      console.error('No harness-eval run dirs found with timestamp on 2026-05-23.');
      process.exit(1);
    }
  } else if (opts.since) {
    runIds = resolveRunsSince(opts.since);
    if (!runIds.length) {
      console.error(`No harness-eval run dirs found since ${opts.since}.`);
      process.exit(1);
    }
  } else {
    console.error([
      'Usage:',
      '  node scripts/aggregate-matrix-cost.mjs --run-id <id>',
      '  node scripts/aggregate-matrix-cost.mjs --all-2026-05-23',
      '  node scripts/aggregate-matrix-cost.mjs --since YYYY-MM-DD',
      '  Add --json for machine-readable output.',
    ].join('\n'));
    process.exit(1);
  }

  const db = openDb();

  const runResults = [];
  for (const runId of runIds) {
    const summary = loadSummary(runId);
    const wfIds = wfIdsFromSummary(summary);
    const data = queryRun(db, wfIds);
    runResults.push({ runId, wfIds, summary, data });
  }

  if (opts.json) {
    console.log(JSON.stringify(
      runResults.map(r => ({
        runId: r.runId,
        workflowIds: r.wfIds,
        totalCostUsd: r.data.total_cost,
        nullCostRows: r.data.null_cost_rows,
        inputTokens: r.data.input_tokens,
        outputTokens: r.data.output_tokens,
        callCount: r.data.call_count,
        perModel: r.data.per_model,
        perTask: r.data.per_task,
      })),
      null, 2,
    ));
    return;
  }

  for (const r of runResults) {
    printRunReport(r.runId, r.wfIds, r.data);
  }

  if (runResults.length > 1) {
    printAggregateFooter(runResults);
  }

  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
