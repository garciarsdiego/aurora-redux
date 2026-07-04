// Test Harness - Omniforge Aurora Benchmark
// Executa 60+ testes em 3 níveis de complexidade usando múltiplos modelos
// Salva resultados na pasta audit-claude-2026-05-24

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'audit-claude-2026-05-24', 'benchmark-results');
const DAEMON_PORT = 20129;
const TIMEOUT_MS = 120000;

// Modelos selecionados representando diferentes provedores, tiers e arquiteturas
const MODELS = {
  // S+ Tier - Elite reasoning
  'cc/claude-opus-4-7': { tier: 'S+', provider: 'Anthropic', type: 'opus' },
  'cx/gpt-5.4': { tier: 'S+', provider: 'OpenAI/Cursor', type: 'gpt-5' },
  'gemini-cli/gemini-3.1-pro-preview': { tier: 'S+', provider: 'Google', type: 'gemini-3' },

  // S Tier - High capability
  'cc/claude-opus-4-6': { tier: 'S', provider: 'Anthropic', type: 'opus' },
  'cx/gpt-5.3-codex': { tier: 'S', provider: 'OpenAI/Cursor', type: 'gpt-codex' },

  // S- / A Tier - Balanced
  'cc/claude-sonnet-4-6': { tier: 'S-', provider: 'Anthropic', type: 'sonnet' },
  'cx/gpt-5.2': { tier: 'S-', provider: 'OpenAI/Cursor', type: 'gpt-5' },
  'gemini-cli/gemini-2.5-pro': { tier: 'A', provider: 'Google', type: 'gemini-pro' },

  // B/C Tier - Fast/cheap
  'cc/claude-haiku-4-5-20251001': { tier: 'B+', provider: 'Anthropic', type: 'haiku' },
  'gemini-cli/gemini-2.5-flash': { tier: 'B+', provider: 'Google', type: 'flash' },
};

// === NÍVEL 1 - Básico (20 testes) ===
const LEVEL_1_TESTS = [
  { id: 'L1-01', prompt: 'Explain what dependency injection is in 3 sentences. Be concise.' },
  { id: 'L1-02', prompt: 'Write a regex to validate email addresses. Return only the regex pattern and a brief explanation.' },
  { id: 'L1-03', prompt: 'Convert this Python code to JavaScript: `sorted([x for x in range(100) if x % 7 == 0], reverse=True)[:3]`' },
  { id: 'L1-04', prompt: 'List 5 best practices for writing unit tests. One sentence each.' },
  { id: 'L1-05', prompt: 'What is the difference between process.env and dotenv in Node.js? Brief answer.' },
  { id: 'L1-06', prompt: 'Explain the CAP theorem in 2 sentences.' },
  { id: 'L1-07', prompt: 'Write a SQL query to find the top 3 customers by total order value using a GROUP BY.' },
  { id: 'L1-08', prompt: 'What does "git rebase" do? Explain in one paragraph.' },
  { id: 'L1-09', prompt: 'Generate a TypeScript interface for a User object with: id, name, email, createdAt, roles[].' },
  { id: 'L1-10', prompt: 'What is the difference between Promise.all and Promise.allSettled? One paragraph.' },
  { id: 'L1-11', prompt: 'Write a bash one-liner to count lines of code in all .ts files recursively, excluding node_modules.' },
  { id: 'L1-12', prompt: 'Explain what a JWT is and where the signature comes from. Brief answer.' },
  { id: 'L1-13', prompt: 'Write a CSS media query that targets screens wider than 768px and narrower than 1200px.' },
  { id: 'L1-14', prompt: 'What is the time complexity of quicksort? Explain worst and average case.' },
  { id: 'L1-15', prompt: 'Generate a Dockerfile for a Node.js 22 application using pnpm. Keep it minimal.' },
  { id: 'L1-16', prompt: 'Explain CORS preflight requests in 2 sentences.' },
  { id: 'L1-17', prompt: 'Write a Python one-liner using list comprehension to create a dictionary of squares for numbers 1-10.' },
  { id: 'L1-18', prompt: 'What is the difference between TCP and UDP? One sentence for each.' },
  { id: 'L1-19', prompt: 'Write a git command to show all commits by author "Example" in the last 7 days.' },
  { id: 'L1-20', prompt: 'Explain what a race condition is in concurrent programming. Brief answer.' },
];

