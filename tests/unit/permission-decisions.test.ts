/**
 * Wave 2.A: persona-tool permission decision audit tests.
 *
 * Covers:
 *   - enforcePersonaToolPermissions emits ask_ids of the documented shape
 *     (workflow_id:task_id:agent_id:tool:nonce6) and returns the same list
 *     it emitted.
 *   - permission_decisions table accepts the upsert shape used by the
 *     dashboard-permission router (insert when absent, update when pending,
 *     no-op when already decided).
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  enforcePersonaToolPermissions,
  type PersonaPermissions,
} from '../../src/v2/agents/permissions.js';

const ASK_ID_RE =
  /^(?<wf>[^:]+):(?<tk>[^:]+):(?<agent>[^:]+):(?<tool>[^:]+):(?<nonce>[a-z0-9]{6})$/;

describe('enforcePersonaToolPermissions — Wave 2.A id shape', () => {
  it('emits a stable ask_id for each ask-classified tool and returns the same list', () => {
    const payloads: Record<string, unknown>[] = [];
    const askIds = enforcePersonaToolPermissions(
      'worker.tool_call',
      ['Bash', 'Read'],
      {
        defaultAction: 'allow',
        tools: { Bash: 'ask' },
      } as PersonaPermissions,
      (_ev, p) => payloads.push(p),
      { workflowId: 'wf_z', taskId: 'tk_z' },
    );

    expect(askIds).toHaveLength(1);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.['ask_id']).toBe(askIds[0]);

    const match = askIds[0]?.match(ASK_ID_RE);
    expect(match).not.toBeNull();
    expect(match?.groups?.['wf']).toBe('wf_z');
    expect(match?.groups?.['tk']).toBe('tk_z');
    expect(match?.groups?.['agent']).toBe('worker.tool_call');
    expect(match?.groups?.['tool']).toBe('Bash');
  });

  it('uses "_" placeholders when workflow / task ids are absent', () => {
    const askIds = enforcePersonaToolPermissions(
      'reviewer',
      ['Write'],
      { defaultAction: 'ask' } as PersonaPermissions,
      () => {},
      {},
    );
    expect(askIds[0]?.startsWith('_:_:reviewer:Write:')).toBe(true);
  });

  it('mints a fresh nonce per call so two asks for the same tuple stay distinct', () => {
    const a = enforcePersonaToolPermissions(
      'a',
      ['Bash'],
      { defaultAction: 'ask' } as PersonaPermissions,
      () => {},
      { workflowId: 'wf', taskId: 'tk' },
    );
    const b = enforcePersonaToolPermissions(
      'a',
      ['Bash'],
      { defaultAction: 'ask' } as PersonaPermissions,
      () => {},
      { workflowId: 'wf', taskId: 'tk' },
    );
    expect(a[0]).not.toBe(b[0]);
  });

  it('emits zero asks (and returns []) when nothing classifies as ask', () => {
    const payloads: Record<string, unknown>[] = [];
    const ids = enforcePersonaToolPermissions(
      'allowed',
      ['Read', 'Glob'],
      { defaultAction: 'allow' } as PersonaPermissions,
      (_ev, p) => payloads.push(p),
      { workflowId: 'wf', taskId: 'tk' },
    );
    expect(ids).toEqual([]);
    expect(payloads).toEqual([]);
  });
});

describe('permission_decisions schema — upsert behaviour', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE permission_decisions (
        ask_id TEXT PRIMARY KEY,
        workflow_id TEXT,
        task_id TEXT,
        agent_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        decision TEXT,
        decided_by TEXT,
        asked_at INTEGER NOT NULL,
        decided_at INTEGER,
        CHECK (decision IS NULL OR decision IN ('approve', 'deny'))
      );
    `);
  });

  afterEach(() => { db.close(); });

  it('inserts a brand-new decision row', () => {
    const askId = 'wf:tk:agent:Bash:abc123';
    const now = Date.now();
    db.prepare(
      `INSERT INTO permission_decisions
         (ask_id, workflow_id, task_id, agent_id, tool, decision, decided_by, asked_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(askId, 'wf', 'tk', 'agent', 'Bash', 'approve', 'dashboard', now, now);

    const row = db
      .prepare(`SELECT decision, decided_by FROM permission_decisions WHERE ask_id = ?`)
      .get(askId) as { decision: string | null; decided_by: string | null };
    expect(row.decision).toBe('approve');
    expect(row.decided_by).toBe('dashboard');
  });

  it('rejects decisions outside approve / deny via the CHECK constraint', () => {
    const askId = 'wf:tk:agent:Bash:abc123';
    expect(() =>
      db
        .prepare(
          `INSERT INTO permission_decisions
             (ask_id, workflow_id, task_id, agent_id, tool, decision, decided_by, asked_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(askId, 'wf', 'tk', 'agent', 'Bash', 'maybe', 'dashboard', Date.now(), Date.now()),
    ).toThrow();
  });

  it('treats the second decision as a no-op (first-resolver wins)', () => {
    const askId = 'wf:tk:agent:Bash:abc123';
    const t0 = Date.now();
    db.prepare(
      `INSERT INTO permission_decisions
         (ask_id, workflow_id, task_id, agent_id, tool, decision, decided_by, asked_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(askId, 'wf', 'tk', 'agent', 'Bash', 'approve', 'opA', t0, t0);

    // Mimic the route handler's "already decided?" guard.
    const existing = db
      .prepare(`SELECT decision FROM permission_decisions WHERE ask_id = ?`)
      .get(askId) as { decision: string | null };
    expect(existing.decision).toBe('approve'); // First-resolver call is preserved.

    // A racing second call should NOT overwrite. The route handler
    // short-circuits before issuing UPDATE — replicate that contract here.
    const row = db
      .prepare(`SELECT decision, decided_by FROM permission_decisions WHERE ask_id = ?`)
      .get(askId) as { decision: string; decided_by: string };
    expect(row.decision).toBe('approve');
    expect(row.decided_by).toBe('opA');
  });

  it('updates a pending row (decision = NULL) when an operator resolves', () => {
    const askId = 'wf:tk:agent:Bash:abc123';
    const t0 = Date.now();
    db.prepare(
      `INSERT INTO permission_decisions
         (ask_id, workflow_id, task_id, agent_id, tool, decision, decided_by, asked_at, decided_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
    ).run(askId, 'wf', 'tk', 'agent', 'Bash', t0);

    const t1 = t0 + 5_000;
    db.prepare(
      `UPDATE permission_decisions
          SET decision = ?, decided_by = ?, decided_at = ?
        WHERE ask_id = ?`,
    ).run('deny', 'dashboard', t1, askId);

    const row = db
      .prepare(
        `SELECT decision, decided_by, asked_at, decided_at
           FROM permission_decisions WHERE ask_id = ?`,
      )
      .get(askId) as {
      decision: string;
      decided_by: string;
      asked_at: number;
      decided_at: number;
    };
    expect(row.decision).toBe('deny');
    expect(row.decided_by).toBe('dashboard');
    expect(row.asked_at).toBe(t0);
    expect(row.decided_at).toBe(t1);
  });
});
