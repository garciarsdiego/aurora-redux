// Integration test for the dashboard traces route
// (`GET /api/dashboard/workflows/:id/trace`). Validates that:
//   1. Unknown workflows return 404.
//   2. Known workflows with trace_spans return spans collapsed per task.
//   3. Tasks without spans fall back to lifecycle timestamps so the timeline
//      still shows a row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHttpMcpServer, type ShutdownFn } from '../../src/mcp/http-server.js';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  insertTask,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import { startTraceSpan, endTraceSpan } from '../../src/v2/observability/tracing.js';
import type { Task, Workflow } from '../../src/types/index.js';

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

function makeWorkflow(id: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace: 'traces_test',
    objective: 'trace route integration',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: 'traces_test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(id: string, wfId: string, kind: Task['kind']): Task {
  const now = Date.now();
  return {
    id,
    workflow_id: wfId,
    name: `task ${id}`,
    kind,
    input_json: '{}',
    output_json: null,
    status: 'running',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 1,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: now,
    completed_at: null,
    created_at: now,
    acceptance_criteria: 'task ran',
    refine_count: 0,
    max_refine: 1,
    refine_feedback: null,
    model: null,
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

describe('GET /api/dashboard/workflows/:id/trace', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-traces-${Date.now()}`);
  let originalAuth: string | undefined;

  let originalDbPath: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalAuth = process.env.OMNIFORGE_DAEMON_AUTH;
    originalDbPath = process.env.DB_PATH;
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    process.env.OMNIFORGE_DAEMON_TOKEN = 'traces-test-token';
    // Pin the DB path so seeding via initDb() in the test hits the same file
    // the trace router reads from inside the daemon.
    process.env.DB_PATH = join(dataDir, 'traces-test.db');
    token = process.env.OMNIFORGE_DAEMON_TOKEN;
    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
  });

  afterAll(async () => {
    await shutdown();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    if (originalAuth === undefined) delete process.env.OMNIFORGE_DAEMON_AUTH;
    else process.env.OMNIFORGE_DAEMON_AUTH = originalAuth;
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
  });

  it('returns 404 for an unknown workflow id', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/workflows/wf_does_not_exist/trace`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
  });

  it('collapses spans per task and exposes timestamps as ISO strings', async () => {
    // Seed: workflow + 2 tasks + 1 trace span per task.
    const db = initDb(process.env.DB_PATH!);
    try {
      const wfId = newWorkflowId();
      insertWorkflow(db, makeWorkflow(wfId));

      const task1 = makeTask(newTaskId(), wfId, 'llm_call');
      const task2 = makeTask(newTaskId(), wfId, 'cli_spawn');
      insertTask(db, task1);
      insertTask(db, task2);

      const span1 = startTraceSpan(db, {
        workflowId: wfId,
        taskId: task1.id,
        name: 'task1.llm_call',
        kind: 'llm_call',
        attributes: { model: 'cc/claude-sonnet-4-6', input_tokens: 10, output_tokens: 5, cost_usd: 0.0012 },
      });
      endTraceSpan(db, span1.id, { status: 'ok' });

      const span2 = startTraceSpan(db, {
        workflowId: wfId,
        taskId: task2.id,
        name: 'task2.cli_spawn',
        kind: 'cli_spawn',
      });
      endTraceSpan(db, span2.id, { status: 'ok' });

      const res = await fetch(
        `http://127.0.0.1:${port}/api/dashboard/workflows/${wfId}/trace`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        workflow_id: string;
        spans: Array<{ task_id: string; task_kind: string; started_at: string; status: string; model?: string }>;
        total_duration_ms?: number;
        total_cost_usd?: number;
      };
      expect(body.workflow_id).toBe(wfId);
      expect(body.spans).toHaveLength(2);
      const ids = body.spans.map((s) => s.task_id).sort();
      expect(ids).toEqual([task1.id, task2.id].sort());
      // Timestamps round-tripped as ISO strings.
      expect(new Date(body.spans[0].started_at).toString()).not.toBe('Invalid Date');
      // cost_usd attribute → aggregated.
      expect(body.total_cost_usd).toBeCloseTo(0.0012, 4);

      // Cleanup
      db.prepare('DELETE FROM trace_spans WHERE workflow_id = ?').run(wfId);
      db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(wfId);
      db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);
    } finally {
      db.close();
    }
  });

  it('falls back to task lifecycle when no spans exist', async () => {
    const db = initDb(process.env.DB_PATH!);
    try {
      const wfId = newWorkflowId();
      insertWorkflow(db, makeWorkflow(wfId));
      const task = makeTask(newTaskId(), wfId, 'llm_call');
      insertTask(db, task);

      const res = await fetch(
        `http://127.0.0.1:${port}/api/dashboard/workflows/${wfId}/trace`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { spans: Array<{ task_id: string; status: string }> };
      expect(body.spans).toHaveLength(1);
      expect(body.spans[0].task_id).toBe(task.id);
      expect(body.spans[0].status).toBe('running');

      db.prepare('DELETE FROM tasks WHERE workflow_id = ?').run(wfId);
      db.prepare('DELETE FROM workflows WHERE id = ?').run(wfId);
    } finally {
      db.close();
    }
  });

  it('rejects requests without a valid Bearer token', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/workflows/wf_anything/trace`,
    );
    expect([401, 403]).toContain(res.status);
  });
});
