// Wave 2 M1-W2-E (gap-closure 2026-05-12): integration test for the patterns
// HTTP CRUD surface. Boots the daemon against a tempfile DB and drives the
// four new endpoints end-to-end:
//
//   GET    /api/dashboard/patterns?workspace=...
//   POST   /api/dashboard/patterns                  (save from workflow)
//   GET    /api/dashboard/patterns/:id/export
//   POST   /api/dashboard/patterns/import
//
// The handlers go through the same `src/patterns/store.ts` + persistence
// primitives as the MCP tools, so the assertions cover both: a successful
// round-trip (save -> list -> export -> import) AND the validation /
// error surfaces (4xx for missing/invalid inputs and unknown ids).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  insertTask,
  setTaskCompleted,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import { resolveToken, startHttpMcpServer, type ShutdownFn } from '../../src/mcp/http-server.js';
import type { Workflow, Task } from '../../src/types/index.js';

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

function makeCompletedWorkflow(id: string, workspace: string, objective: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective,
    pattern_id: null,
    status: 'completed',
    started_at: now - 1000,
    completed_at: now,
    created_at: now - 1000,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeCompletedTask(id: string, wfId: string, name: string, deps: string[]): Task {
  const now = Date.now();
  return {
    id,
    workflow_id: wfId,
    name,
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'completed',
    depends_on: deps,
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: now - 100,
    completed_at: now,
    created_at: now - 100,
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

interface PatternRow {
  id: string;
  name: string;
  workspace: string;
  objective_sample: string;
  usage_count: number;
  success_count: number;
  last_used_at: number | null;
}

interface ExportResponse {
  pattern_id: string;
  name: string;
  workspace: string;
  objective_sample: string;
  dag: { tasks: Array<{ id: string; name: string; depends_on: string[] }> };
}

describe('pattern HTTP CRUD endpoints', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-pattern-http-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const dbPath = join(dataDir, 'omniforge.db');
  let originalDbPath: string | undefined;
  let originalDaemonAuth: string | undefined;

  const completedWfId = newWorkflowId();
  const taskAId = newTaskId();
  const taskBId = newTaskId();
  const incompleteWfId = newWorkflowId();

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalDbPath = process.env['DB_PATH'];
    originalDaemonAuth = process.env['OMNIFORGE_DAEMON_AUTH'];
    process.env['DB_PATH'] = dbPath;
    delete process.env['OMNIFORGE_DAEMON_AUTH'];
    delete process.env['OMNIFORGE_DAEMON_TOKEN'];

    // Seed: one completed workflow (eligible for save) + one executing
    // workflow (used to assert the 400-on-not-completed path).
    const db = initDb(dbPath);
    try {
      insertWorkflow(db, makeCompletedWorkflow(completedWfId, 'internal', 'Build landing page'));
      insertTask(db, makeCompletedTask(taskAId, completedWfId, 'Design layout', []));
      insertTask(db, makeCompletedTask(taskBId, completedWfId, 'Write copy', [taskAId]));
      setTaskCompleted(db, taskAId, 'layout done');
      setTaskCompleted(db, taskBId, 'copy done');

      insertWorkflow(db, {
        ...makeCompletedWorkflow(incompleteWfId, 'internal', 'Still running'),
        status: 'executing',
        completed_at: null,
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
    if (originalDbPath === undefined) delete process.env['DB_PATH'];
    else process.env['DB_PATH'] = originalDbPath;
    if (originalDaemonAuth === undefined) delete process.env['OMNIFORGE_DAEMON_AUTH'];
    else process.env['OMNIFORGE_DAEMON_AUTH'] = originalDaemonAuth;
    delete process.env['OMNIFORGE_DAEMON_TOKEN'];
    await sleep(100);
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      ...(init ?? {}),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
    });
  }

  it('rejects requests without Bearer token (401)', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/patterns?workspace=internal`,
    );
    expect(res.status).toBe(401);
  });

  it('POST /api/dashboard/patterns rejects malformed workspace via input validation', async () => {
    // Pre-condition: an invalid workspace in workflow_id (here: missing wf)
    // surfaces as 400 because saveWorkflowAsPattern itself throws.
    const res = await authedFetch('/api/dashboard/patterns', {
      method: 'POST',
      body: JSON.stringify({ workflow_id: 'wf_does_not_exist', name: 'orphan' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/not found/i);
  });

  it('POST /api/dashboard/patterns rejects non-completed workflows (400)', async () => {
    const res = await authedFetch('/api/dashboard/patterns', {
      method: 'POST',
      body: JSON.stringify({ workflow_id: incompleteWfId, name: 'never-mind' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/completed/i);
  });

  it('POST /api/dashboard/patterns saves a completed workflow as a pattern (201)', async () => {
    const res = await authedFetch('/api/dashboard/patterns', {
      method: 'POST',
      body: JSON.stringify({ workflow_id: completedWfId, name: 'landing-page' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { pattern_id: string; name: string; workspace: string };
    expect(body.pattern_id).toMatch(/^pt_/);
    expect(body.name).toBe('landing-page');
    expect(body.workspace).toBe('internal');
  });

  it('GET /api/dashboard/patterns lists previously-saved patterns for the workspace', async () => {
    const res = await authedFetch('/api/dashboard/patterns?workspace=internal&limit=10');
    expect(res.status).toBe(200);
    const body = await res.json() as { patterns: PatternRow[] };
    expect(Array.isArray(body.patterns)).toBe(true);
    expect(body.patterns.length).toBeGreaterThanOrEqual(1);
    const saved = body.patterns.find((p) => p.name === 'landing-page');
    expect(saved).toBeDefined();
    expect(saved!.workspace).toBe('internal');
    expect(saved!.objective_sample).toBe('Build landing page');
    expect(saved!.usage_count).toBe(0);
  });

  it('GET /api/dashboard/patterns rejects invalid workspace (400)', async () => {
    const res = await authedFetch('/api/dashboard/patterns?workspace=bad%20space');
    expect(res.status).toBe(400);
  });

  it('GET /api/dashboard/patterns/:id/export returns the parsed DAG round-trip', async () => {
    // First find the pattern id from list.
    const list = await authedFetch('/api/dashboard/patterns?workspace=internal&limit=10');
    const { patterns } = await list.json() as { patterns: PatternRow[] };
    const target = patterns.find((p) => p.name === 'landing-page');
    expect(target).toBeDefined();

    const res = await authedFetch(
      `/api/dashboard/patterns/${encodeURIComponent(target!.id)}/export`,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as ExportResponse;
    expect(body.pattern_id).toBe(target!.id);
    expect(body.workspace).toBe('internal');
    expect(body.dag.tasks).toHaveLength(2);
    const layout = body.dag.tasks.find((t) => t.name === 'Design layout');
    const copy = body.dag.tasks.find((t) => t.name === 'Write copy');
    expect(layout).toBeDefined();
    expect(copy).toBeDefined();
    // depends_on is stable by name in the pattern wire format.
    expect(copy!.depends_on).toContain('Design layout');
  });

  it('GET /api/dashboard/patterns/:id/export returns 404 for unknown id', async () => {
    const res = await authedFetch('/api/dashboard/patterns/pt_does_not_exist/export');
    expect(res.status).toBe(404);
  });

  it('POST /api/dashboard/patterns/import accepts a portable DAG (201)', async () => {
    const portableDag = {
      tasks: [
        {
          id: 'plan',
          name: 'Plan',
          kind: 'llm_call',
          depends_on: [],
        },
        {
          id: 'execute',
          name: 'Execute',
          kind: 'llm_call',
          depends_on: ['plan'],
        },
      ],
    };
    const res = await authedFetch('/api/dashboard/patterns/import', {
      method: 'POST',
      body: JSON.stringify({
        workspace: 'internal',
        name: 'imported-flow',
        dag: portableDag,
        objective_sample: 'roundtripped DAG',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { pattern_id: string; name: string; workspace: string };
    expect(body.pattern_id).toMatch(/^pt_/);
    expect(body.name).toBe('imported-flow');
    expect(body.workspace).toBe('internal');

    // Verify it shows up in list afterwards.
    const list = await authedFetch('/api/dashboard/patterns?workspace=internal&limit=20');
    const { patterns } = await list.json() as { patterns: PatternRow[] };
    expect(patterns.some((p) => p.name === 'imported-flow')).toBe(true);
  });

  it('POST /api/dashboard/patterns/import rejects an invalid DAG shape (400)', async () => {
    const res = await authedFetch('/api/dashboard/patterns/import', {
      method: 'POST',
      body: JSON.stringify({
        workspace: 'internal',
        name: 'invalid-dag',
        dag: { not_tasks: 'oops' },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error?: string };
    expect(body.error).toMatch(/Invalid DAG/i);
  });

  it('POST /api/dashboard/patterns/import rejects an invalid workspace (400)', async () => {
    const res = await authedFetch('/api/dashboard/patterns/import', {
      method: 'POST',
      body: JSON.stringify({
        workspace: 'bad workspace',
        name: 'wont-import',
        dag: { tasks: [{ id: 't0', name: 'noop', kind: 'llm_call', depends_on: [] }] },
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/dashboard/patterns rejects a missing name (400)', async () => {
    const res = await authedFetch('/api/dashboard/patterns', {
      method: 'POST',
      body: JSON.stringify({ workflow_id: completedWfId }),
    });
    expect(res.status).toBe(400);
  });
});
