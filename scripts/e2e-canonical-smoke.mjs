#!/usr/bin/env node
/**
 * End-to-end smoke harness — drives the real daemon with a fixed set of
 * canonical objectives and reports per-prompt timing + final status.
 *
 * Usage:
 *   node scripts/e2e-canonical-smoke.mjs [options]
 *
 * Options (all read from env or argv):
 *   OMNIFORGE_DAEMON_URL   — base URL (default: http://127.0.0.1:20129)
 *   OMNIFORGE_TOKEN        — bearer token from `omniforge daemon token`
 *   OMNIFORGE_WORKSPACE    — workspace name (default: internal)
 *   OMNIFORGE_USE_PERSONAS — when 'true', daemon must already have this set
 *                            in its env. The harness only reports it.
 *   --only=haiku,todo      — comma-separated subset of canonical IDs to run
 *   --timeout=600          — per-prompt wall-clock cap in seconds
 *
 * Why this script and not a vitest test:
 *   - Real LLM round-trips (no stubs) — the only way to validate that the
 *     persona path actually produces good output, that worker CLIs spawn,
 *     and that consolidator stitches things together.
 *   - Cost is zero per the user's standing-subscription setup, so running
 *     this every audit cycle is cheap.
 *   - Output is JSON-summarisable so CI can post to Slack / a dashboard.
 *
 * Origin: AUDIT-2026-05-05.md §10 — operator request "rotina de teste real
 * E2E, MCP e Front" with explicit canonical examples.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_BASE_URL = process.env.OMNIFORGE_DAEMON_URL ?? 'http://127.0.0.1:20129';
const DEFAULT_TOKEN = process.env.OMNIFORGE_TOKEN ?? '';
const DEFAULT_WORKSPACE = process.env.OMNIFORGE_WORKSPACE ?? 'internal';

const argv = parseArgs(process.argv.slice(2));
const TIMEOUT_S = Number(argv.timeout ?? 600);

// ── Canonical prompts ───────────────────────────────────────────────────────
// Each entry is intentionally narrow: one task that an LLM can answer in
// a few seconds AND that a multi-step DAG would also handle gracefully.
// Add new ones at the bottom; the suite is opt-in via `--only=<id>,<id>`.

const CANONICAL_PROMPTS = [
  {
    id: 'haiku',
    objective: 'Write a 3-line haiku about resilience. Output only the haiku, no preamble or commentary.',
    expect: { minOutputChars: 30, mustContain: [] },
    description: 'Single-shot creative — no tools needed, sanity-checks LLM call path.',
  },
  {
    id: 'todo-app',
    objective:
      'Generate a single-file HTML todo list app (vanilla JS, no frameworks). Output ONLY the complete HTML document. ' +
      'Must support: add task, mark complete, delete task. Use localStorage to persist.',
    expect: { minOutputChars: 800, mustContain: ['<html', '<script', 'localStorage'] },
    description: 'Multi-feature deliverable — exercises Worker file output + acceptance evidence.',
  },
  {
    id: 'lol-demacia',
    objective:
      'List the playable champions associated with the faction "Demacia" in League of Legends. ' +
      'Output a JSON array of { "name": string, "role": string } objects. JSON only, no commentary.',
    expect: { minOutputChars: 100, mustContain: ['Garen', 'Lux'] },
    description: 'Knowledge retrieval + structured-output — tests LLM grounding without internet.',
  },
  {
    id: 'dag-explainer',
    objective:
      'Explain in 5 bullet points how a DAG (directed acyclic graph) of 5 tasks executes when ' +
      'task #3 fails: which tasks run, which are blocked, what the orchestrator should do.',
    expect: { minOutputChars: 200, mustContain: ['blocked', 'task'] },
    description: 'Reasoning — checks model handles a process-explanation prompt cleanly.',
  },
  {
    id: 'consolidate-3',
    objective:
      'You are given three worker outputs:\n\n' +
      '1) Worker A wrote `/src/auth.ts` (45 lines).\n' +
      '2) Worker B wrote `/src/db.ts` (120 lines, depends on auth).\n' +
      '3) Worker C wrote `/src/api.ts` (80 lines, depends on auth + db).\n\n' +
      'Produce a 4-line status report summarising what was built, in plain prose.',
    expect: { minOutputChars: 150, mustContain: ['auth', 'db', 'api'] },
    description: 'Synthesis — mirrors what the Consolidator persona must do post-workflow.',
  },
];

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function http(method, pathWithQuery, body) {
  const url = `${DEFAULT_BASE_URL}${pathWithQuery}`;
  const headers = { 'content-type': 'application/json' };
  if (DEFAULT_TOKEN) headers.authorization = `Bearer ${DEFAULT_TOKEN}`;

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!response.ok) {
    const detail = typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed).slice(0, 500);
    throw new Error(`${method} ${pathWithQuery} → ${response.status}: ${detail}`);
  }
  return parsed;
}

// ── Workflow lifecycle ──────────────────────────────────────────────────────

async function planThenRun(objective) {
  // Plan first so we get a DAG to inspect; then run with that DAG
  // (avoiding a second decompose + matching the dashboard flow).
  const plan = await http('POST', '/api/dashboard/dags/plan', {
    workspace: DEFAULT_WORKSPACE,
    objective,
  });
  if (!plan?.dag) throw new Error('plan returned no dag');

  const run = await http('POST', '/api/dashboard/dags/run', {
    workspace: DEFAULT_WORKSPACE,
    objective,
    dag: plan.dag,
    cli_permission_mode: 'autonomous',
  });
  if (!run?.workflow_id) throw new Error('run returned no workflow_id');
  return { workflowId: run.workflow_id, taskCount: plan.dag.tasks?.length ?? 0 };
}

async function pollUntilDone(workflowId, deadlineMs) {
  const start = Date.now();
  while (Date.now() < deadlineMs) {
    const summary = await http('GET', `/api/dashboard/summary?workspace=${encodeURIComponent(DEFAULT_WORKSPACE)}`);
    const runs = Array.isArray(summary?.runs) ? summary.runs : [];
    const run = runs.find((r) => r.id === workflowId);
    if (!run) {
      await sleep(2000);
      continue;
    }
    if (run.status === 'success' || run.status === 'completed') return { ok: true, run };
    if (run.status === 'failed' || run.status === 'cancelled') return { ok: false, run };
    // Poll cadence — fast at start, decay to 5s once we've waited a while.
    const elapsed = (Date.now() - start) / 1000;
    await sleep(elapsed < 30 ? 2000 : 5000);
  }
  return { ok: false, run: { status: 'timeout' } };
}

async function fetchConsolidatedOutput(workflowId) {
  // Best-effort: pull the workflow's DAG to get the final task's output
  // for a quick eyeball check. Some endpoints may 404 in older builds.
  try {
    const dag = await http('GET', `/api/dashboard/workflows/${encodeURIComponent(workflowId)}/dag`);
    return dag;
  } catch { return null; }
}

// ── Per-prompt runner ───────────────────────────────────────────────────────

async function runOne(prompt) {
  const startMs = Date.now();
  const result = {
    id: prompt.id,
    description: prompt.description,
    objective_chars: prompt.objective.length,
    workflow_id: null,
    task_count: 0,
    final_status: null,
    elapsed_s: 0,
    pass: false,
    notes: [],
  };
  try {
    const { workflowId, taskCount } = await planThenRun(prompt.objective);
    result.workflow_id = workflowId;
    result.task_count = taskCount;

    const deadlineMs = startMs + TIMEOUT_S * 1000;
    const { ok, run } = await pollUntilDone(workflowId, deadlineMs);
    result.final_status = run.status;
    result.elapsed_s = Math.round((Date.now() - startMs) / 1000);

    if (!ok) {
      result.notes.push(`workflow ended with status=${run.status}`);
      return result;
    }

    // Optional: fetch DAG and check expectations on the final task's output.
    const dag = await fetchConsolidatedOutput(workflowId);
    const lastTask = Array.isArray(dag?.tasks) ? dag.tasks[dag.tasks.length - 1] : null;
    const finalOutput = (lastTask?.output_json ?? '').slice(0, 4000);

    if (finalOutput.length < prompt.expect.minOutputChars) {
      result.notes.push(`output too short (${finalOutput.length} < ${prompt.expect.minOutputChars})`);
      return result;
    }
    for (const must of prompt.expect.mustContain) {
      if (!finalOutput.toLowerCase().includes(String(must).toLowerCase())) {
        result.notes.push(`output missing expected substring: "${must}"`);
        return result;
      }
    }
    result.pass = true;
  } catch (err) {
    result.notes.push(err instanceof Error ? err.message : String(err));
    result.elapsed_s = Math.round((Date.now() - startMs) / 1000);
  }
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).trim();
      const val = eq === -1 ? 'true' : a.slice(eq + 1);
      out[key] = val;
    }
  }
  return out;
}

function pickPrompts() {
  const only = typeof argv.only === 'string' ? argv.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
  if (!only || only.length === 0) return CANONICAL_PROMPTS;
  return CANONICAL_PROMPTS.filter((p) => only.includes(p.id));
}

(async () => {
  const prompts = pickPrompts();
  if (prompts.length === 0) {
    console.error('no prompts selected — check --only flag');
    process.exit(2);
  }

  console.log(JSON.stringify({
    event: 'smoke_started',
    base_url: DEFAULT_BASE_URL,
    workspace: DEFAULT_WORKSPACE,
    use_personas: process.env.OMNIFORGE_USE_PERSONAS ?? '(unset)',
    prompts: prompts.map((p) => p.id),
    timeout_s: TIMEOUT_S,
  }));

  const results = [];
  for (const p of prompts) {
    console.log(JSON.stringify({ event: 'prompt_started', id: p.id }));
    const r = await runOne(p);
    console.log(JSON.stringify({ event: 'prompt_finished', ...r }));
    results.push(r);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const summary = {
    event: 'smoke_summary',
    total: results.length,
    passed,
    failed,
    elapsed_s: results.reduce((acc, r) => acc + r.elapsed_s, 0),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));

  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error('e2e-canonical-smoke fatal:', err);
  process.exit(99);
});
