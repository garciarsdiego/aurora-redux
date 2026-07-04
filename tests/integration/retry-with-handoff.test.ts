/**
 * Wave 2 Agent M1-W2-C (B6, 2026-05-12) — retry endpoint accepts handoff_id.
 *
 * Closes the dead UX bullet where InspectorSheet.tsx showed a DISABLED
 * "Retry/adjust from handoff" button with the comment "the current
 * retry endpoint does not yet accept a concrete handoff id as the
 * retry context contract".
 *
 * Contract:
 *   POST /api/dashboard/workflows/:wfId/tasks/:taskId/retry
 *     { mode, objective?, handoff_id? }
 *   - When handoff_id is set:
 *       * 200 if handoff exists AND belongs to (wfId, taskId);
 *         response.objective contains both the handoff title/body AND
 *         the retry objective.
 *       * 400 if handoff is missing.
 *       * 400 if handoff belongs to a different workflow or task.
 *   - When handoff_id is omitted: existing retry semantics (already
 *     covered by dashboard-http.test.ts).
 *
 * What this test verifies:
 *   1. Retry with a valid handoff_id succeeds and the dispatched
 *      `dashboard_task_retry_started` event captures the handoff_id.
 *   2. Retry with a missing handoff_id returns 400.
 *   3. Retry with a handoff that belongs to a different task returns
 *      400 — defense against cross-task context smuggling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { initDb } from '../../src/db/client.js';
import { recordTaskHandoff } from '../../src/context/workflow-adapter.js';
import {
  resolveToken,
  startHttpMcpServer,
  type ShutdownFn,
} from '../../src/mcp/http-server.js';
import { setDashboardPlannerForTests } from '../../src/mcp/dashboard-plan-ops.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not get address'));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

describe('POST .../tasks/:taskId/retry with handoff_id (B6)', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-retry-handoff-${Date.now()}`);
  const dbPath = join(dataDir, 'omniforge.db');
  let originalDbPath: string | undefined;
  let originalUsePersonas: string | undefined;
  // Stable ids so we can hit the route deterministically.
  const workflowId = 'wf_retry_handoff';
  const taskId = 'tk_retry_handoff';
  const otherTaskId = 'tk_retry_handoff_other';

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalDbPath = process.env.DB_PATH;
    originalUsePersonas = process.env.OMNIFORGE_USE_PERSONAS;
    process.env.DB_PATH = dbPath;
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    setDashboardPlannerForTests(async (raw) => JSON.stringify({
      status: 'plan_ready',
      workspace: raw.workspace,
      objective: raw.objective,
      task_count: 1,
      plan: [{
        id: 't0',
        name: 'Retry seed',
        kind: 'tool_call',
        depends_on: [],
        tool_name: 'file-write',
        args: { path: 'retry.txt', content: 'ok' },
        timeout_seconds: 60,
      }],
      dag_json: JSON.stringify({
        tasks: [{
          id: 't0',
          name: 'Retry seed',
          kind: 'tool_call',
          depends_on: [],
          tool_name: 'file-write',
          args: { path: 'retry.txt', content: 'ok' },
          timeout_seconds: 60,
        }],
      }),
    }));

    // Seed a completed workflow + two tasks. We retry `taskId` and verify
    // the handoff for `otherTaskId` is rejected for cross-task smuggling.
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, started_at, created_at)
         VALUES (?, 'internal', 'retry-with-handoff smoke', 'executing', ?, ?)`,
      ).run(workflowId, now - 2_000, now - 3_000);
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, input_json, output_json, status,
            depends_on_json, executor_hint, timeout_seconds, max_retries, retry_count,
            retry_policy, started_at, completed_at, created_at, acceptance_criteria,
            refine_count, max_refine, refine_feedback, model, hitl, execution_mode)
         VALUES (?, ?, 'Retry seed', 'tool_call',
            '{"workspace":"internal","tool_name":"file-write","args":{"path":"retry.txt","content":"ok"}}',
            '{}', 'failed', '[]', NULL, 60, 3, 0, 'exponential',
            ?, ?, ?, NULL, 0, 2, NULL, NULL, 0, 'ephemeral')`,
      ).run(taskId, workflowId, now - 2_000, now - 1_500, now - 2_000);
      db.prepare(
        `INSERT INTO tasks (id, workflow_id, name, kind, input_json, output_json, status,
            depends_on_json, executor_hint, timeout_seconds, max_retries, retry_count,
            retry_policy, started_at, completed_at, created_at, acceptance_criteria,
            refine_count, max_refine, refine_feedback, model, hitl, execution_mode)
         VALUES (?, ?, 'Unrelated task', 'tool_call',
            '{"workspace":"internal","tool_name":"file-write","args":{"path":"x.txt","content":"x"}}',
            '{}', 'completed', '[]', NULL, 60, 3, 0, 'exponential',
            ?, ?, ?, NULL, 0, 2, NULL, NULL, 0, 'ephemeral')`,
      ).run(otherTaskId, workflowId, now - 2_000, now - 1_500, now - 2_000);

      // Seed handoffs via the production code path. recordTaskHandoff is
      // the same function the post_task_handoff MCP tool uses.
      recordTaskHandoff(db, {
        workspace: 'internal',
        runId: workflowId,
        taskId,
        taskName: 'Retry seed',
        attempt: 1,
        kind: 'instruction',
        title: 'Operator handoff: tighten the retry',
        body: 'Switch to a different model and re-run with stricter validation.',
        artifacts: [],
        filesTouched: [],
        decisions: [],
        safeContext: {},
      });
      // Second handoff scoped to the OTHER task — we use this to assert
      // the daemon rejects cross-task handoff smuggling.
      recordTaskHandoff(db, {
        workspace: 'internal',
        runId: workflowId,
        taskId: otherTaskId,
        taskName: 'Unrelated task',
        attempt: 1,
        kind: 'instruction',
        title: 'Should NOT be reachable from the other task',
        body: 'Cross-task smuggling attempt.',
        artifacts: [],
        filesTouched: [],
        decisions: [],
        safeContext: {},
      });
    } finally {
      db.close();
    }

    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
  });

  afterAll(async () => {
    await shutdown();
    setDashboardPlannerForTests(null);
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    if (originalUsePersonas === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = originalUsePersonas;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    // The retry path schedules an async background workflow that holds
    // the SQLite WAL open. On Windows the OS keeps the file locked
    // briefly even after the daemon shuts down. Wait a beat, then try
    // to clean up — but tolerate EPERM so the test still passes.
    await sleep(500);
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Best-effort cleanup; tmpdir reaper will pick up leftovers.
    }
  });

  function readHandoffIds(filterTaskId: string): string[] {
    const db = initDb(dbPath);
    try {
      const rows = db
        .prepare('SELECT id FROM task_handoffs WHERE run_id = ? AND task_id = ?')
        .all(workflowId, filterTaskId) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    } finally {
      db.close();
    }
  }

  // Tests run in order. The validation cases must run BEFORE the happy
  // path because the retry endpoint takes a per-workflow lock the
  // moment a real retry is scheduled (see handleDashboardTaskRetry in
  // src/mcp/routes/dashboard-workflow-ops.ts:1099). The lock is only
  // released once the background workflow execution settles — which
  // never happens here because the planner is a no-op stub, so we run
  // the success case last to keep the suite deterministic.

  it('rejects retry with a non-existent handoff_id', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/workflows/${workflowId}/tasks/${taskId}/retry?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'task',
          objective: 'Retry with bogus handoff',
          handoff_id: 'ch_does_not_exist',
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('ch_does_not_exist');
  });

  it('rejects a handoff that belongs to a different task', async () => {
    const crossTaskHandoffs = readHandoffIds(otherTaskId);
    expect(crossTaskHandoffs.length).toBeGreaterThan(0);
    const wrongScope = crossTaskHandoffs[0]!;

    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/workflows/${workflowId}/tasks/${taskId}/retry?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'task',
          objective: 'Cross-task smuggling',
          handoff_id: wrongScope,
        }),
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('different task');
  });

  it('accepts a valid handoff_id and records it in the retry_started event', async () => {
    const handoffIds = readHandoffIds(taskId);
    expect(handoffIds.length).toBeGreaterThan(0);
    const handoffId = handoffIds[0]!;

    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/workflows/${workflowId}/tasks/${taskId}/retry?token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'task',
          objective: 'Apply the handoff above',
          handoff_id: handoffId,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      source_workflow_id: string;
      source_task_id: string;
      retry_scope: string;
      task_count: number;
      workflow_id: string;
    };
    expect(body).toMatchObject({
      source_workflow_id: workflowId,
      source_task_id: taskId,
      retry_scope: 'task',
      task_count: 1,
    });

    // Give the event broker a tick to flush. The retry_started event is
    // written synchronously inside prepareDashboardTaskRetryInPlace, but
    // SSE fan-out is async — a small sleep avoids flake when the DB
    // read races the insert.
    await sleep(50);

    // The retry_started event payload must capture handoff_id so the audit
    // trail records WHICH handoff was applied.
    const db = initDb(dbPath);
    try {
      const event = db
        .prepare(
          `SELECT payload_json FROM events
            WHERE workflow_id = ? AND type = 'dashboard_task_retry_started'
            ORDER BY timestamp DESC LIMIT 1`,
        )
        .get(workflowId) as { payload_json: string } | undefined;
      expect(event).toBeDefined();
      const payload = JSON.parse(event!.payload_json) as {
        objective: string;
        handoff_id: string | null;
      };
      expect(payload.handoff_id).toBe(handoffId);
      // The composed objective must include both the handoff body AND the
      // operator-typed retry objective so the LLM gets the agreed context
      // and the new instruction.
      expect(payload.objective).toContain('Switch to a different model');
      expect(payload.objective).toContain('Apply the handoff above');
    } finally {
      db.close();
    }
  });
});
