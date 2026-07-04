#!/usr/bin/env node
// Test Harness - Omniforge Aurora Benchmark
// Executes tests across 3 complexity levels using multiple models
// Results saved to audit-claude-2026-05-24/benchmark-results/

import { execSync } from 'child_process';
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', '..', 'audit-claude-2026-05-24', 'benchmark-results');
const DAEMON_PORT = 20129;
const TIMEOUT_MS = 120000;

// === MODELS ===
const MODELS = {
  'cc/claude-opus-4-7': { tier: 'S+', provider: 'Anthropic', family: 'opus' },
  'cx/gpt-5.4': { tier: 'S+', provider: 'OpenAI/Cursor', family: 'gpt5' },
  'gemini-cli/gemini-3.1-pro-preview': { tier: 'S+', provider: 'Google', family: 'gemini3' },
  'cc/claude-opus-4-6': { tier: 'S', provider: 'Anthropic', family: 'opus' },
  'cx/gpt-5.3-codex': { tier: 'S', provider: 'OpenAI/Cursor', family: 'gpt-codex' },
  'cc/claude-sonnet-4-6': { tier: 'S-', provider: 'Anthropic', family: 'sonnet' },
  'cx/gpt-5.2': { tier: 'S-', provider: 'OpenAI/Cursor', family: 'gpt5' },
  'gemini-cli/gemini-2.5-pro': { tier: 'A', provider: 'Google', family: 'gemini-pro' },
  'cc/claude-haiku-4-5-20251001': { tier: 'B+', provider: 'Anthropic', family: 'haiku' },
  'gemini-cli/gemini-2.5-flash': { tier: 'B+', provider: 'Google', family: 'flash' },
};

// === TEST PROMPTS BY LEVEL ===
const LEVEL_1 = [
  { id: 'L1-01', cat: 'explanation', prompt: 'Explain what dependency injection is in 3 sentences.' },
  { id: 'L1-02', cat: 'code-gen', prompt: 'Write a regex to validate email addresses. Return only the regex.' },
  { id: 'L1-03', cat: 'translation', prompt: 'Convert to JS: sorted([x for x in range(100) if x%7==0],reverse=True)[:3]' },
  { id: 'L1-04', cat: 'knowledge', prompt: 'List 5 best practices for writing unit tests. One sentence each.' },
  { id: 'L1-05', cat: 'explanation', prompt: 'Difference between process.env and dotenv in Node.js? Brief.' },
  { id: 'L1-06', cat: 'knowledge', prompt: 'Explain the CAP theorem in 2 sentences.' },
  { id: 'L1-07', cat: 'code-gen', prompt: 'SQL: find top 3 customers by total order value using GROUP BY.' },
  { id: 'L1-08', cat: 'explanation', prompt: 'What does "git rebase" do? One paragraph.' },
  { id: 'L1-09', cat: 'code-gen', prompt: 'TypeScript interface: User with id, name, email, createdAt, roles[].' },
  { id: 'L1-10', cat: 'explanation', prompt: 'Difference between Promise.all and Promise.allSettled? One paragraph.' },
  { id: 'L1-11', cat: 'code-gen', prompt: 'Bash one-liner: count lines of .ts files recursively, exclude node_modules.' },
  { id: 'L1-12', cat: 'knowledge', prompt: 'What is a JWT and where does the signature come from? Brief.' },
  { id: 'L1-13', cat: 'code-gen', prompt: 'CSS media query targeting screens 768px-1200px wide.' },
  { id: 'L1-14', cat: 'knowledge', prompt: 'Time complexity of quicksort? Worst and average case.' },
  { id: 'L1-15', cat: 'code-gen', prompt: 'Dockerfile for Node.js 22 + pnpm. Minimal.' },
  { id: 'L1-16', cat: 'explanation', prompt: 'Explain CORS preflight requests in 2 sentences.' },
  { id: 'L1-17', cat: 'code-gen', prompt: 'Python one-liner: dict of squares 1-10 using comprehension.' },
  { id: 'L1-18', cat: 'knowledge', prompt: 'TCP vs UDP difference. One sentence each.' },
  { id: 'L1-19', cat: 'code-gen', prompt: 'Git: show commits by author "Example" in last 7 days.' },
  { id: 'L1-20', cat: 'knowledge', prompt: 'What is a race condition? Brief answer.' },
];