// === NÍVEL 2 - Intermediário (20 testes) ===
const LEVEL_2_TESTS = [
  { id: 'L2-01', prompt: 'Write a TypeScript function that implements a retry mechanism with exponential backoff. Include JSDoc, error handling, and AbortSignal support. Return the complete function.' },
  { id: 'L2-02', prompt: 'Design a simple rate limiter using the token bucket algorithm in TypeScript. Include the class definition with constructor, tryConsume, and refill methods. Make it thread-safe with no external dependencies.' },
  { id: 'L2-03', prompt: 'Write a SQL migration that adds a `metadata` JSONB column to a `workflows` table, creates a GIN index on it, and backfills existing rows with empty objects. PostgreSQL syntax.' },
  { id: 'L2-04', prompt: 'Create a React custom hook `useDebounce<T>(value: T, delay: number): T` in TypeScript. Include cleanup on unmount.' },
  { id: 'L2-05', prompt: 'Write a Node.js middleware that validates JWT tokens from Authorization headers, extracts claims, and attaches them to the request. TypeScript, no frameworks.' },
  { id: 'L2-06', prompt: 'Implement a Least Recently Used (LRU) cache in TypeScript with get, set, and size methods. O(1) operations required. Use a Map internally.' },
  { id: 'L2-07', prompt: 'Design a simple event emitter pattern in TypeScript with typed events. Include on(), off(), once(), and emit() methods. The emit should be type-safe.' },
  { id: 'L2-08', prompt: 'Write a Zod schema for a workflow configuration object with: name (string), tasks (array of Task objects each with id, kind, model?, timeout_ms?), and optional metadata (record).' },
  { id: 'L2-09', prompt: 'Create a function that reads a directory recursively, filters files by extension, and returns a flat array of absolute paths. TypeScript, async, with error handling for permission denied.' },
  { id: 'L2-10', prompt: 'Design a simple pub/sub system in TypeScript with typed channels. Include: publish(channel, payload), subscribe(channel, handler), unsubscribe(channel, id). No external deps.' },
  { id: 'L2-11', prompt: 'Write a PostgreSQL query using window functions to rank tasks by duration within each workflow, showing only the top 2 longest tasks per workflow.' },
  { id: 'L2-12', prompt: 'Implement a circular buffer (ring buffer) class in TypeScript with push, pop, peek, and isFull methods. Fixed size, generic type.' },
  { id: 'L2-13', prompt: 'Write a function that safely parses a JSON string and returns a typed result or a specific error type. Use Result/Option pattern (no throwing). TypeScript.' },
  { id: 'L2-14', prompt: 'Design a simple state machine in TypeScript with states, transitions, and guards. Implement a traffic light controller (red -> green -> yellow -> red) as an example.' },
  { id: 'L2-15', prompt: 'Create a Zod schema that validates a DAG definition: nodes (array with id, kind, model), edges (array with from, to), and optional metadata. Include refinement for cycle detection description.' },
  { id: 'L2-16', prompt: 'Write a function that merges two sorted arrays of numbers in O(n+m) time. TypeScript, no built-in sort.' },
  { id: 'L2-17', prompt: 'Implement a simple template engine that replaces {{variable}} placeholders with values from a context object. Support nested paths like {{user.name}}. TypeScript, no external deps.' },
  { id: 'L2-18', prompt: 'Design a connection pool for database connections in TypeScript. Include: acquire(), release(), drain(). Max connections configurable. Async.' },
  { id: 'L2-19', prompt: 'Write a function that deeply clones an object, handling Date, RegExp, Map, Set, and circular references. TypeScript.' },
  { id: 'L2-20', prompt: 'Implement a task scheduler that runs async tasks with a concurrency limit. Accept an array of tasks and maxConcurrency. Return results in order. TypeScript.' },
];

