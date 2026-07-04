/**
 * Omniforge Aurora — Benchmark & Hardening Harness
 *
 * Tests models across 3 complexity levels.
 * Uses the same omniroute-call.ts used by the decomposer/reviewer/consolidator.
 * Run: npx tsx scripts/benchmark-harness.ts
 */
import { callOmniroute, callOmnirouteWithUsage } from '../src/utils/omniroute-call.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUTPUT_DIR = join(process.cwd(), 'audit-claude-2026-05-24', 'benchmark-results');
const TIMEOUT_MS = 90_000;

interface ModelInfo { tier: string; provider: string; family: string; }
interface TestCase { id: string; cat: string; prompt: string; }
interface TestResult extends TestCase {
  model: string;
  model_info: ModelInfo;
  duration_ms: number;
  success: boolean;
  content?: string | null;
  content_length?: number;
  word_count?: number;
  has_code?: boolean;
  usage?: { input_tokens?: number; output_tokens?: number; total_cost_usd?: number; };
  error?: string;
}

const MODELS: Record<string, ModelInfo> = {
  'cc/claude-opus-4-7':        { tier: 'S+',  provider: 'Anthropic',   family: 'opus-4.7' },
  'cx/gpt-5.4':                { tier: 'S+',  provider: 'OpenAI/Cursor', family: 'gpt-5.4' },
  'gemini-cli/gemini-3.1-pro-preview': { tier: 'S+', provider: 'Google', family: 'gemini-3.1' },
  'cc/claude-opus-4-6':        { tier: 'S',   provider: 'Anthropic',   family: 'opus-4.6' },
  'cx/gpt-5.3-codex':          { tier: 'S',   provider: 'OpenAI/Cursor', family: 'gpt-codex' },
  'cc/claude-sonnet-4-6':      { tier: 'S-',  provider: 'Anthropic',   family: 'sonnet-4.6' },
  'gemini-cli/gemini-2.5-pro': { tier: 'A',   provider: 'Google',      family: 'gemini-2.5' },
  'cc/claude-haiku-4-5-20251001': { tier: 'B+', provider: 'Anthropic', family: 'haiku' },
  'gemini-cli/gemini-2.5-flash': { tier: 'B+', provider: 'Google',     family: 'flash-2.5' },
};

// ===== TEST PROMPTS =====

const LEVEL_1: TestCase[] = [
  { id:'L1-01',cat:'explain', prompt:'Explain what dependency injection is in 3 sentences. Be concise.' },
  { id:'L1-02',cat:'code-gen', prompt:'Write a regex to validate email addresses. Return only the pattern.' },
  { id:'L1-03',cat:'translate', prompt:'Convert to JavaScript: sorted([x for x in range(100) if x%7==0], reverse=True)[:3]' },
  { id:'L1-04',cat:'knowledge', prompt:'List 5 best practices for writing unit tests. One sentence each.' },
  { id:'L1-05',cat:'explain', prompt:'Difference between process.env and dotenv in Node.js? Brief.' },
  { id:'L1-06',cat:'knowledge', prompt:'Explain the CAP theorem in 2 sentences.' },
  { id:'L1-07',cat:'code-gen', prompt:'SQL to find top 3 customers by total order value. Use GROUP BY and ORDER BY.' },
  { id:'L1-08',cat:'explain', prompt:'What does git rebase do? One paragraph.' },
  { id:'L1-09',cat:'code-gen', prompt:'TypeScript interface: User with id, name, email, createdAt, roles[].' },
  { id:'L1-10',cat:'explain', prompt:'Difference between Promise.all and Promise.allSettled? One paragraph.' },
  { id:'L1-11',cat:'code-gen', prompt:'Bash script: count .ts files recursively, excluding node_modules, print total lines.' },
  { id:'L1-12',cat:'knowledge', prompt:'What is a JWT and where does the signature come from? Brief.' },
  { id:'L1-13',cat:'code-gen', prompt:'CSS media query targeting screens between 768px and 1200px width.' },
  { id:'L1-14',cat:'knowledge', prompt:'Time complexity of quicksort? Worst and average cases.' },
  { id:'L1-15',cat:'code-gen', prompt:'Minimal Dockerfile for a Node.js 22 app using pnpm.' },
  { id:'L1-16',cat:'explain', prompt:'Explain CORS preflight requests in 2 sentences.' },
  { id:'L1-17',cat:'code-gen', prompt:'Python one-liner to create dict of squares {1:1, 2:4, ..., 10:100} using dict comprehension.' },
  { id:'L1-18',cat:'knowledge', prompt:'TCP vs UDP: one sentence for each.' },
  { id:'L1-19',cat:'code-gen', prompt:'Git command to show commits by author "Example" in last 7 days.' },
  { id:'L1-20',cat:'knowledge', prompt:'What is a race condition in concurrent programming? Brief.' },
];

