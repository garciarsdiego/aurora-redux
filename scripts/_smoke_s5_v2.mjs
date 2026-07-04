/**
 * S5 smoke v2 — proper per-advisor payloads.
 * STEPWISE_ADVISORS set in dashboard-advisors.ts auto-fills from `prompt`.
 * Advisors NOT in that set (analyze, tracer, secaudit, testgen, refactor, docgen)
 * need explicit step/findings fields.
 */
import { readFileSync } from 'fs';

const TOKEN = readFileSync('data/daemon-token.txt', 'utf8').trim();
const BASE = 'http://127.0.0.1:20129';

// These are in the auto-fill set — just send prompt
const AUTOFILL_STEPWISE = new Set(['codereview','consensus','debug','planner','precommit','thinkdeep']);

// These need prompt directly
const SIMPLE = new Set(['chat','apilookup','challenge','listmodels','version']);

// All 17
const ADVISORS = [
  'chat','listmodels','version','apilookup','challenge','analyze','codereview',
  'debug','secaudit','planner','consensus','testgen','refactor','docgen',
  'tracer','precommit','thinkdeep',
];

function buildPayload(adv) {
  if (SIMPLE.has(adv)) {
    return { workspace: 'internal', input: { prompt: 'ping' } };
  }
  if (AUTOFILL_STEPWISE.has(adv)) {
    return { workspace: 'internal', input: { prompt: 'quick smoke test ping' } };
  }
  // Full stepwise payload for non-autofill advisors
  const base = {
    workspace: 'internal',
    input: {
      step: 'smoke test ping',
      step_number: 1,
      total_steps: 1,
      next_step_required: false,
      findings: 'smoke test ping',
    },
  };
  if (adv === 'tracer') {
    base.input.target_description = 'smoke test ping for S5 validation';
  }
  return base;
}

async function post(path, body, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let errDetail = '';
    if (!r.ok) {
      try {
        const j = await r.json();
        errDetail = ` | ${JSON.stringify(j.error?.message ?? j).substring(0, 80)}`;
      } catch {}
    }
    return { status: r.status, detail: errDetail };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT', detail: '' };
    return { status: `ERR`, detail: e.message.substring(0, 50) };
  } finally {
    clearTimeout(timer);
  }
}

// Auth gate
const noAuth = await fetch(`${BASE}/api/dashboard/advisors/chat/call`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ workspace: 'internal', input: { prompt: 'ping' } }),
});
console.log(`Auth gate (no token): ${noAuth.status}  (expect: 401)`);

// Unknown advisor
const unk = await post('/api/dashboard/advisors/nonexistent/call', { workspace: 'internal', input: {} });
console.log(`Unknown advisor:      ${unk.status}  (expect: 404)\n`);

// All 17
console.log('Advisor spot-check:');
const results = [];
for (const adv of ADVISORS) {
  const payload = buildPayload(adv);
  const r = await post(`/api/dashboard/advisors/${adv}/call`, payload);
  // 200 = sync OK, 503 = upstream unreachable (Omniroute down) — route+advisor both exist
  // 400 = route+advisor exist but input wrong
  // 404 = advisor missing (FAIL)
  // 500 = advisor crashed (FAIL unless it's a known upstream issue)
  const routeExists = r.status !== 404 && r.status !== 'ERR' && r.status !== 'TIMEOUT';
  const verdict = r.status === 200 ? 'PASS' :
                  r.status === 503 ? 'PASS(upstream-down)' :
                  r.status === 400 ? `WARN(400-bad-input)` :
                  `FAIL(${r.status})`;
  console.log(`  ${adv.padEnd(12)} -> ${String(r.status).padEnd(4)}  [${verdict}]${r.detail}`);
  results.push({ adv, status: r.status, verdict, routeExists });
}

const hardFails = results.filter(r => r.status === 404 || r.status === 'ERR' || r.status === 'TIMEOUT' || r.status === 500);
const passed = results.filter(r => r.status === 200 || r.status === 503);
const warns = results.filter(r => r.status === 400);

console.log(`\nSummary:`);
console.log(`  Routes registered & responding: ${results.length - hardFails.length}/17`);
console.log(`  Clean 200/503:                  ${passed.length}/17`);
console.log(`  400 (wrong test payload):        ${warns.length}`);
console.log(`  Hard fails (404/500/ERR):        ${hardFails.length}`);

if (hardFails.length === 0 && noAuth.status === 401 && unk.status === 404) {
  console.log('\nRESULT: PASS — all 17 routes registered, auth gates working');
  if (warns.length) console.log(`  NOTE: ${warns.length} advisors returned 400 on test payload (routes exist, input schema mismatch in test)`);
} else {
  console.log('\nRESULT: FAIL');
  if (hardFails.length) console.log('  Hard fails:', hardFails.map(r => `${r.adv}(${r.status})`).join(', '));
}