// === NÍVEL 3 - Avançado (20 testes) ===
const LEVEL_3_TESTS = [
  { id: 'L3-01', prompt: 'Design the architecture for a multi-tenant SaaS application. Consider: database isolation strategies, authentication, rate limiting, tenant-aware logging, and deployment. Provide a structured document with diagrams described in text.' },
  { id: 'L3-02', prompt: 'Create a comprehensive threat model for a REST API that handles user financial data. Identify attack vectors (OWASP Top 10), propose mitigations, and prioritize by risk. Structured output.' },
  { id: 'L3-03', prompt: 'Design a distributed task queue system inspired by Celery but simpler. Include: producer API, worker pool, task routing, retry policies, dead letter queues, and observability. Provide a design document with TypeScript interfaces.' },
  { id: 'L3-04', prompt: 'Specify a protocol for AI agent-to-agent communication. Define message format, routing, security (HMAC + encryption), streaming support, and capability discovery. TypeScript types included.' },
  { id: 'L3-05', prompt: 'Design a cross-platform file synchronization system. Handle conflict resolution strategies (last-write-wins, CRDT, three-way merge), partial sync, and bandwidth optimization. Architecture document.' },
  { id: 'L3-06', prompt: 'Create a specification for a vector database query planner that optimizes hybrid search (semantic + keyword + metadata filters). Include cost estimation, index selection, and query rewriting. Technical design.' },
  { id: 'L3-07', prompt: 'Design the decomposition algorithm for breaking natural language objectives into DAGs. Describe: input preprocessing, heuristic application (granularity, fanout, critical path), output validation, and the feedback loop. Detailed technical spec.' },
  { id: 'L3-08', prompt: 'Analyze the security implications of running LLM-generated code in a sandbox. Design a 3-layer defense: isolation (vm/container), capability restriction (no network, fs limits), and output validation. Provide concrete implementation strategies.' },
  { id: 'L3-09', prompt: 'Design an evaluation framework for LLM outputs that measures: factual accuracy, instruction following, code correctness, and safety. Include judge model selection, metric aggregation, and confidence calibration. Technical specification.' },
  { id: 'L3-10', prompt: 'Design a federated GraphQL gateway that stitches multiple microservices. Handle: schema composition, query planning, N+1 prevention (DataLoader), authentication propagation, and caching. Architecture document with TypeScript stubs.' },
  { id: 'L3-11', prompt: 'Create a specification for a real-time collaborative text editor using CRDTs (Conflict-free Replicated Data Types). Cover: data structure (RGA or similar), operation transformation, cursor presence, and offline support. Technical design.' },
  { id: 'L3-12', prompt: 'Design a zero-downtime database migration system for a production PostgreSQL cluster. Handle: schema changes, data backfills, rollback strategies, lock management, and multi-step migrations. Detailed implementation plan.' },
  { id: 'L3-13', prompt: 'Design a comprehensive observability pipeline: structured logging (pino), distributed tracing (OpenTelemetry), metrics (Prometheus), and alerting. Include: sampling strategies, cardinality management, correlation IDs, and cost optimization. Architecture document.' },
  { id: 'L3-14', prompt: 'Design a plugin system architecture that supports: hot-reloading, sandboxed execution, version compatibility checking, dependency resolution between plugins, and lifecycle hooks. TypeScript-first design with concrete interfaces.' },
  { id: 'L3-15', prompt: 'Analyze how to implement GDPR "right to be forgotten" in a system with: relational data, event-sourced aggregates, search indexes, backups, and third-party integrations. Provide: data flow diagram (text), deletion strategies per storage type, and compliance timeline.' },
  { id: 'L3-16', prompt: 'Design a financial ledger system using double-entry accounting principles. Include: immutable transaction log, balance computation, reconciliation, and audit trail. PostgreSQL schema with TypeScript domain model.' },
  { id: 'L3-17', prompt: 'Create a specification for a content moderation pipeline that uses: pre-filtering (regex/heuristics), ML classification, human review queue, and appeal process. Include SLA targets and false positive/negative trade-offs. Technical design.' },
  { id: 'L3-18', prompt: 'Design a build and deployment pipeline for a monorepo with 15 packages, handling: dependency graph computation, parallel builds, cache invalidation (Nx-style), canary deployments, and rollback. CI/CD architecture document.' },
  { id: 'L3-19', prompt: 'Design the data model and access patterns for a social network feed system. Consider: fan-out on write vs read, timeline generation, ranking (ML), caching strategy (Redis), and pagination (cursor-based). Detailed technical specification.' },
  { id: 'L3-20', prompt: 'Compare and contrast three architectural patterns for AI agent orchestration: (1) static DAG, (2) dynamic supervisor-agent, (3) swarm/consensus. Analyze: failure modes, cost profiles, latency characteristics, and quality tradeoffs. Provide decision matrix.' },
];

function log(msg) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCliTest(testId, objective, model) {
  const start = Date.now();
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DECOMPOSER_MODEL: model,
      TASK_MODEL: model,
      REVIEWER_MODEL: model,
    };

    try {
      const result = execSync(
        `node bin/omniforge run --workspace internal --auto-approve --no-pattern "${objective.replace(/"/g, '\\"')}"`,
        { env, timeout: TIMEOUT_MS, encoding: 'utf8', stdio: 'pipe' }
      );
      const duration = Date.now() - start;
      resolve({ id: testId, model, success: true, duration, output: result.slice(0, 500), error: null });
    } catch (e) {
      const duration = Date.now() - start;
      const output = e.stdout?.toString()?.slice(0, 500) || '';
      const stderr = e.stderr?.toString()?.slice(0, 500) || '';
      resolve({ id: testId, model, success: false, duration, output: output + stderr, error: e.message?.slice(0, 300) });
    }
  });
}

