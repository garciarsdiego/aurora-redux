import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Response } from '@playwright/test';

const BASE_URL = process.env.OMNIFORGE_E2E_BASE_URL ?? 'http://127.0.0.1:20129';
export const E2E_WORKSPACE = 'internal';

// Stable IDs for the canonical E2E seed. Specs that need to reference a
// specific workflow / pattern should import these constants and avoid
// `test.skip(!workflowId, …)` no-ops on fresh checkouts.
export const E2E_SEEDED_WORKFLOW_COMPLETED = 'wf_e2e_seed_completed';
export const E2E_SEEDED_WORKFLOW_EXECUTING = 'wf_e2e_seed_executing';
export const E2E_SEEDED_GATE_ID = 'gate_e2e_seed_pending';
export const E2E_SEEDED_PATTERN_ID = 'pat_e2e_seed_simple';

export function getToken(): string {
  const tokenFromEnv = process.env.OMNIFORGE_DAEMON_TOKEN?.trim();
  if (tokenFromEnv) {
    return tokenFromEnv;
  }

  return readFileSync(resolve(process.cwd(), 'data', 'daemon-token.txt'), 'utf8').trim();
}

export function dashboardUrl(path = '/'): string {
  const url = new URL(path, BASE_URL);
  url.searchParams.set('token', getToken());
  return url.toString();
}

export async function authenticateDashboard(page: Page): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('omniforgeDashboardToken', value);
  }, getToken());
  await page.addInitScript(() => {
    localStorage.setItem('omniforge.v1.onboarded', JSON.stringify({ v: 1, data: true }));
    localStorage.setItem('omniforge.v1.selected-workspace', JSON.stringify({ v: 1, data: 'internal' }));
    localStorage.setItem(
      'omniforge.v1.workspaces',
      JSON.stringify({ v: 1, data: [{ id: 'ws1', name: 'internal' }] }),
    );
  });
}

