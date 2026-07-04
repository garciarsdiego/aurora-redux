// Sprint F4-6 (D-H2.066): integration test for the unified audit timeline
// endpoint. Boots the daemon against a temp DB, seeds one row in each of
// the three primary audit tables (permission_decisions, quality_reviews,
// workflow_control_state) and asserts:
//   1. Unfiltered call returns all three entries sorted by ts DESC.
//   2. Filter by `kind=permission` narrows to the single permission row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { initDb } from '../../src/db/client.js';
import { resolveToken, startHttpMcpServer, type ShutdownFn } from '../../src/mcp/http-server.js';

interface AuditEntry {
  id: string;
  ts: number;
  kind: 'permission' | 'quality' | 'workflow_control' | 'governance';
  actor: string | null;
  workflow_id: string | null;
  workspace: string | null;
  summary: string;
  details: Record<string, unknown>;
  outcome?: string;
}

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

describe('GET /api/dashboard/audit', () => {
  let shutdown: ShutdownFn;
  let port: number;
  let token: string;
  const dataDir = join(tmpdir(), `omniforge-audit-${Date.now()}`);
  const dbPath = join(dataDir, 'omniforge.db');
  let originalDbPath: string | undefined;
  let originalDaemonAuth: string | undefined;

  // Fixed timestamps so the DESC ordering assertion is deterministic.
  const tsPermission = 1_700_000_000_000;
  const tsQuality = 1_700_000_001_000;
  const tsWorkflowControl = 1_700_000_002_000;

  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    originalDbPath = process.env['DB_PATH'];
    originalDaemonAuth = process.env['OMNIFORGE_DAEMON_AUTH'];
    process.env['DB_PATH'] = dbPath;
    delete process.env['OMNIFORGE_DAEMON_AUTH'];
    delete process.env['OMNIFORGE_DAEMON_TOKEN'];

    // Seed: one workflow row to satisfy FKs for quality_reviews and
    // workflow_control_state, then one row in each of the three audit
    // tables we want to surface in the unified timeline.
    const db = initDb(dbPath);
    try {
      db.prepare(
        `INSERT INTO workflows
           (id, workspace, objective, pattern_id, status, started_at, completed_at,
            created_at, created_by, estimated_cost_usd, actual_cost_usd, metadata)
         VALUES ('wf_audit', 'internal', 'Audit smoke', NULL, 'completed',
                 ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(tsPermission - 1000, tsWorkflowControl, tsPermission - 2000);

      db.prepare(
        `INSERT INTO permission_decisions
           (ask_id, workflow_id, task_id, agent_id, tool,
            decision, decided_by, asked_at, decided_at)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'wf_audit:tk_audit:agent_a:bash:nonce0',
        'wf_audit',
        'agent_a',
        'bash',
        'approve',
        'operator-diego',
        tsPermission - 100,
        tsPermission,
      );

      db.prepare(
        `INSERT INTO quality_reviews
           (id, workflow_id, task_id, scope, reviewer_kind, reviewer_model,
            outcome, score, issues_json, evidence_json, fix_tasks_json,
            approval_status, audit_status, run_mode, created_at)
         VALUES (?, ?, NULL, 'workflow_final', 'light_ai', 'claude/claude-sonnet',
                 'passed', 0.95, '[]', '[]', '[]',
                 'not_required', 'recorded', 'dry-run', ?)`,
      ).run('qr_audit_1', 'wf_audit', tsQuality);

      db.prepare(
        `INSERT INTO workflow_control_state
           (workflow_id, state, requested_by, reason, created_at, updated_at)
         VALUES (?, 'paused', 'operator-diego', 'manual hold', ?, ?)`,
      ).run('wf_audit', tsWorkflowControl - 500, tsWorkflowControl);
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

  it('returns three entries from the three seeded sources sorted by ts DESC', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/audit?token=${token}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: AuditEntry[] };
    expect(body.entries.length).toBe(3);

    // DESC by ts: workflow_control (newest) -> quality -> permission (oldest).
    expect(body.entries[0]?.kind).toBe('workflow_control');
    expect(body.entries[1]?.kind).toBe('quality');
    expect(body.entries[2]?.kind).toBe('permission');

    expect(body.entries[0]).toEqual(expect.objectContaining({
      kind: 'workflow_control',
      ts: tsWorkflowControl,
      workflow_id: 'wf_audit',
      workspace: 'internal',
      actor: 'operator-diego',
      outcome: 'paused',
    }));
    expect(body.entries[1]).toEqual(expect.objectContaining({
      kind: 'quality',
      ts: tsQuality,
      workflow_id: 'wf_audit',
      workspace: 'internal',
      outcome: 'passed',
    }));
    expect(body.entries[2]).toEqual(expect.objectContaining({
      kind: 'permission',
      ts: tsPermission,
      workflow_id: 'wf_audit',
      workspace: 'internal',
      actor: 'operator-diego',
      outcome: 'approve',
    }));
  });

  it('filters by kind=permission and returns only the permission row', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/audit?token=${token}&kind=permission`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: AuditEntry[] };
    expect(body.entries.length).toBe(1);
    expect(body.entries[0]).toEqual(expect.objectContaining({
      kind: 'permission',
      workflow_id: 'wf_audit',
      outcome: 'approve',
    }));
  });
});