async function runViaDaemonLLM(prompt, model) {
  return new Promise((resolve) => {
    const token = fs.readFileSync('data/daemon-token.txt', 'utf8').trim();
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      temperature: 0.2,
    });

    const req = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT,
      path: `/stream/llm?token=${token}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ success: true, content: json.content || json.choices?.[0]?.message?.content, model: json.model, raw: json });
        } catch {
          resolve({ success: false, content: null, error: `HTTP ${res.statusCode}: ${data.slice(0, 200)}` });
        }
      });
    });
    req.on('error', e => resolve({ success: false, content: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, content: null, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

async function runAdvisorTest(advisorName, step, model) {
  const token = fs.readFileSync('data/daemon-token.txt', 'utf8').trim();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {
      name: `omniforge_${advisorName}`,
      arguments: {
        step,
        step_number: 1,
        total_steps: 1,
        workspace: 'internal',
      },
    },
    id: Date.now(),
  });

  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: DAEMON_PORT,
      path: `/mcp/messages?token=${token}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: `Failed to parse: ${data.slice(0, 300)}` }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.write(body);
    req.end();
  });
}

function saveResults(fileName, data) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, fileName), JSON.stringify(data, null, 2));
}

// === MAIN TEST ORCHESTRATOR ===
async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  OMNIFORGE AURORA - BENCHMARK & HARDENING TEST SUITE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log(`  Models: ${Object.keys(MODELS).length}`);
  console.log(`  Total tests: ${LEVEL_1_TESTS.length + LEVEL_2_TESTS.length + LEVEL_3_TESTS.length} × ${Object.keys(MODELS).length} models`);
  console.log('═══════════════════════════════════════════════════════\n');

  const allResults = { level1: [], level2: [], level3: [], summary: {}, errors: [] };
  const startAll = Date.now();

  // Selecionar subset de modelos por nível (para viabilizar tempo)
  const level1Models = Object.keys(MODELS).slice(0, 5); // 5 modelos x 4 testes cada = 20
  const level2Models = Object.keys(MODELS).slice(0, 4); // 4 modelos x 5 testes = 20
  const level3Models = Object.keys(MODELS).slice(0, 3); // 3 modelos x 7 testes = 21

  log(`LEVEL 1 - BASIC (${LEVEL_1_TESTS.length} tests × ${level1Models.length} models)`);
  log('Using CLI `omniforge run` with model override\n');

  // Only run subset for time efficiency - 4 tests per model = 20 total
  const l1TestsSlice = LEVEL_1_TESTS;
  for (let mi = 0; mi < level1Models.length; mi++) {
    const model = level1Models[mi];
    const modelTests = l1TestsSlice.slice(mi * 4, (mi + 1) * 4);
    log(`  Testing with ${model} (${modelTests.length} prompts)...`);
    for (const test of modelTests) {
      log(`    ${test.id}: ${test.prompt.slice(0, 60)}...`);
      const result = await runCliTest(test.id, test.prompt, model);
      result.model_info = MODELS[model];
      allResults.level1.push(result);
      log(`      → ${result.success ? 'PASS' : 'FAIL'} (${result.duration}ms)`);
      if (result.error) log(`        Error: ${result.error}`);
      saveResults('level1-results.json', allResults.level1);
      await sleep(2000); // Rate limit entre chamadas
    }
  }

  log('\nLEVEL 2 - INTERMEDIATE');
  log(`Using Daemon LLM stream endpoint\n`);

  const l2TestsSlice = LEVEL_2_TESTS;
  for (let mi = 0; mi < level2Models.length; mi++) {
    const model = level2Models[mi];
    const modelTests = l2TestsSlice.slice(mi * 5, (mi + 1) * 5);
    log(`  Testing with ${model} (${modelTests.length} prompts)...`);
    for (const test of modelTests) {
      log(`    ${test.id}: ${test.prompt.slice(0, 60)}...`);
      const start = Date.now();
      const result = await runViaDaemonLLM(test.prompt, model);
      result.id = test.id;
      result.model = model;
      result.model_info = MODELS[model];
      result.duration = Date.now() - start;
      // Quick quality check
      if (result.content) {
        result.content_length = result.content.length;
        result.has_code_block = result.content.includes('```');
        result.word_count = result.content.split(/\s+/).length;
      }
      allResults.level2.push(result);
      log(`      → ${result.success ? 'OK' : 'FAIL'} (${result.duration}ms, ${result.content_length || 0} chars)`);
      if (result.error) log(`        Error: ${result.error}`);
      saveResults('level2-results.json', allResults.level2);
      await sleep(1500);
    }
  }

  log('\nLEVEL 3 - ADVANCED');
  log(`Using Advisor tools via MCP\n`);

  // Mix of advisor types per model
  const advisorTypes = ['secaudit', 'codereview', 'thinkdeep', 'planner', 'consensus'];
  for (let mi = 0; mi < level3Models.length; mi++) {
    const model = level3Models[mi];
    log(`  Testing advisors with ${model}...`);
    const advisorSubset = advisorTypes.slice(mi * 2 > advisorTypes.length ? 0 : mi, mi + 2).filter(Boolean);
    if (advisorSubset.length === 0) advisorSubset.push('analyze');

    for (const advisor of advisorSubset) {
      const testPrompt = LEVEL_3_TESTS[mi * 3 + advisorSubset.indexOf(advisor)]?.prompt || LEVEL_3_TESTS[0].prompt;
      log(`    Advisor: ${advisor} - ${(testPrompt || '').slice(0, 60)}...`);
      const start = Date.now();
      const result = await runAdvisorTest(advisor, testPrompt, model);
      result.id = `L3-${mi}-${advisor}`;
      result.advisor = advisor;
      result.model = model;
      result.model_info = MODELS[model];
      result.duration = Date.now() - start;
      allResults.level3.push(result);
      const hasContent = result.content || result.result?.content?.[0]?.text;
      log(`      → ${hasContent ? 'OK' : 'CHECK'} (${result.duration}ms)`);
      if (result.error) log(`        Error: ${JSON.stringify(result.error).slice(0, 200)}`);
      saveResults('level3-results.json', allResults.level3);
      await sleep(3000); // Advisors need more time
    }
  }

  // Generate summary
  const totalDuration = Date.now() - startAll;
  const l1Pass = allResults.level1.filter(r => r.success).length;
  const l2Pass = allResults.level2.filter(r => r.success && r.content).length;
  const l3Pass = allResults.level3.filter(r => !r.error).length;

  allResults.summary = {
    total_duration_sec: Math.round(totalDuration / 1000),
    level1: { total: allResults.level1.length, passed: l1Pass, failed: allResults.level1.length - l1Pass },
    level2: { total: allResults.level2.length, passed: l2Pass, failed: allResults.level2.length - l2Pass },
    level3: { total: allResults.level3.length, passed: l3Pass, failed: allResults.level3.length - l3Pass },
    models_tested: [...new Set([
      ...allResults.level1.map(r => r.model),
      ...allResults.level2.map(r => r.model),
      ...allResults.level3.map(r => r.model),
    ])],
  };

  // Per-model stats
  const modelStats = {};
  for (const r of [...allResults.level1, ...allResults.level2, ...allResults.level3]) {
    if (!r.model) continue;
    if (!modelStats[r.model]) modelStats[r.model] = { tests: 0, passed: 0, total_duration: 0, avg_content_length: 0, counts: 0 };
    const ms = modelStats[r.model];
    ms.tests++;
    if (r.success || (r.content && !r.error)) ms.passed++;
    ms.total_duration += r.duration || 0;
    if (r.content_length) { ms.avg_content_length += r.content_length; ms.counts++; }
  }
  for (const [m, s] of Object.entries(modelStats)) {
    s.avg_duration_ms = Math.round(s.total_duration / s.tests);
    s.avg_content_length = s.counts > 0 ? Math.round(s.avg_content_length / s.counts) : 0;
    s.pass_rate = ((s.passed / s.tests) * 100).toFixed(1) + '%';
  }
  allResults.summary.model_stats = modelStats;

  saveResults('summary.json', allResults.summary);
  saveResults('full-results.json', allResults);

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  BENCHMARK COMPLETE');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Duration: ${allResults.summary.total_duration_sec}s`);
  console.log(`  Level 1: ${l1Pass}/${allResults.level1.length} passed`);
  console.log(`  Level 2: ${l2Pass}/${allResults.level2.length} passed`);
  console.log(`  Level 3: ${l3Pass}/${allResults.level3.length} passed`);
  console.log('═══════════════════════════════════════════════════════\n');
  console.log('Results saved to:', OUTPUT_DIR);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