export async function openDashboard(page: Page, path: string): Promise<Response | null> {
  await authenticateDashboard(page);
  const response = await page.goto(dashboardUrl(path), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main, [data-testid], h1, h2, #root', { timeout: 10000 });
  return response;
}

export async function mcpFetch<T = unknown>(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(new URL('/mcp/tools/call', BASE_URL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: toolName,
      arguments: args,
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP tool call failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

/**
 * Wave 3 (M1-W3-C): seed canonical fixtures so specs no longer silently skip
 * via `test.skip(!workflowId, ...)` on fresh checkouts.
 *
 * Idempotent — safe to call from beforeAll of every spec file. Uses
 * `INSERT … ON CONFLICT DO NOTHING` (or UPSERT) so re-seeding never
 * trashes data from a previous run. All rows are tagged `created_by = 'e2e'`
 * so the seed cleanup query can target them precisely.
 *
 * Data shape:
 *   - 1 workspace `internal` (created_by = 'e2e' if not already present)
 *   - 1 workflow in `completed` status (E2E_SEEDED_WORKFLOW_COMPLETED) — used
 *     by inspectors/diff specs and the canonical `/dashboard/runs/<id>` route
 *   - 1 workflow in `executing` status (E2E_SEEDED_WORKFLOW_EXECUTING) — used
 *     by DagCanvas specs that need a live workflow
 *   - 1 pending HITL gate on the executing workflow — used by gate inbox
 *   - 1 pattern (E2E_SEEDED_PATTERN_ID) — used by pattern detail spec
 *
 * Seeding strategy: direct better-sqlite3 inserts. The daemon's HTTP API
 * (POST /api/dashboard/dags/run) would also work but requires the daemon
 * be running with the right cwd and would trigger real LLM calls. Direct
 * DB inserts are deterministic + fast.
 */
export async function seedE2EFixtures(): Promise<void> {
  const { initDb } = await import('../../src/db/client.js');
  const { getDbPath } = await import('../../src/utils/config.js');

  const db = initDb(getDbPath());
  const now = Date.now();

  try {
    // 1. Workspace — required by FK indirection (dashboard_workspaces stores
    // free-form names so we just upsert the canonical `internal` name).
    db.prepare(
      `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
       VALUES (?, ?, 'e2e', '{}')
       ON CONFLICT(name) DO NOTHING`,
    ).run(E2E_WORKSPACE, now);

    // 2. Completed workflow — for inspectors / diff specs.
    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, pattern_id, status, started_at, completed_at,
          created_at, created_by, estimated_cost_usd, actual_cost_usd,
          max_total_cost_usd, max_duration_seconds, metadata)
       VALUES (?, ?, ?, NULL, 'completed', ?, ?, ?, 'e2e', NULL, 0.0, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
    ).run(
      E2E_SEEDED_WORKFLOW_COMPLETED,
      E2E_WORKSPACE,
      'E2E seeded completed workflow — used by inspectors and diff specs',
      now - 600_000,
      now - 300_000,
      now - 600_000,
      JSON.stringify({ e2e: true, seed: 'M1-W3-C' }),
    );

    // 3. Executing workflow — for DagCanvas / live-state specs.
    db.prepare(
      `INSERT INTO workflows
         (id, workspace, objective, pattern_id, status, started_at, completed_at,
          created_at, created_by, estimated_cost_usd, actual_cost_usd,
          max_total_cost_usd, max_duration_seconds, metadata)
       VALUES (?, ?, ?, NULL, 'executing', ?, NULL, ?, 'e2e', NULL, NULL, NULL, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
    ).run(
      E2E_SEEDED_WORKFLOW_EXECUTING,
      E2E_WORKSPACE,
      'E2E seeded executing workflow — used by DagCanvas specs',
      now - 60_000,
      now - 90_000,
      JSON.stringify({ e2e: true, seed: 'M1-W3-C' }),
    );

    // 3a. One task per workflow so DagCanvas has something to render.
    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, input_json, output_json, status,
          depends_on_json, executor_hint, timeout_seconds, max_retries,
          retry_count, retry_policy, started_at, completed_at, created_at,
          acceptance_criteria, refine_count, max_refine, refine_feedback,
          model, hitl, execution_mode, tool_name)
       VALUES (?, ?, 'seed-task', 'llm_call', '{}', '{}', 'completed',
          '[]', NULL, 300, 1, 0, 'exponential', ?, ?, ?, NULL, 0, 1, NULL,
          'cx/gpt-5.4', 0, 'ephemeral', NULL)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      `${E2E_SEEDED_WORKFLOW_COMPLETED}_t1`,
      E2E_SEEDED_WORKFLOW_COMPLETED,
      now - 580_000,
      now - 320_000,
      now - 580_000,
    );

    db.prepare(
      `INSERT INTO tasks
         (id, workflow_id, name, kind, input_json, output_json, status,
          depends_on_json, executor_hint, timeout_seconds, max_retries,
          retry_count, retry_policy, started_at, completed_at, created_at,
          acceptance_criteria, refine_count, max_refine, refine_feedback,
          model, hitl, execution_mode, tool_name)
       VALUES (?, ?, 'seed-task-running', 'cli_spawn', '{}', NULL, 'running',
          '[]', 'cli:codex', 300, 1, 0, 'exponential', ?, NULL, ?, NULL, 0, 1, NULL,
          'cx/gpt-5.4', 0, 'ephemeral', NULL)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      `${E2E_SEEDED_WORKFLOW_EXECUTING}_t1`,
      E2E_SEEDED_WORKFLOW_EXECUTING,
      now - 40_000,
      now - 80_000,
    );

    // 4. Pending HITL gate on the executing workflow.
    db.prepare(
      `INSERT INTO hitl_gates
         (id, workflow_id, gate_type, prompt, context_json, status,
          decision, decision_reason, channel, created_at, decided_at)
       VALUES (?, ?, 'approval', 'E2E seeded gate — awaiting approval', ?, 'pending',
          NULL, NULL, 'cli', ?, NULL)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      E2E_SEEDED_GATE_ID,
      E2E_SEEDED_WORKFLOW_EXECUTING,
      JSON.stringify({ seeded: true }),
      now - 30_000,
    );

    // 5. Pattern — for pattern detail spec.
    db.prepare(
      `INSERT INTO patterns
         (id, workspace, name, source, objective_sample, dag_json,
          usage_count, success_count, avg_duration_ms, last_used_at, created_at)
       VALUES (?, ?, 'E2E Seeded Pattern', 'e2e', 'Seeded pattern for E2E specs', ?,
          0, 0, NULL, NULL, ?)
       ON CONFLICT(workspace, name) DO NOTHING`,
    ).run(
      E2E_SEEDED_PATTERN_ID,
      E2E_WORKSPACE,
      JSON.stringify({ tasks: [{ id: 't1', name: 'seed', kind: 'llm_call', depends_on: [] }] }),
      now - 120_000,
    );
  } finally {
    db.close();
  }
}

/**
 * Cleanup the canonical E2E seed (best-effort). Specs SHOULD NOT call this
 * unless they own the seed; concurrent runs share fixtures.
 */
export async function cleanupE2EFixtures(): Promise<void> {
  const { initDb } = await import('../../src/db/client.js');
  const { getDbPath } = await import('../../src/utils/config.js');

  const db = initDb(getDbPath());
  try {
    db.prepare(`DELETE FROM hitl_gates WHERE id = ?`).run(E2E_SEEDED_GATE_ID);
    db.prepare(`DELETE FROM tasks WHERE workflow_id IN (?, ?)`).run(
      E2E_SEEDED_WORKFLOW_COMPLETED,
      E2E_SEEDED_WORKFLOW_EXECUTING,
    );
    db.prepare(`DELETE FROM events WHERE workflow_id IN (?, ?)`).run(
      E2E_SEEDED_WORKFLOW_COMPLETED,
      E2E_SEEDED_WORKFLOW_EXECUTING,
    );
    db.prepare(`DELETE FROM workflows WHERE id IN (?, ?) AND created_by = 'e2e'`).run(
      E2E_SEEDED_WORKFLOW_COMPLETED,
      E2E_SEEDED_WORKFLOW_EXECUTING,
    );
    db.prepare(`DELETE FROM patterns WHERE id = ?`).run(E2E_SEEDED_PATTERN_ID);
  } finally {
    db.close();
  }
}