const LEVEL_2 = [
  { id: 'L2-01', cat: 'implementation', prompt: 'TypeScript: retry mechanism with exponential backoff + AbortSignal + JSDoc.' },
  { id: 'L2-02', cat: 'implementation', prompt: 'TypeScript TokenBucket rate limiter class: constructor, tryConsume, refill.' },
  { id: 'L2-03', cat: 'sql', prompt: 'PostgreSQL migration: add JSONB metadata column with GIN index, backfill empty objects.' },
  { id: 'L2-04', cat: 'implementation', prompt: 'React custom hook: useDebounce<T>(value: T, delay: number): T with cleanup.' },
  { id: 'L2-05', cat: 'implementation', prompt: 'Node.js JWT auth middleware in TypeScript. No frameworks, extract claims to req.' },
  { id: 'L2-06', cat: 'implementation', prompt: 'LRU cache in TypeScript: get, set, size. O(1) ops. Use Map.' },
  { id: 'L2-07', cat: 'implementation', prompt: 'Typed event emitter in TypeScript: on, off, once, emit. Type-safe emit.' },
  { id: 'L2-08', cat: 'schema', prompt: 'Zod schema for workflow config: name, tasks array (id, kind, timeout_ms?), metadata.' },
  { id: 'L2-09', cat: 'implementation', prompt: 'Async fs function: recursive directory read, filter by ext, flat absolute paths.' },
  { id: 'L2-10', cat: 'implementation', prompt: 'Typed pub/sub system in TypeScript: publish, subscribe, unsubscribe. No deps.' },
  { id: 'L2-11', cat: 'sql', prompt: 'PostgreSQL: rank tasks by duration within each workflow. Top 2 longest per workflow.' },
  { id: 'L2-12', cat: 'implementation', prompt: 'Circular buffer (ring buffer) class in TypeScript: push, pop, peek, isFull.' },
  { id: 'L2-13', cat: 'implementation', prompt: 'Safe JSON parser returning Result/Option pattern. No throw. TypeScript.' },
  { id: 'L2-14', cat: 'implementation', prompt: 'State machine in TypeScript: states, transitions, guards. Traffic light example.' },
  { id: 'L2-15', cat: 'schema', prompt: 'Zod DAG validator: nodes(id, kind), edges(from, to). Cycle detection refinement.' },
  { id: 'L2-16', cat: 'algorithm', prompt: 'Merge two sorted arrays O(n+m). TypeScript, no built-in sort.' },
  { id: 'L2-17', cat: 'implementation', prompt: 'Template engine replacing {{var}} with context values. Support {{user.name}}. TS.' },
  { id: 'L2-18', cat: 'implementation', prompt: 'DB connection pool: acquire, release, drain. Max connections, async. TypeScript.' },
  { id: 'L2-19', cat: 'implementation', prompt: 'Deep clone with Date, RegExp, Map, Set, circular refs. TypeScript.' },
  { id: 'L2-20', cat: 'implementation', prompt: 'Task scheduler with concurrency limit. Results in order. TypeScript.' },
];

const LEVEL_3 = [
  { id: 'L3-01', cat: 'architecture', prompt: 'Design multi-tenant SaaS: DB isolation, auth, rate limiting, tenant-aware logging, deployment.' },
  { id: 'L3-02', cat: 'security', prompt: 'Threat model for REST API handling financial data. OWASP Top 10, mitigations, risk priority.' },
  { id: 'L3-03', cat: 'architecture', prompt: 'Distributed task queue (Celery-inspired): producer, workers, routing, retry, DLQ, observability.' },
  { id: 'L3-04', cat: 'architecture', prompt: 'AI agent-to-agent protocol: message format, routing, HMAC+encryption, streaming, capability discovery.' },
  { id: 'L3-05', cat: 'architecture', prompt: 'Cross-platform file sync: conflict resolution (CRDT, 3-way merge), partial sync, bandwidth opt.' },
  { id: 'L3-06', cat: 'architecture', prompt: 'Vector DB query planner: hybrid search (semantic+keyword+metadata), cost estimation, index selection.' },
  { id: 'L3-07', cat: 'architecture', prompt: 'NL-to-DAG decomposition algorithm: preprocessing, heuristics (granularity, fanout, critical path), validation, feedback loop.' },
  { id: 'L3-08', cat: 'security', prompt: 'LLM code sandbox: 3-layer defense (isolation, capability restriction, output validation). Concrete strategies.' },
  { id: 'L3-09', cat: 'architecture', prompt: 'LLM evaluation framework: factual accuracy, instruction following, code correctness, safety. Judge selection, metric aggregation.' },
  { id: 'L3-10', cat: 'architecture', prompt: 'Federated GraphQL gateway: schema composition, query planning, N+1 prevention, auth propagation, caching.' },
  { id: 'L3-11', cat: 'architecture', prompt: 'Real-time collaborative text editor with CRDTs: RGA data structure, cursor presence, offline support.' },
  { id: 'L3-12', cat: 'architecture', prompt: 'Zero-downtime PostgreSQL migration: schema changes, backfills, rollback, locks, multi-step plan.' },
  { id: 'L3-13', cat: 'architecture', prompt: 'Observability pipeline: structured logging, distributed tracing, metrics, alerting. Sampling, cardinality, cost.' },
  { id: 'L3-14', cat: 'architecture', prompt: 'Plugin system: hot-reload, sandboxed execution, version compatibility, dependency resolution, lifecycle hooks.' },
  { id: 'L3-15', cat: 'security', prompt: 'GDPR right-to-be-forgotten: relational data, event sourcing, search indexes, backups, 3rd-party. Data flow + deletion strategies.' },
  { id: 'L3-16', cat: 'architecture', prompt: 'Financial ledger: double-entry accounting, immutable log, balance computation, reconciliation, audit. PostgreSQL + TS.' },
  { id: 'L3-17', cat: 'architecture', prompt: 'Content moderation pipeline: pre-filter regex, ML classification, human review queue, appeal. SLA targets, FP/FN tradeoffs.' },
  { id: 'L3-18', cat: 'architecture', prompt: 'Monorepo CI/CD (15 packages): dependency graph, parallel builds, cache invalidation, canary, rollback.' },
  { id: 'L3-19', cat: 'architecture', prompt: 'Social feed data model: fan-out write vs read, timeline, ML ranking, Redis caching, cursor pagination.' },
  { id: 'L3-20', cat: 'architecture', prompt: 'Compare AI agent orchestration: static DAG vs supervisor-agent vs swarm/consensus. Failure modes, cost, latency, quality. Decision matrix.' },
];