const LEVEL_2: TestCase[] = [
  { id:'L2-01', cat:'impl', prompt:'Implement a retry mechanism with exponential backoff in TypeScript. Include: JSDoc, error handling, AbortSignal support. Return complete function code.' },
  { id:'L2-02', cat:'impl', prompt:'Write a TokenBucket rate limiter class in TypeScript: constructor(maxTokens, refillRate, refillIntervalMs), tryConsume(count):{allowed,retryAfterMs}, refill(). Thread-safe.' },
  { id:'L2-03', cat:'sql', prompt:'PostgreSQL migration SQL: add metadata JSONB column to workflows table NOT NULL DEFAULT {}::jsonb, create GIN index, backfill existing rows.' },
  { id:'L2-04', cat:'impl', prompt:'React custom hook useDebounce<T>(value: T, delay: number): T in TypeScript. Include useEffect cleanup on unmount. Complete implementation.' },
  { id:'L2-05', cat:'impl', prompt:'Node.js JWT auth middleware in TypeScript: validate Bearer token from Authorization header, extract claims, attach to request. No framework dependencies.' },
  { id:'L2-06', cat:'impl', prompt:'Implement an LRU cache in TypeScript: class LRUCache<K,V> with constructor(capacity), get(key):V|undefined, set(key,value):void, size():number. O(1) operations. Use Map internally.' },
  { id:'L2-07', cat:'impl', prompt:'Typed EventEmitter in TypeScript: on<K>(event, handler), off<K>(event, handler), once<K>(event, handler), emit<K>(event, ...args). Type-safe emit based on event map. Complete implementation.' },
  { id:'L2-08', cat:'schema', prompt:'Zod schema for: WorkflowConfig { name: string, tasks: Task[] { id, kind, model?, timeout_ms?, depends_on?: string[] }, metadata?: Record<string,unknown> }. Complete schema code.' },
  { id:'L2-09', cat:'impl', prompt:'Async function recursiveReaddir(dir, ext): Promise<string[]> — recursively read directory, filter by file extension, return flat array of absolute paths. Handle permission errors gracefully.' },
  { id:'L2-10', cat:'impl', prompt:'Typed PubSub system in TypeScript: publish(channel, payload), subscribe(channel, handler):string (returns sub ID), unsubscribe(subId). No external dependencies. Complete code.' },
  { id:'L2-11', cat:'sql', prompt:'PostgreSQL: rank tasks by duration within each workflow using ROW_NUMBER() OVER (PARTITION BY workflow_id ORDER BY duration DESC). Show only top 2 per workflow.' },
  { id:'L2-12', cat:'impl', prompt:'CircularBuffer<T> class in TypeScript: constructor(capacity), push(item):T|undefined (overwrites oldest if full, returns evicted), pop():T|undefined, peek():T|undefined, isFull:boolean, isEmpty:boolean, size:number.' },
  { id:'L2-13', cat:'impl', prompt:'Safe JSON parser returning Result pattern: type Result<T,E> = {ok:true,value:T}|{ok:false,error:E}. safeJsonParse<T>(json:string):Result<T,ParseError>. Never throws. Complete implementation.' },
  { id:'L2-14', cat:'impl', prompt:'State machine in TypeScript: type StateMachine<S extends string, E extends string>. States: S, transitions: Record<S,Partial<Record<E,S>>>, guards: Record<E,(ctx?)=>boolean>. Transition method with guard checking. Traffic light example.' },
  { id:'L2-15', cat:'schema', prompt:'Zod schema for DAG definition: { nodes: {id:string, kind:string, model?:string}[], edges: {from:string, to:string}[], metadata?: Record }. Include refinement to check no duplicate IDs and edges reference existing nodes.' },
  { id:'L2-16', cat:'algo', prompt:'Merge two sorted number arrays in O(n+m) time. TypeScript. No built-in sort(). Return new sorted array.' },
  { id:'L2-17', cat:'impl', prompt:'Template engine: replace {{placeholder}} with values from context object. Support nested paths like {{user.name}} and {{items.0.title}}. TypeScript. No external deps.' },
  { id:'L2-18', cat:'impl', prompt:'Database connection pool: class ConnectionPool { constructor(maxConnections), async acquire():Promise<Connection>, release(conn), async drain() }. Mock the Connection type. Async-safe. Complete TypeScript.' },
  { id:'L2-19', cat:'impl', prompt:'Deep clone function handling: objects, arrays, Date, RegExp, Map, Set, and circular references. TypeScript. No structuredClone or lodash.' },
  { id:'L2-20', cat:'impl', prompt:'Task scheduler: async function runWithConcurrency<T>(tasks:(()=>Promise<T>)[], maxConcurrency:number):Promise<T[]>. Results in original order. TypeScript.' },
];

