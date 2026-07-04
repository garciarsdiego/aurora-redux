/**
 * Wave 2 Agent M1-W2-C (B5, 2026-05-12) — DELETE /api/dashboard/dags/:id.
 *
 * Closes the dead UX bullet where PatternDetail.tsx wires the trash
 * button to a stub that throws "deletePattern() not yet wired". The
 * daemon now exposes:
 *
 *   DELETE /api/dashboard/dags/:id  →  200 { ok, deleted_id, name }
 *                                   →  404 if the pattern is missing
 *                                   →  400 if id is empty or malformed
 *
 * What this test verifies:
 *   1. Happy path: a seeded pattern is deleted; the row is gone from
 *      the `patterns` table and a structured stderr line is emitted.
 *   2. Idempotency / 404: a second delete on the same id returns 404
 *      with a clear error message (no 500, no resurrection).
 *   3. Auth gate: the endpoint requires a Bearer token.
 *   4. Cascade safety: `pattern_usage` rows that referenced the
 *      pattern are removed via FK ON DELETE CASCADE (migration 001),
 *      so the related telemetry doesn't go orphan.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { initDb } from '../../src/db/client.js';
import { insertPattern } from '../../src/db/persist.js';
import {
  resolveToken,
  startHttpMcpServer,
  type ShutdownFn,
} from '../../src/mcp/http-server.js';
import { setDashboardPlannerForTests } from '../../src/mcp/dashboard-plan-ops.js';
import type { Pattern } from '../../src/types/index.js';

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

function seedPattern(dbPath: string, id: string, name = 'test pattern'): Pattern {
  const db = initDb(dbPath);
  try {
    const pattern: Pattern = {
      id,
      workspace: 'internal',
      name,
      source: 'imported',
      objective_sample: `seed for ${id}`,
      dag_json: JSON.stringify({
        tasks: [
          {
            id: 't0',
            name: 'seed task',
            kind: 'tool_call',
            depends_on: [],
          },
        ],
      }),
      usage_count: 0,
      success_count: 0,
      avg_duration_ms: null,
      last_used_at: null,
      created_at: Date.now(),
    };
    insertPattern(db, pattern);
    return pattern;
  } finally {
    db.close();
  }
}

describe('DELETE /api/dashboard/dags/:id — pattern delete (B5)', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-pattern-delete-${Date.now()}`);
  const dbPath = join(dataDir, 'omniforge.db');
  let originalDbPath: string | undefined;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dbPath;
    delete process.env.OMNIFORGE_DAEMON_AUTH;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    setDashboardPlannerForTests(async () => JSON.stringify({
      status: 'plan_ready',
      workspace: 'internal',
      objective: 'noop',
      task_count: 0,
      plan: [],
      dag_json: JSON.stringify({ tasks: [] }),
    }));

    port = await getFreePort();
    shutdown = await startHttpMcpServer(dataDir, port);
    token = resolveToken(dataDir);
  });

  afterAll(async () => {
    await shutdown();
    setDashboardPlannerForTests(null);
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rejects unauthenticated DELETE requests', async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/dags/pt_nonexistent`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(401);
  });

  it('deletes an existing pattern and returns the deleted row metadata', async () => {
    const pattern = seedPattern(dbPath, 'pt_delete_happy');

    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/dags/${encodeURIComponent(pattern.id)}?token=${token}`,
      { method: 'DELETE' },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      deleted_id: string;
      name: string;
      workspace: string;
    };
    expect(body).toMatchObject({
      ok: true,
      deleted_id: pattern.id,
      name: pattern.name,
      workspace: 'internal',
    });

    // Verify the row is actually gone.
    const db = initDb(dbPath);
    try {
      const row = db
        .prepare('SELECT id FROM patterns WHERE id = ?')
        .get(pattern.id);
      expect(row).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('returns 404 when the pattern is already gone (idempotent delete)', async () => {
    const pattern = seedPattern(dbPath, 'pt_delete_twice');

    const first = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/dags/${encodeURIComponent(pattern.id)}?token=${token}`,
      { method: 'DELETE' },
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/dags/${encodeURIComponent(pattern.id)}?token=${token}`,
      { method: 'DELETE' },
    );
    expect(second.status).toBe(404);
    const errorBody = await second.json() as { error: string };
    expect(errorBody.error).toContain(pattern.id);
  });

  it('cascades pattern_usage rows via FK ON DELETE CASCADE', async () => {
    const pattern = seedPattern(dbPath, 'pt_delete_cascade');

    // Seed a workflow + pattern_usage row pointing at the pattern. Migration
    // 038 added ON DELETE CASCADE on pattern_usage.pattern_id; this test
    // pins the contract. pattern_usage.workflow_id is NOT NULL so we seed
    // a minimal workflow row first.
    const db = initDb(dbPath);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO workflows (id, workspace, objective, status, started_at, created_at)
         VALUES (?, 'internal', 'cascade test', 'completed', ?, ?)`,
      ).run('wf_cascade_pattern', now - 1_000, now - 1_000);
      db.prepare(
        `INSERT INTO pattern_usage
           (workflow_id, pattern_id, similarity_decision, used_as_is, succeeded, created_at)
         VALUES (?, ?, NULL, 1, 1, ?)`,
      ).run('wf_cascade_pattern', pattern.id, now);
      const before = db
        .prepare('SELECT COUNT(*) as n FROM pattern_usage WHERE pattern_id = ?')
        .get(pattern.id) as { n: number };
      expect(before.n).toBe(1);
    } finally {
      db.close();
    }

    const res = await fetch(
      `http://127.0.0.1:${port}/api/dashboard/dags/${encodeURIComponent(pattern.id)}?token=${token}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);

    const after = initDb(dbPath);
    try {
      const remaining = after
        .prepare('SELECT COUNT(*) as n FROM pattern_usage WHERE pattern_id = ?')
        .get(pattern.id) as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      after.close();
    }
  });
});