// === UTILS ===
function log(msg) { const ts = new Date().toISOString().split('T')[1].split('.')[0]; process.stdout.write(`[${ts}] ${msg}\n`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getToken() { try { return readFileSync('data/daemon-token.txt','utf8').trim(); } catch { return ''; } }

function saveResults(fileName, data) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, fileName), JSON.stringify(data, null, 2));
}

// === DAEMON LLM CALLER ===
async function daemonLlmCall(prompt, model, signal) {
  return new Promise((resolve) => {
    const token = getToken();
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, temperature: 0.2 });

    const req = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT,
      path: `/stream/llm?token=${token}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS, signal,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.content || json.choices?.[0]?.message?.content || json.text || null;
          resolve({ success: !!content, content, model_used: json.model || model, raw: json });
        } catch {
          resolve({ success: false, content: null, error: `HTTP ${res.statusCode}: ${data.slice(0,200)}` });
        }
      });
    });
    req.on('error', e => { if (e.name !== 'AbortError') resolve({ success: false, content: null, error: e.message }); });
    req.on('timeout', () => { req.destroy(); resolve({ success: false, content: null, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// === EXECUTE LEVEL ===
async function runLevel(levelName, tests, models, concurrency = 3) {
  log(`\n┌${'─'.repeat(60)}`);
  log(`│ ${levelName} — ${tests.length} tests × ${models.length} models (${tests.length * models.length} total)`);
  log(`└${'─'.repeat(60)}`);

  const results = [];
  const modelList = Object.entries(models).slice(0, models === MODELS ? models : Object.keys(models).length);

  for (const [modelId, modelInfo] of modelList) {
    log(`  ▶ Model: ${modelId} (${modelInfo.tier}, ${modelInfo.provider})`);

    for (let i = 0; i < tests.length; i++) {
      const test = tests[i];
      const aborter = new AbortController();
      const timeout = setTimeout(() => aborter.abort(), TIMEOUT_MS);

      log(`    ${test.id} [${test.cat}]: ${test.prompt.slice(0,70)}...`);
      const start = Date.now();

      try {
        const result = await daemonLlmCall(test.prompt, modelId, aborter.signal);
        clearTimeout(timeout);
        const duration = Date.now() - start;
        const entry = { ...test, model: modelId, model_info: modelInfo, duration_ms: duration, ...result };
        if (result.content) {
          entry.content_length = result.content.length;
          entry.word_count = result.content.split(/\s+/).length;
          entry.has_code = result.content.includes('```');
        }
        results.push(entry);
        const status = result.success ? '✓' : '✗';
        log(`      ${status} ${duration}ms | ${entry.content_length || 0} chars | ${entry.word_count || 0} words`);
        if (!result.success) log(`        Error: ${result.error}`);
      } catch (e) {
        clearTimeout(timeout);
        results.push({ ...test, model: modelId, model_info: modelInfo, duration_ms: Date.now() - start, success: false, error: e.message });
        log(`      ✗ ${Date.now() - start}ms | Error: ${e.message}`);
      }

      saveResults(`${levelName.toLowerCase().replace(/\s+/g,'-')}-results.json`, results);
      await sleep(2000);
    }
  }

  return results;
}

