#!/usr/bin/env node
// run-omniroute-model-matrix.mjs
// Stress-test every model exposed by Omniroute: fixed prompt suite, per-model
// latency / success rate / cost / output hash. Holds task constant; varies model.
//
// USAGE
//   node scripts/run-omniroute-model-matrix.mjs
//   node scripts/run-omniroute-model-matrix.mjs --limit 50 --concurrency 4
//   node scripts/run-omniroute-model-matrix.mjs --free-only --providers cc,cx
//   node scripts/run-omniroute-model-matrix.mjs --prompts fact,json
//   node scripts/run-omniroute-model-matrix.mjs --resume
//
// OUTPUT
//   data/model-matrix/<runId>/summary.json
//   data/model-matrix/<runId>/per-model.ndjson

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(__dirname, '..');

// ── Load .env (best-effort; real env vars take precedence) ───────────────────
function loadDotEnv() {
  const envPath = join(REPO_ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

// ── Fixed prompt suite ───────────────────────────────────────────────────────
export const PROMPTS = {
  fact: {
    id: 'fact',
    label: 'Fact lookup',
    messages: [
      {
        role: 'user',
        content: 'What year was TypeScript first released? Answer with only the year, four digits.',
      },
    ],
  },
  json: {
    id: 'json',
    label: 'JSON extraction',
    messages: [
      {
        role: 'user',
        content:
          "Extract {name, age, city} from: 'Maria Silva, 42, São Paulo'. Output a JSON object only.",
      },
    ],
  },
  summary: {
    id: 'summary',
    label: 'Short summarization',
    messages: [
      {
        role: 'user',
        content:
          "Summarize in one sentence under 30 words: 'The kernel scheduler decides which thread runs on each CPU core based on priority, fairness, and I/O wait state.'",
      },
    ],
  },
};

// ── CLI arg parser (exported for unit tests) ─────────────────────────────────
export function parseArgs(argv) {
  const args = argv.slice(2); // strip node + script
  const result = {
    limit: 20,
    freeOnly: false,
    providers: [],        // empty = all
    prompts: ['fact', 'json', 'summary'],
    concurrency: 4,
    timeoutS: 60,
    resume: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--limit':
        result.limit = parseInt(args[++i], 10);
        break;
      case '--free-only':
        result.freeOnly = true;
        break;
      case '--providers':
        result.providers = (args[++i] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
        break;
      case '--prompts':
        result.prompts = (args[++i] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
        break;
      case '--concurrency':
        result.concurrency = parseInt(args[++i], 10);
        break;
      case '--timeout-s':
        result.timeoutS = parseInt(args[++i], 10);
        break;
      case '--resume':
        result.resume = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      default:
        // ignore unknown flags silently
        break;
    }
  }

  // Validate
  if (isNaN(result.limit) || result.limit < 1) result.limit = 20;
  if (isNaN(result.concurrency) || result.concurrency < 1) result.concurrency = 4;
  if (isNaN(result.timeoutS) || result.timeoutS < 1) result.timeoutS = 60;
  const validPrompts = Object.keys(PROMPTS);
  result.prompts = result.prompts.filter((p) => validPrompts.includes(p));
  if (result.prompts.length === 0) result.prompts = validPrompts;

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sha256(text) {
  return createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);
}

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function classifyError(err, statusCode) {
  if (statusCode === 429) return 'rate-limited';
  if (statusCode === 400) return 'schema-rejection';
  if (statusCode === 403 || statusCode === 401) return 'auth-error';
  if (statusCode >= 500) return 'http-server-error';
  if (statusCode && statusCode >= 400) return 'http-client-error';
  const msg = (err?.message ?? '').toLowerCase();
  if (msg.includes('timeout') || msg.includes('abort') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('refus') || msg.includes('content policy') || msg.includes('safety')) return 'refusal';
  if (msg.includes('fetch') || msg.includes('econnrefused') || msg.includes('network')) return 'network-error';
  return 'unknown';
}

// ── Model listing ─────────────────────────────────────────────────────────────
async function fetchModels(baseUrl, apiKey) {
  const url = `${baseUrl}/v1/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GET /v1/models → HTTP ${res.status}`);
  const body = await res.json();
  // OpenAI format: { data: [...] }  or just an array
  return Array.isArray(body) ? body : (body.data ?? []);
}

// ── Single model + prompt run ─────────────────────────────────────────────────
async function runPrompt({ baseUrl, apiKey, modelId, prompt, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = Date.now();
  let status = 'ok';
  let errorClass = null;
  let statusCode = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsdHeader = null;
  let outputText = '';

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: prompt.messages,
        max_tokens: 256,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    statusCode = res.status;
    costUsdHeader = res.headers.get('x-omniroute-response-cost') ?? null;

    if (!res.ok) {
      status = 'error';
      errorClass = classifyError(null, statusCode);
    } else {
      const body = await res.json();
      outputText = body?.choices?.[0]?.message?.content ?? '';
      tokensIn = body?.usage?.prompt_tokens ?? 0;
      tokensOut = body?.usage?.completion_tokens ?? 0;

      if (!outputText) {
        status = 'zero-output';
        errorClass = 'zero-output-cost-billed';
      } else if (
        /I (can't|cannot|am unable|won't|refuse)/i.test(outputText) &&
        outputText.length < 200
      ) {
        status = 'refusal';
        errorClass = 'refusal';
      }
    }
  } catch (err) {
    status = 'error';
    errorClass = classifyError(err, statusCode);
  } finally {
    clearTimeout(timer);
  }

  return {
    promptId: prompt.id,
    durationMs: Date.now() - start,
    status,
    errorClass,
    statusCode,
    tokensIn,
    tokensOut,
    costUsdHeader: costUsdHeader !== null ? parseFloat(costUsdHeader) : null,
    outputSha256: sha256(outputText),
    outputSnippet: outputText.slice(0, 120),
  };
}

// ── Concurrency pool ──────────────────────────────────────────────────────────
async function pool(tasks, concurrency) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = parseArgs(process.argv);

  if (cfg.help) {
    console.log(`
run-omniroute-model-matrix.mjs — Omniroute per-model stress tester

FLAGS
  --limit N          Cap models tested (default 20)
  --free-only        Only test models with $0 pricing
  --providers a,b,c  Filter model IDs by prefix (e.g. cc,cx,kmc)
  --prompts a,b,c    Subset of: fact,json,summary (default all 3)
  --concurrency N    Parallel model slots (default 4)
  --timeout-s N      Per-model-prompt timeout in seconds (default 60)
  --resume           Skip models already recorded in latest run's ndjson
  --help             Show this help

OUTPUT
  data/model-matrix/<runId>/summary.json
  data/model-matrix/<runId>/per-model.ndjson

ERROR CLASSES
  timeout            Model did not respond within --timeout-s
  refusal            Model returned a content-policy refusal
  schema-rejection   HTTP 400 — malformed request or unsupported params
  http-server-error  HTTP 5xx from Omniroute or upstream provider
  http-client-error  Other 4xx
  rate-limited       HTTP 429
  auth-error         HTTP 401/403
  zero-output-cost-billed  Empty choices[0].message.content — billed but silent
  network-error      TCP/fetch-level failure
  unknown            Unclassified
`);
    process.exit(0);
  }

  const baseUrl = (process.env.OMNIROUTE_URL ?? 'http://localhost:20128').replace(/\/$/, '');
  const apiKey = process.env.OMNIROUTE_API_KEY ?? '';
  if (!apiKey) {
    console.warn('⚠  OMNIROUTE_API_KEY not set — requests may fail with 401');
  }

  const runId = nowId();
  const outDir = join(REPO_ROOT, 'data', 'model-matrix', runId);
  mkdirSync(outDir, { recursive: true });
  const ndjsonPath = join(outDir, 'per-model.ndjson');
  const summaryPath = join(outDir, 'summary.json');

  console.log(`Run ID : ${runId}`);
  console.log(`Output : ${outDir}`);
  console.log(`Config : limit=${cfg.limit} concurrency=${cfg.concurrency} timeout=${cfg.timeoutS}s`);
  console.log(`Prompts: ${cfg.prompts.join(', ')}`);

  // ── Load model list ──────────────────────────────────────────────────────
  console.log(`\nFetching model list from ${baseUrl}/v1/models …`);
  let models;
  try {
    models = await fetchModels(baseUrl, apiKey);
  } catch (err) {
    console.error(`Failed to fetch model list: ${err.message}`);
    process.exit(1);
  }
  console.log(`  → ${models.length} models returned by Omniroute`);

  // ── Provider filter ──────────────────────────────────────────────────────
  if (cfg.providers.length > 0) {
    models = models.filter((m) =>
      cfg.providers.some((prefix) => (m.id ?? '').toLowerCase().startsWith(prefix.toLowerCase()))
    );
    console.log(`  → ${models.length} after --providers filter`);
  }

  // ── Free-only filter ─────────────────────────────────────────────────────
  if (cfg.freeOnly) {
    // Omniroute model objects sometimes carry pricing metadata
    models = models.filter((m) => {
      const pricingIn = m?.pricing?.prompt ?? m?.input_cost_per_token ?? null;
      const pricingOut = m?.pricing?.completion ?? m?.output_cost_per_token ?? null;
      if (pricingIn === null && pricingOut === null) return true; // unknown = include
      return (parseFloat(pricingIn) === 0) && (parseFloat(pricingOut) === 0);
    });
    console.log(`  → ${models.length} after --free-only filter`);
  }

  // ── Resume: skip already-tested models ──────────────────────────────────
  const alreadyTested = new Set();
  if (cfg.resume) {
    // Find latest existing run directory
    const matrixRoot = join(REPO_ROOT, 'data', 'model-matrix');
    if (existsSync(matrixRoot)) {
      const { readdirSync } = await import('node:fs');
      const runs = readdirSync(matrixRoot).sort().reverse();
      for (const run of runs) {
        if (run === runId) continue;
        const ndj = join(matrixRoot, run, 'per-model.ndjson');
        if (!existsSync(ndj)) continue;
        const lines = readFileSync(ndj, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            if (rec.modelId) alreadyTested.add(rec.modelId);
          } catch { /* skip malformed */ }
        }
        break; // only use the most recent run
      }
    }
    if (alreadyTested.size > 0) {
      models = models.filter((m) => !alreadyTested.has(m.id));
      console.log(`  → ${models.length} after --resume filter (${alreadyTested.size} already tested)`);
    }
  }

  // ── Apply limit ──────────────────────────────────────────────────────────
  models = models.slice(0, cfg.limit);
  console.log(`  → Testing ${models.length} models\n`);

  const selectedPrompts = cfg.prompts.map((id) => PROMPTS[id]).filter(Boolean);
  const timeoutMs = cfg.timeoutS * 1000;

  const startedAt = new Date().toISOString();
  let tested = 0;
  let passed = 0;
  let failed = 0;
  const errorClassCounts = {};

  // ── Build task list (model × prompt) then group by model ─────────────────
  const modelTasks = models.map((model) => async () => {
    const modelId = model.id ?? String(model);
    const provider = modelId.split('/')[0] ?? 'unknown';
    const promptResults = [];

    for (const prompt of selectedPrompts) {
      const result = await runPrompt({ baseUrl, apiKey, modelId, prompt, timeoutMs });
      promptResults.push(result);
    }

    // Aggregate across prompts for this model
    const totalDurationMs = promptResults.reduce((s, r) => s + r.durationMs, 0);
    const avgDurationMs = Math.round(totalDurationMs / promptResults.length);
    const successCount = promptResults.filter((r) => r.status === 'ok').length;
    const overallStatus = successCount === promptResults.length
      ? 'ok'
      : successCount === 0 ? 'error' : 'partial';
    const dominantError = promptResults.find((r) => r.errorClass)?.errorClass ?? null;
    const totalCost = promptResults.reduce((s, r) => s + (r.costUsdHeader ?? 0), 0);

    const record = {
      modelId,
      provider,
      durationMs: avgDurationMs,
      status: overallStatus,
      successCount,
      totalPrompts: promptResults.length,
      tokensIn: promptResults.reduce((s, r) => s + r.tokensIn, 0),
      tokensOut: promptResults.reduce((s, r) => s + r.tokensOut, 0),
      costUsdHeader: totalCost > 0 ? totalCost : null,
      outputSha256: promptResults.map((r) => r.outputSha256).join('|'),
      errorClass: dominantError,
      promptResults,
    };

    appendFileSync(ndjsonPath, JSON.stringify(record) + '\n');
    tested++;
    if (overallStatus === 'ok') passed++;
    else {
      failed++;
      if (dominantError) errorClassCounts[dominantError] = (errorClassCounts[dominantError] ?? 0) + 1;
    }

    const icon = overallStatus === 'ok' ? '✓' : overallStatus === 'partial' ? '~' : '✗';
    console.log(
      `  [${tested}/${models.length}] ${icon} ${modelId.padEnd(48)} ` +
      `${avgDurationMs}ms  ${overallStatus}${dominantError ? ` (${dominantError})` : ''}`
    );

    return record;
  });

  const allRecords = await pool(modelTasks, cfg.concurrency);

  // ── Write summary ─────────────────────────────────────────────────────────
  const summary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    config: cfg,
    baseUrl,
    totalModels: models.length,
    tested,
    passed,
    failed,
    passRate: tested > 0 ? (passed / tested).toFixed(3) : '0',
    errorClassCounts,
    p50DurationMs: percentile(allRecords.map((r) => r.durationMs), 50),
    p95DurationMs: percentile(allRecords.map((r) => r.durationMs), 95),
    totalCostUsd: allRecords.reduce((s, r) => s + (r.costUsdHeader ?? 0), 0).toFixed(6),
  };

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`\n── Summary ──────────────────────────────────────────────`);
  console.log(`  Tested   : ${tested}`);
  console.log(`  Passed   : ${passed}  (${(summary.passRate * 100).toFixed(1)}%)`);
  console.log(`  Failed   : ${failed}`);
  console.log(`  p50 ms   : ${summary.p50DurationMs}`);
  console.log(`  p95 ms   : ${summary.p95DurationMs}`);
  console.log(`  Total $  : ${summary.totalCostUsd}`);
  if (Object.keys(errorClassCounts).length > 0) {
    console.log(`  Errors   :`, errorClassCounts);
  }
  console.log(`\n  summary  : ${summaryPath}`);
  console.log(`  ndjson   : ${ndjsonPath}`);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// Only auto-run when executed directly (e.g. `node scripts/run-omniroute-model-matrix.mjs`),
// not when imported by unit tests — otherwise main()/process.exit(1) fires at import time
// and tears down the vitest worker.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