const LEVEL_3: TestCase[] = [
  { id:'L3-01', cat:'arch', prompt:'Design multi-tenant SaaS architecture. Cover: database isolation (schema vs database vs row-level), authentication strategy, tenant-aware rate limiting, tenant-scoped logging, deployment model. Provide structured design document.' },
  { id:'L3-02', cat:'security', prompt:'Threat model for REST API handling financial data. Map OWASP Top 10 to specific threats. Propose concrete mitigations per threat. Prioritize by risk (likelihood × impact). Output structured document.' },
  { id:'L3-03', cat:'arch', prompt:'Design distributed task queue (Celery-inspired). Cover: producer API, worker pool with concurrency, task routing by queue/tag, retry policies (exponential backoff, max attempts), dead letter queue, observability (metrics, tracing). Provide TypeScript interfaces and architecture text.' },
  { id:'L3-04', cat:'arch', prompt:'Design AI agent-to-agent communication protocol. Cover: message envelope format (JSON), routing (direct/broadcast/topic), security (HMAC signing + optional encryption), streaming support, capability advertisement/discovery. Provide spec with TypeScript types.' },
  { id:'L3-05', cat:'arch', prompt:'Cross-platform file synchronization system. Cover: conflict detection (vector clocks), resolution strategies (last-write-wins, CRDT merge, interactive), partial sync (chunking/delta), bandwidth optimization (compression, dedup). Architecture design.' },
  { id:'L3-06', cat:'arch', prompt:'Vector database query planner for hybrid search. Cover: query decomposition (semantic + keyword + filter), index selection (HNSW vs inverted), cost estimation (selectivity, dimensionality), query rewriting/optimization. Technical specification.' },
  { id:'L3-07', cat:'arch', prompt:'Design NL-to-DAG decomposition algorithm. Cover: input preprocessing (entity extraction, intent classification), heuristic application (granularity H1, fan-out H2, critical path H3, model diversity H15, falsifiable criteria H7), output validation (Zod schema), feedback loop (reviewer → refine). Detailed spec.' },
  { id:'L3-08', cat:'security', prompt:'LLM-generated code sandbox security design. 3-layer defense: (1) isolation layer (vm2/worker_threads vs container), (2) capability restriction (no network, fs limits), (3) output validation (static analysis, taint tracking). Concrete implementation strategies. Threat analysis.' },
  { id:'L3-09', cat:'arch', prompt:'LLM evaluation framework design. Metrics: factual accuracy, instruction following, code correctness, safety. Judge model selection (which model to evaluate which tasks). Metric aggregation (weighted average, pass@k). Confidence calibration. Technical specification.' },
  { id:'L3-10', cat:'arch', prompt:'Federated GraphQL gateway. Cover: schema composition (stitching vs federation), query planning (cost-based optimizer), N+1 prevention (DataLoader batching), authentication propagation (JWT forwarding), caching strategy (query-level + field-level). Architecture document.' },
  { id:'L3-11', cat:'arch', prompt:'Real-time collaborative text editor with CRDTs. Cover: data structure (RGA/Logoot for ordered list), operation representation, cursor presence protocol, offline editing + sync on reconnect, conflict handling. Technical design.' },
  { id:'L3-12', cat:'arch', prompt:'Zero-downtime PostgreSQL migration system. Cover: backward-compatible schema changes, online data backfill, rollback strategies per-migration-type, lock management (CONCURRENTLY, batched updates), multi-step migration orchestration. Implementation plan.' },
  { id:'L3-13', cat:'arch', prompt:'Observability pipeline design. Cover: structured logging (pino, correlation IDs), distributed tracing (OpenTelemetry, sampling strategies), metrics (Prometheus, cardinality management), alerting (thresholds, SLO-based). Cost optimization (sampling, retention). Architecture.' },
  { id:'L3-14', cat:'arch', prompt:'Plugin system architecture. Cover: hot-reloading (fs watch), sandboxed execution (worker_threads isolation), version compatibility (semver range checking), dependency resolution between plugins, lifecycle hooks (init, start, stop, config-change). TypeScript-first design with interfaces.' },
  { id:'L3-15', cat:'security', prompt:'GDPR right-to-be-forgotten implementation. Data flow analysis: relational data (soft delete + cascade), event-sourced aggregates (crypto-shred or tombstone), search indexes (reindex), backups (logical delete), third-party integrations (deletion API calls). Compliance timeline. Structured plan.' },
  { id:'L3-16', cat:'arch', prompt:'Financial ledger with double-entry accounting. Cover: immutable transaction log (append-only), balance computation (materialized vs on-the-fly), reconciliation process, audit trail (Merkle tree or hash chain). PostgreSQL schema + TypeScript domain model.' },
  { id:'L3-17', cat:'arch', prompt:'Content moderation pipeline. Cover: pre-filtering (regex, keyword blocklist), ML classification (toxicity, spam), human review queue (prioritized by confidence), appeal process. SLA targets per stage. False positive/negative trade-off analysis.' },
  { id:'L3-18', cat:'arch', prompt:'Monorepo CI/CD for 15 packages. Cover: dependency graph computation (affected detection), parallel builds, cache invalidation (content-hash based), canary deployments (traffic splitting), automated rollback (health check + revert). Architecture design.' },
  { id:'L3-19', cat:'arch', prompt:'Social network feed system. Cover: data model (post, follow graph), feed generation (fan-out on write vs on read), ML ranking (engagement prediction), caching (Redis sorted sets), pagination (cursor-based, Snowflake IDs). Design document.' },
  { id:'L3-20', cat:'arch', prompt:'Compare AI agent orchestration patterns: (1) static DAG, (2) dynamic supervisor-agent with adaptive iteration, (3) swarm consensus with voting. Analyze: failure modes, cost profiles, latency characteristics, quality tradeoffs, best use cases. Provide decision matrix with criteria weights.' },
];