// === MAIN ===
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   OMNIFORGE AURORA — BENCHMARK & HARDENING SUITE            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Models: ${Object.keys(MODELS).length} | Levels: 3 | Output: ${OUTPUT_DIR}\n`);

  const allStart = Date.now();
  const allResults = { level1: [], level2: [], level3: [] };

  // L1: 20 tests × 4 models = 80 (fast models for basic)
  const l1Models = Object.fromEntries(
    Object.entries(MODELS).filter(([k]) =>
      k.includes('haiku') || k.includes('flash') || k.includes('sonnet-4-6') || k.includes('gpt-5.3')
    )
  );
  allResults.level1 = await runLevel('LEVEL 1 — BASIC', LEVEL_1, l1Models);

  // L2: 20 tests × 4 models = 80
  const l2Models = Object.fromEntries(
    Object.entries(MODELS).filter(([k]) =>
      k.includes('sonnet') || k.includes('gpt-5.2') || k.includes('gemini-2.5-pro') || k.includes('opus-4-6')
    )
  );
  allResults.level2 = await runLevel('LEVEL 2 — INTERMEDIATE', LEVEL_2, l2Models);

  // L3: 20 tests × 3 models = 60
  const l3Models = Object.fromEntries(
    Object.entries(MODELS).filter(([k]) =>
      k.includes('opus-4-7') || k.includes('gpt-5.4') || k.includes('gemini-3.1-pro')
    )
  );
  allResults.level3 = await runLevel('LEVEL 3 — ADVANCED', LEVEL_3, l3Models);

  // === SUMMARY ===
  const total = allResults.level1.length + allResults.level2.length + allResults.level3.length;
  const totalDuration = Math.round((Date.now() - allStart) / 1000);

  const summary = {
    run_at: new Date().toISOString(),
    total_duration_sec: totalDuration,
    total_tests: total,
    level1: { tests: allResults.level1.length, passed: allResults.level1.filter(r => r.success).length },
    level2: { tests: allResults.level2.length, passed: allResults.level2.filter(r => r.success).length },
    level3: { tests: allResults.level3.length, passed: allResults.level3.filter(r => r.success).length },
    models: {},
  };

  const all = [...allResults.level1, ...allResults.level2, ...allResults.level3];
  for (const r of all) {
    if (!r.model) continue;
    if (!summary.models[r.model]) {
      summary.models[r.model] = { tier: r.model_info?.tier || '?', provider: r.model_info?.provider || '?', tests: 0, passed: 0, total_duration_ms: 0, total_content_length: 0, content_counts: 0 };
    }
    const m = summary.models[r.model];
    m.tests++;
    if (r.success) m.passed++;
    m.total_duration_ms += r.duration_ms || 0;
    if (r.content_length) { m.total_content_length += r.content_length; m.content_counts++; }
  }

  for (const [mid, ms] of Object.entries(summary.models)) {
    ms.avg_duration_ms = Math.round(ms.total_duration_ms / ms.tests);
    ms.avg_content_length = ms.content_counts > 0 ? Math.round(ms.total_content_length / ms.content_counts) : 0;
    ms.pass_rate_pct = ((ms.passed / ms.tests) * 100).toFixed(1);
  }

  // Category stats
  summary.by_category = {};
  for (const r of all) {
    if (!r.cat) continue;
    if (!summary.by_category[r.cat]) summary.by_category[r.cat] = { tests: 0, passed: 0, total_duration_ms: 0 };
    summary.by_category[r.cat].tests++;
    if (r.success) summary.by_category[r.cat].passed++;
    summary.by_category[r.cat].total_duration_ms += r.duration_ms || 0;
  }
  for (const [cat, cs] of Object.entries(summary.by_category)) {
    cs.avg_duration_ms = Math.round(cs.total_duration_ms / cs.tests);
    cs.pass_rate_pct = ((cs.passed / cs.tests) * 100).toFixed(1);
  }

  saveResults('summary.json', summary);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   BENCHMARK COMPLETE                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`  Duration: ${summary.total_duration_sec}s`);
  console.log(`  Level 1: ${summary.level1.passed}/${summary.level1.tests} passed`);
  console.log(`  Level 2: ${summary.level2.passed}/${summary.level2.tests} passed`);
  console.log(`  Level 3: ${summary.level3.passed}/${summary.level3.tests} passed`);
  console.log(`\n  Results: ${OUTPUT_DIR}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
