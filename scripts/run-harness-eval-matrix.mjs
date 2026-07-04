#!/usr/bin/env node
// Harness eval matrix runner. Reads the 50-task matrix embedded below,
// executes each task end-to-end, captures per-task results, writes a JSON
// summary + traces.
//
// USAGE
//   node scripts/run-harness-eval-matrix.mjs --id T1-FACT-001          # single task
//   node scripts/run-harness-eval-matrix.mjs --tier T1                 # all of one tier
//   node scripts/run-harness-eval-matrix.mjs --domain CONTENT          # all of one domain
//   node scripts/run-harness-eval-matrix.mjs --all                     # full matrix
//   node scripts/run-harness-eval-matrix.mjs --all --resume            # skip already-completed
//   node scripts/run-harness-eval-matrix.mjs --dry-run                 # print plan only
//   node scripts/run-harness-eval-matrix.mjs --id T1-FACT-001 --repeat 3  # run same task 3x
//
// OUTPUT: data/harness-eval/<runId>/{summary.json,traces/}

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const repoRoot = pathResolve(__dirname, '..');

// ── Matrix (compact — full per-task documentation in docs/HARNESS-EVAL-MATRIX.md)
const MATRIX = [
  // T1 Trivial
  { id: 'T1-FACT-001', tier: 'T1', domain: 'FACT', mix: { decomposer: 'cx/gpt-5.5', task: 'cx/gpt-5.5', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Print 'Final answer: <year>' where <year> is when JavaScript was invented" },
  { id: 'T1-FACT-002', tier: 'T1', domain: 'FACT', mix: { decomposer: 'cc/claude-haiku-4-5-20251001', task: 'cc/claude-haiku-4-5-20251001', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Compute (517 * 43 + 88) and print as 'Value: <number>'" },
  { id: 'T1-FACT-003', tier: 'T1', domain: 'FACT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'kmc/kimi-k2.6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "List the 5 largest planets in the solar system by mass, one per line" },
  { id: 'T1-FACT-004', tier: 'T1', domain: 'FACT', mix: { decomposer: 'cx/gpt-5.5', task: 'cx/gpt-5.5', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "What date was 137 days before 2026-05-22? Print as YYYY-MM-DD" },
  { id: 'T1-FORMAT-005', tier: 'T1', domain: 'FORMAT', mix: { decomposer: 'cc/claude-haiku-4-5-20251001', task: 'cc/claude-haiku-4-5-20251001', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Convert 'John Doe, 35, NYC' into JSON {name, age, city}" },
  { id: 'T1-EXTRACT-006', tier: 'T1', domain: 'EXTRACT', mix: { decomposer: 'cx/gpt-5.5', task: 'cx/gpt-5.5', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "From: 'The meeting is at 3pm on Tuesday at the conference room.', extract {time, day, location} as JSON" },
  { id: 'T1-CLASSIFY-007', tier: 'T1', domain: 'CLASSIFY', mix: { decomposer: 'cc/claude-haiku-4-5-20251001', task: 'cc/claude-haiku-4-5-20251001', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Classify 'This product changed my life!' as positive/negative/neutral. Print one word" },
  { id: 'T1-RANK-008', tier: 'T1', domain: 'RANK', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cerebras/gpt-oss-120b', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Rank these by speed: bicycle, walking, jet plane, car. Output ordered list" },
  { id: 'T1-COMPARE-009', tier: 'T1', domain: 'COMPARE', mix: { decomposer: 'cx/gpt-5.5', task: 'cx/gpt-5.5', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Which has more sugar per 100g: an apple or a banana? Print 1-sentence answer with the number" },
  { id: 'T1-COMPUTE-010', tier: 'T1', domain: 'COMPUTE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "A car drives at 80 km/h for 2.5 hours, then 60 km/h for 1.5 hours. Print total km traveled" },
  // T2 Routine
  { id: 'T2-COMPARE-001', tier: 'T2', domain: 'COMPARE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Compare pnpm vs npm for a TypeScript monorepo. Output 1 paragraph with 3 concrete tradeoffs" },
  { id: 'T2-COMPARE-002', tier: 'T2', domain: 'COMPARE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Compare Vitest, Jest, and Mocha for a TypeScript project. One-paragraph recommendation" },
  { id: 'T2-CONTENT-003', tier: 'T2', domain: 'CONTENT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Write a 400-word LinkedIn post explaining DSPy to a non-technical product manager" },
  { id: 'T2-CONTENT-004', tier: 'T2', domain: 'CONTENT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cx/gpt-5.5', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Outline a 5-step tutorial for 'Set up a TypeScript project with strict mode'" },
  { id: 'T2-RESEARCH-005', tier: 'T2', domain: 'RESEARCH', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-opus-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Summarize the key features added in TypeScript 5.4 (2024) in 5 bullet points" },
  { id: 'T2-DIGEST-006', tier: 'T2', domain: 'DIGEST', mix: { decomposer: 'cx/gpt-5.5', task: 'cx/gpt-5.5', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Given 3 user reviews about a coffee maker: (1) 'Great taste, slow brewing.' (2) 'Loud but reliable.' (3) 'Hard to clean, otherwise perfect.' — distill the top 3 themes" },
  { id: 'T2-CLASSIFY-007', tier: 'T2', domain: 'CLASSIFY', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'kmc/kimi-k2.6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Classify each of these 5 support tickets into one of: billing, technical, feature_request, other. Output JSON array. Tickets: (1) I was charged twice. (2) Dark mode would be nice. (3) App crashes on launch. (4) How do I export my data? (5) Refund please." },
  { id: 'T2-PLAN-008', tier: 'T2', domain: 'PLAN', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Sketch a 1-week sprint plan for adding dark mode to an existing React app" },
  { id: 'T2-TRANSLATE-009', tier: 'T2', domain: 'TRANSLATE', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-opus-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Translate this technical incident summary into board-friendly language: 'Production DB primary failover triggered at 14:32 UTC due to NVMe controller failure. Read replica promoted in 47s. No data loss.' Add a leading dollar impact estimate." },
  { id: 'T2-FAQ-010', tier: 'T2', domain: 'FAQ', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cerebras/gpt-oss-120b', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Generate a 5-question FAQ about Docker volumes for new developers" },
  // T3 Workday
  { id: 'T3-MARKETING-001', tier: 'T3', domain: 'MARKETING', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Audit a Google Ads account for AcmeCo, 30-day window. Surface waste opportunities. Recommend top 3 actions ranked by dollar impact" },
  { id: 'T3-CONTENT-002', tier: 'T3', domain: 'CONTENT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Draft a 1500-word LinkedIn post on 'why eval-driven development matters for AI agents' for senior engineers" },
  { id: 'T3-PROJECT-003', tier: 'T3', domain: 'PROJECT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Summarize the last 7 days of activity on the Omniforge project for the founder" },
  { id: 'T3-COMPARATIVE-004', tier: 'T3', domain: 'COMPARATIVE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Compare these 3 hypothetical landing pages on conversion fundamentals: (A) 'AI Agents Made Simple' + 'Start Free Trial' (B) 'The Last AI Tool You Need' + 'Book a Demo' (C) 'Build Better Agents Faster' + 'Get Early Access'. Score each on 5 fundamentals" },
  { id: 'T3-DEBUG-005', tier: 'T3', domain: 'DEBUG', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "A workflow task fails 'output is valid json' acceptance criteria because the LLM returned text inside markdown fences. List 3 root causes + a fix for each" },
  { id: 'T3-RESEARCH-006', tier: 'T3', domain: 'RESEARCH', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Compare LangGraph, CrewAI, and AutoGen as agentic frameworks. Output a comparison table + 1-paragraph recommendation per use case (solo dev, enterprise team, research lab)" },
  { id: 'T3-CODE-007', tier: 'T3', domain: 'CODE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Read the file src/patterns/shape.ts via cli_spawn:cli:claude-code and propose 3 concrete refactors with code diffs" },
  { id: 'T3-EVAL-008', tier: 'T3', domain: 'EVAL', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-opus-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Spec a hypothetical 'user profile editor' feature with 5 fields. Write a 10-case test plan covering happy paths + edge cases" },
  { id: 'T3-COMM-009', tier: 'T3', domain: 'COMM', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Given incident: 'Auth service was down 12 min on 2026-05-20 due to expired TLS cert; impact ~3% of logins.' Produce: (1) board email (2) Slack message for #incidents (3) engineering retro doc" },
  { id: 'T3-AUDIT-010', tier: 'T3', domain: 'AUDIT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'kmc/kimi-k2.6', reviewer: 'ds/deepseek-v4-flash' }, objective: "Audit these 5 npm packages for license type and flag any AGPL/GPL contamination: react, vue, lodash, mongodb, ffmpeg-static" },
  // T4 Complex
  { id: 'T4-CODE-001', tier: 'T4', domain: 'CODE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Add a new module src/v2/utils/jitter.ts with withJitter(ms, fraction) returning ms ± (ms × fraction × random). Add 3 unit tests in tests/unit/jitter.test.ts. Tests must pass." },
  { id: 'T4-CODE-002', tier: 'T4', domain: 'CODE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Add migration 056_notes.sql with a notes table (id, workspace, content, created_at). Add insertNote() + listNotes() in src/db/persist.ts. Add 1 integration test." },
  { id: 'T4-CODE-003', tier: 'T4', domain: 'CODE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Bug F-LIVE-5: reviewer issues hard_failure when file-read returns identical content to a recent file-write upstream. Propose a fix that soft-fails (refines) instead. Write the diff and a regression test." },
  { id: 'T4-DATA-004', tier: 'T4', domain: 'DATA', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cx/gpt-5.5', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Write a ~100-LOC Node script that reads a CSV (sample header: name,age,city), filters by age >= 30 AND city != 'LA', writes the result as JSON to out.json. Include 3 unit tests." },
  { id: 'T4-API-005', tier: 'T4', domain: 'API', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Generate a TypeScript fetch wrapper for a REST API with GET /v1/users/:id and POST /v1/users {name,email}. Include exponential backoff retries, typed responses, 5 unit tests" },
  { id: 'T4-DESIGN-006', tier: 'T4', domain: 'DESIGN', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Decide between WebSockets and SSE for real-time updates from a daemon to a React app (single-user, single-machine). Produce a decision doc + a 1-day spike implementation plan" },
  { id: 'T4-CONTENT-007', tier: 'T4', domain: 'CONTENT', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-opus-4-6', reviewer: 'cc/claude-sonnet-4-6' }, objective: "Draft a 3000-word technical whitepaper titled 'Why Local-First AI Agents Win for Solo Operators'. Sections: intro, why local-first, three case studies, conclusion. Include 5 citations." },
  { id: 'T4-AUDIT-008', tier: 'T4', domain: 'AUDIT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Audit 3 hypothetical Google Ads accounts in parallel: AcmeCo, BlueWidget, RetroShop. Each with 30-day window. Produce per-account briefs (3) + cross-account pattern brief" },
  { id: 'T4-RESEARCH-009', tier: 'T4', domain: 'RESEARCH', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Research TypeScript reactivity libraries: TC39 Signals, Vue refs, Solid signals, Preact signals. Produce a 2000-word comparative brief with code examples for each" },
  { id: 'T4-EVAL-010', tier: 'T4', domain: 'EVAL', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Design an A/B experiment for 3-step vs 5-step onboarding. Output hypothesis, sample size (5% MDE, 80% power), success metrics, timeline" },
  // T5 Expert
  { id: 'T5-CODE-001', tier: 'T5', domain: 'CODE', mix: { decomposer: 'cc/claude-opus-4-7', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-sonnet-4-6' }, objective: "Refactor src/brain/decomposer.ts to extract EXAMPLE A through K into src/brain/decomposer-examples.ts. Update imports. Tests must still pass." },
  { id: 'T5-MULTIMODEL-002', tier: 'T5', domain: 'MULTIMODEL', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Have 5 models each answer in parallel: 'For a solo developer building a CLI agent orchestrator, what is the single highest-leverage feature to ship next?' Models: cc/claude-sonnet-4-6, cx/gpt-5.5, gemini-cli/gemini-3.1-pro-preview, kmc/kimi-k2.6, ds/deepseek-v4-flash. Then synthesize consensus + dissent." },
  { id: 'T5-AGENT-003', tier: 'T5', domain: 'AGENT', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Spec a new 'secaudit-mini' advisor for solo-dev contexts. Include: system prompt, 5-case golden eval suite, expected output format" },
  { id: 'T5-LONG-004', tier: 'T5', domain: 'LONG', mix: { decomposer: 'cc/claude-opus-4-7', task: 'cc/claude-opus-4-6', reviewer: 'cc/claude-sonnet-4-6' }, objective: "Spec the 'Workflow Templates' feature (save successful workflows as parameterized templates with slot detection, version locking, cross-workspace sharing). Produce a 12-week phased rollout plan with risks, mitigations, success metrics, weekly milestones" },
  { id: 'T5-DEBATE-005', tier: 'T5', domain: 'DEBATE', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Run a 3-round debate between cc/claude-sonnet-4-6, cx/gpt-5.5, and kmc/kimi-k2.6 on 'Should solo developers default to monorepos?'. Then cc/claude-opus-4-6 synthesizes strongest arguments + states a final position" },
  { id: 'T5-AUDIT-006', tier: 'T5', domain: 'AUDIT', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Security audit src/utils/omniroute-call.ts for OWASP Top 10 vulnerabilities. Produce: per-vulnerability finding with severity, refutation pass (one model challenges the auditor), final consensus risk score" },
  { id: 'T5-DATA-007', tier: 'T5', domain: 'DATA', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "v1 public API spec: GET /users (returns array), POST /users (creates one). Design a backward-compatible v2 that adds: pagination on GET, validation on POST, soft-delete. Include: v2 spec, compatibility shim, 6-month deprecation timeline, migration playbook" },
  { id: 'T5-CONTENT-008', tier: 'T5', domain: 'CONTENT', mix: { decomposer: 'cc/claude-sonnet-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cc/claude-haiku-4-5-20251001' }, objective: "Brief: 'Omniforge v0.4 just shipped, adding reflection-based learning and pattern auto-capture.' Produce 5 outputs: (1) 800-word blog (2) 5-tweet thread (3) 200-word LinkedIn post (4) 3 email subject variations (5) Slack #announcements message" },
  { id: 'T5-RESEARCH-009', tier: 'T5', domain: 'RESEARCH', mix: { decomposer: 'cc/claude-opus-4-6', task: 'cc/claude-sonnet-4-6', reviewer: 'cx/gpt-5.5' }, objective: "Research the agentic AI framework landscape. Score each of LangGraph, CrewAI, AutoGen, Mastra, n8n, OpenHands, Dify on 7 dimensions (DX, observability, multi-agent, cost, OSS health, docs, ecosystem). Output: comparative matrix + 3 strategic recommendations for a solo operator." },
  { id: 'T5-META-010', tier: 'T5', domain: 'META', mix: { decomposer: 'cc/claude-opus-4-7', task: 'cc/claude-opus-4-7', reviewer: 'cc/claude-sonnet-4-6' }, objective: "Read docs/LIVE-OMNIROUTE-TEST-2026-05-22.md and docs/HARNESS-EVAL-MATRIX.md. Propose 5 concrete improvements to the decomposer system prompt (src/brain/decomposer.ts), ranked by expected pass-rate uplift on T1-T3 cases. For each, include rationale + diff snippet" },
];

// ── Secret scrubbing ────────────────────────────────────────────────────────
// Applied to stderrTail / stdoutTail before writing trace JSON so API keys
// that leak into child process output are never persisted to disk.
const SECRET_PATTERNS = [
  { re: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED-API-KEY]' },
  { re: /Bearer\s+[A-Za-z0-9_.+/=-]+/g, replacement: 'Bearer [REDACTED]' },
];

function scrubSecrets(str) {
  let out = str;
  for (const { re, replacement } of SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = argv;
  const opts = { id: null, tier: null, domain: null, all: false, resume: false, dryRun: false, repeat: 1 };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--id') opts.id = args[++i];
    else if (a === '--tier') opts.tier = args[++i];
    else if (a === '--domain') opts.domain = args[++i];
    else if (a === '--all') opts.all = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--repeat') {
      const n = parseInt(args[++i], 10);
      if (Number.isNaN(n) || n < 1) { console.error('--repeat must be a positive integer'); process.exit(2); }
      opts.repeat = n;
    }
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(__filename, 'utf8').split('\n').slice(0, 19).join('\n'));
      process.exit(0);
    }
  }
  return opts;
}

function filterTasks(opts) {
  let tasks = MATRIX;
  if (opts.id) tasks = tasks.filter((t) => t.id === opts.id);
  if (opts.tier) tasks = tasks.filter((t) => t.tier === opts.tier);
  if (opts.domain) tasks = tasks.filter((t) => t.domain === opts.domain);
  if (!opts.id && !opts.tier && !opts.domain && !opts.all) {
    console.error('No filter provided. Use --id / --tier / --domain / --all. See --help.');
    process.exit(2);
  }
  return tasks;
}

// repeatIndex is 1-based; when repeat=1 the trace filename is unchanged (no suffix).
function runOne(task, runDir, repeatIndex = 1, repeatTotal = 1) {
  return new Promise((resolveTask) => {
    const start = Date.now();
    const resultId = repeatTotal > 1 ? `${task.id}#${repeatIndex}` : task.id;
    const env = {
      ...process.env,
      DECOMPOSER_MODEL: task.mix.decomposer,
      TASK_MODEL: task.mix.task,
      REVIEWER_MODEL: task.mix.reviewer,
      CONSOLIDATOR_MODEL: task.mix.task,
      OMNIFORGE_USE_PERSONAS: 'false',
      DISABLE_FINAL_VALIDATION: 'true',
    };
    const args = ['bin/omniforge', 'run', task.objective, '--workspace', 'internal', '--auto-approve'];
    const child = spawn('node', args, { cwd: repoRoot, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, 600_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - start;
      const completed = code === 0 && /Workflow concluído|Workflow completed/.test(stdout);
      const wfMatch = stdout.match(/ID:\s+(wf_[A-Za-z0-9_-]+)/);
      const result = {
        id: resultId, taskId: task.id, repeatIndex, tier: task.tier, domain: task.domain,
        objective: task.objective, mix: task.mix,
        status: completed ? 'completed' : 'failed',
        durationMs: duration,
        wfId: wfMatch ? wfMatch[1] : null,
        exitCode: code,
        stderrTail: scrubSecrets(stderr.slice(-500)),
        stdoutTail: scrubSecrets(stdout.slice(-800)),
      };
      const file = join(runDir, 'traces', `${resultId}.json`);
      writeFileSync(file, JSON.stringify(result, null, 2));
      console.log(`  ${result.status === 'completed' ? '✓' : '✗'} ${resultId.padEnd(24)} ${task.tier} | ${Math.round(duration / 1000)}s | wf=${result.wfId ? result.wfId.slice(0, 16) : '-'}`);
      resolveTask(result);
    });
  });
}

async function main() {
  const opts = parseArgs();
  const tasks = filterTasks(opts);
  const runId = `harness-eval-${Date.now()}`;
  const runDir = join(repoRoot, 'data', 'harness-eval', runId);
  if (!opts.dryRun) mkdirSync(join(runDir, 'traces'), { recursive: true });
  console.log(`\n[harness-eval] runId=${runId}  tasks=${tasks.length}  outDir=${runDir}\n`);
  if (opts.dryRun) {
    for (const t of tasks) {
      for (let rep = 1; rep <= opts.repeat; rep += 1) {
        const label = opts.repeat > 1 ? `${t.id}#${rep}` : t.id;
        console.log(`  DRY  ${label.padEnd(24)} ${t.tier} | ${t.mix.decomposer} / ${t.mix.task} / ${t.mix.reviewer}`);
      }
    }
    return;
  }
  const results = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= opts.repeat; rep += 1) {
      const resultId = opts.repeat > 1 ? `${task.id}#${rep}` : task.id;
      const tracePath = join(runDir, 'traces', `${resultId}.json`);
      if (opts.resume && existsSync(tracePath)) {
        const prev = JSON.parse(readFileSync(tracePath, 'utf8'));
        console.log(`  ⏭  ${resultId.padEnd(24)} ${task.tier} | resumed (${prev.status})`);
        results.push(prev);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop -- serial on purpose
      const result = await runOne(task, runDir, rep, opts.repeat);
      results.push(result);
    }
  }
  const aggregate = {
    runId, matrixVersion: '1.0',
    tasksTotal: results.length,
    tasksCompleted: results.filter((r) => r.status === 'completed').length,
    tasksFailed: results.filter((r) => r.status === 'failed').length,
    avgDurationMs: Math.round(results.reduce((a, r) => a + r.durationMs, 0) / Math.max(1, results.length)),
  };
  writeFileSync(join(runDir, 'summary.json'), JSON.stringify({ aggregate, results }, null, 2));
  console.log('\n[harness-eval]', JSON.stringify(aggregate));
  console.log(`[harness-eval] full summary: ${join(runDir, 'summary.json')}`);
}

const isMain = process.argv[1] && pathResolve(process.argv[1]) === pathResolve(__filename);
if (isMain) {
  main().catch((err) => {
    console.error('[harness-eval] fatal:', err);
    process.exit(1);
  });
}

// Named exports for unit tests and helper scripts (ESM — no CommonJS interop needed)
export { parseArgs, scrubSecrets, filterTasks, MATRIX };