// ===== CORE =====
function save(name: string, data: unknown) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, name), JSON.stringify(data, null, 2));
}

const ALL_RESULTS: Record<string, TestResult[]> = { level1: [], level2: [], level3: [] };

async function runOneTest(test: TestCase, model: string, modelInfo: ModelInfo): Promise<TestResult> {
  const start = Date.now();
  const controlledAbort = new AbortController();
  const timer = setTimeout(() => controlledAbort.abort(), TIMEOUT_MS);
  try {
    const result = await callOmnirouteWithUsage({
      systemPrompt: 'You are a senior software engineer. Answer concisely but thoroughly. Provide code when asked. Use TypeScript by default for code examples.',
      userPrompt: test.prompt,
      model,
      temperature: 0.2,
      signal: controlledAbort.signal,
    });
    clearTimeout(timer);
    const duration = Date.now() - start;
    return {
      ...test, model, model_info: modelInfo, duration_ms: duration, success: true,
      content: result.content,
      content_length: result.content.length,
      word_count: result.content.split(/\s+/).length,
      has_code: result.content.includes('```'),
      usage: result.usage,
    };
  } catch (err) {
    clearTimeout(timer);
    const duration = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { ...test, model, model_info: modelInfo, duration_ms: duration, success: false, error: msg };
  }
}

