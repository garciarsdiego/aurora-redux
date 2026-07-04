/**
 * S5 smoke — 17 advisor POST endpoints.
 * Tests: auth gate (401 w/o token), unknown-advisor (404), all 17 return 200.
 * Uses a minimal ping payload; doesn't wait for LLM completion (--max-time style abort).
 */
import { readFileSync } from 'fs';

const TOKEN = readFileSync('data/daemon-token.txt', 'utf8').trim();
const BASE = 'http://127.0.0.1:20129';

const ADVISORS = [
  'chat','listmodels','version','apilookup','challenge','analyze','codereview',
  'debug','secaudit','planner','consensus','testgen','refactor','docgen',
  'tracer','precommit','thinkdeep',
];

const PING_BODY = JSON.stringify({
  workspace: 'internal',
  input: { messages: [{ role: 'user', content: 'ping' }] },
});

async function post(path, headers, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
    });
    return { status: r.status, ok: r.ok };
  } catch (e) {
    if (e.name === 'AbortError') return { status: 'TIMEOUT', ok: false };
    return { status: `ERR:${e.message.substring(0, 40)}`, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// 1. Auth gate — no token
const noAuth = await post('/api/dashboard/advisors/chat/call', { 'Content-Type': 'application/json' }, PING_BODY);
console.log(`Auth gate (no token): ${noAuth.status}  (expect: 401)`);

// 2. Unknown advisor — structured 404
const unknown = await post(
  '/api/dashboard/advisors/nonexistent/call',
  { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  PING_BODY,
);
console.log(`Unknown advisor:      ${unknown.status}  (expect: 404)`);

// 3. All 17 advisors
console.log('\nAdvisor spot-check (8s timeout each):');
const results = [];
for (const adv of ADVISORS) {
  const r = await post(
    `/api/dashboard/advisors/${adv}/call`,
    { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    PING_BODY,
    8000,
  );
  const verdict = (r.status === 200 || r.status === 206) ? 'PASS' : `FAIL(${r.status})`;
  console.log(`  ${adv.padEnd(12)} -> ${r.status}  [${verdict}]`);
  results.push({ adv, status: r.status, verdict });
}

const failed = results.filter(r => r.verdict !== 'PASS');
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:', failed.map(r => `${r.adv}(${r.status})`).join(', '));
  console.log('RESULT: FAIL');
} else if (noAuth.status !== 401 || unknown.status !== 404) {
  console.log('RESULT: FAIL (auth or unknown-advisor check wrong)');
} else {
  console.log('RESULT: PASS');
}