async function runLevel(
  label: string, tests: TestCase[], modelsToUse: string[],
) {
  const levelKey = label.toLowerCase().startsWith('level 1') ? 'level1' :
                   label.toLowerCase().startsWith('level 2') ? 'level2' : 'level3';
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(70)}`);

  for (const modelId of modelsToUse) {
    const info = MODELS[modelId];
    console.log(`\n  ▶ ${modelId} (${info.tier} ${info.provider} ${info.family})`);

    const modelTests = tests.filter((_, i) => i % modelsToUse.length === modelsToUse.indexOf(modelId));
    if (modelTests.length === 0) {
      // If no distribution match, take all
      const allForModel = tests.slice(0, Math.ceil(tests.length / modelsToUse.length));
      for (const t of allForModel) {
        await process.stdout.write(`    ${t.id} [${t.cat}]... `);
        const r = await runOneTest(t, modelId, info);
        ALL_RESULTS[levelKey].push(r);
        const icon = r.success ? '✓' : '✗';
        console.log(`${icon} ${r.duration_ms}ms ${r.content_length ?? 0}c`);
        if (!r.success) console.log(`      ERR: ${r.error}`);
        save(`${levelKey}-results.json`, ALL_RESULTS[levelKey]);
        await sleep(1500);
      }
    } else {
      for (const t of modelTests) {
        await process.stdout.write(`    ${t.id} [${t.cat}]... `);
        const r = await runOneTest(t, modelId, info);
        ALL_RESULTS[levelKey].push(r);
        const icon = r.success ? '✓' : '✗';
        console.log(`${icon} ${r.duration_ms}ms ${r.content_length ?? 0}c`);
        if (!r.success) console.log(`      ERR: ${r.error}`);
        save(`${levelKey}-results.json`, ALL_RESULTS[levelKey]);
        await sleep(1500);
      }
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ===== SUMMARY GENERATION =====
function generateSummary() {
  const allFlat = [...ALL_RESULTS.level1, ...ALL_RESULTS.level2, ...ALL_RESULTS.level3];
  const pass = allFlat.filter(r => r.success).length;

  const byModel: Record<string, { tier:string; provider:string; tests:number; passed:number; total_dur:number; total_len:number; len_count:number; errors:string[] }> = {};
  for (const r of allFlat) {
    if (!byModel[r.model]) {
      byModel[r.model] = { tier: r.model_info.tier, provider: r.model_info.provider, tests:0, passed:0, total_dur:0, total_len:0, len_count:0, errors:[] };
    }
    const m = byModel[r.model];
    m.tests++;
    if (r.success) m.passed++;
    m.total_dur += r.duration_ms;
    if (r.content_length) { m.total_len += r.content_length; m.len_count++; }
    if (r.error) m.errors.push(`${r.id}: ${r.error}`);
  }
  const modelSummary: Record<string, unknown> = {};
  for (const [mid, ms] of Object.entries(byModel)) {
    modelSummary[mid] = {
      tier: ms.tier, provider: ms.provider,
      tests: ms.tests, passed: ms.passed, pass_rate: ((ms.passed/ms.tests)*100).toFixed(1)+'%',
      avg_duration_ms: Math.round(ms.total_dur/ms.tests),
      avg_response_chars: ms.len_count>0 ? Math.round(ms.total_len/ms.len_count) : 0,
      errors: ms.errors,
    };
  }

  const byCat: Record<string, { tests:number; passed:number; total_dur:number }> = {};
  for (const r of allFlat) {
    if (!byCat[r.cat]) byCat[r.cat] = { tests:0, passed:0, total_dur:0 };
    byCat[r.cat].tests++;
    if (r.success) byCat[r.cat].passed++;
    byCat[r.cat].total_dur += r.duration_ms;
  }
  const catSummary: Record<string, unknown> = {};
  for (const [cat, cs] of Object.entries(byCat)) {
    catSummary[cat] = { tests:cs.tests, passed:cs.passed, pass_rate:((cs.passed/cs.tests)*100).toFixed(1)+'%', avg_duration_ms:Math.round(cs.total_dur/cs.tests) };
  }

  const summary = {
    generated_at: new Date().toISOString(),
    total_tests: allFlat.length,
    total_passed: pass,
    total_failed: allFlat.length - pass,
    overall_pass_rate: ((pass/allFlat.length)*100).toFixed(1)+'%',
    level1_total: ALL_RESULTS.level1.length,
    level1_passed: ALL_RESULTS.level1.filter(r=>r.success).length,
    level2_total: ALL_RESULTS.level2.length,
    level2_passed: ALL_RESULTS.level2.filter(r=>r.success).length,
    level3_total: ALL_RESULTS.level3.length,
    level3_passed: ALL_RESULTS.level3.filter(r=>r.success).length,
    models: modelSummary,
    by_category: catSummary,
    errors: allFlat.filter(r => !r.success).map(r => ({ id: r.id, model: r.model, cat: r.cat, error: r.error })),
  };
  save('summary.json', summary);
  return summary;
}

// ===== MAIN =====
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   OMNIFORGE AURORA — BENCHMARK & HARDENING SUITE           ║');
  console.log('║   60 tests × multiple models across 3 complexity levels     ║');
  console.log('║   Output: audit-claude-2026-05-24/benchmark-results/        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // LEVEL 1: fast/cheap models for basic prompts
  await runLevel(
    'LEVEL 1 — BASIC (20 tests)',
    LEVEL_1,
    ['gemini-cli/gemini-2.5-flash', 'cc/claude-haiku-4-5-20251001', 'cc/claude-sonnet-4-6', 'cx/gpt-5.3-codex'],
  );

  // LEVEL 2: balanced models for code generation
  await runLevel(
    'LEVEL 2 — INTERMEDIATE (20 tests)',
    LEVEL_2,
    ['cc/claude-sonnet-4-6', 'cc/claude-opus-4-6', 'gemini-cli/gemini-2.5-pro'],
  );

  // LEVEL 3: elite models for architecture
  await runLevel(
    'LEVEL 3 — ADVANCED (20 tests)',
    LEVEL_3,
    ['cc/claude-opus-4-7', 'cx/gpt-5.4', 'gemini-cli/gemini-3.1-pro-preview'],
  );

  const summary = generateSummary();
  save('full-results.json', ALL_RESULTS);

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  BENCHMARK COMPLETE');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total: ${summary.total_tests} tests | ${summary.total_passed} passed | ${summary.total_failed} failed`);
  console.log(`  Pass rate: ${summary.overall_pass_rate}`);
  console.log(`\n  Results saved to: ${OUTPUT_DIR}`);
  console.log(`  Files: summary.json, full-results.json, level*-results.json`);
}

main().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
