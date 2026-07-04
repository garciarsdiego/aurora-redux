/**
 * Tier 0 Wave 4 0.3 — HITL gate orphan recovery sweep.
 *
 * Mirrors the patterns from `subagent-orphan-recovery.test.ts`:
 *   - in-memory DB seeded via raw SQL inserts
 *   - assert event side-effects via the `events` table
 *   - cover idempotency (second sweep is a no-op)
 *
 * Constraint: the function must NOT auto-resolve gates. It surfaces them via
 * a `hitl_gate_orphan_recovered` event so the operator can decide.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { recoverOrphanHitlGates } from '../../src/db/hitl-orphan-recovery.js';

const FIVE_MIN_MS = 5 * 60_000;

function makeDb(): Database.Database {
  return initDb(':memory:');
}

function insertWorkflow(db: Database.Database, wfId: string): void {
  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(wfId, 'internal', 'orphan hitl test', 'executing', Date.now());
}

function insertTask(db: Database.Database, taskId: string, wfId: string): void {
  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskId, wfId, 'task awaiting gate', 'llm_call', 'running', Date.now());
}

interface InsertGateOptions {
  status?: 'pending' | 'approved' | 'rejected' | 'modify';
  /** Positive ageMs => created `ageMs` ago. */
  ageMs?: number;
  contextJson?: string | null;
  channel?: string;
  taskId?: string | null;
}

function insertGate(
  db: Database.Database,
  gateId: string,
  wfId: string,
  opts: InsertGateOptions = {},
): void {
  const {
    status = 'pending',
    ageMs = FIVE_MIN_MS + 60_000, // 6 min old => orphan by default
    contextJson = null,
    channel = 'cli',
    taskId = null,
  } = opts;
  const created_at = Date.now() - ageMs;
  db.prepare(
    `INSERT INTO hitl_gates
       (id, workflow_id, task_id, gate_type, prompt, context_json,
        status, channel, created_at)
     VALUES (?, ?, ?, 'cli', 'awaiting operator', ?, ?, ?, ?)`,
  ).run(gateId, wfId, taskId, contextJson, status, channel, created_at);
}

function getEventsByType(
  db: Database.Database,
  type: string,
): Array<{ workflow_id: string; task_id: string | null; payload_json: string | null }> {
  return db
    .prepare(
      `SELECT workflow_id, task_id, payload_json
         FROM events
        WHERE type = ?
        ORDER BY id`,
    )
    .all(type) as Array<{ workflow_id: string; task_id: string | null; payload_json: string | null }>;
}

function getGateContext(db: Database.Database, gateId: string): Record<string, unknown> {
  const row = db
    .prepare(`SELECT context_json, status FROM hitl_gates WHERE id = ?`)
    .get(gateId) as { context_json: string | null; status: string } | undefined;
  if (!row?.context_json) return {};
  return JSON.parse(row.context_json) as Record<string, unknown>;
}

function getGateStatus(db: Database.Database, gateId: string): string {
  const row = db
    .prepare(`SELECT status FROM hitl_gates WHERE id = ?`)
    .get(gateId) as { status: string } | undefined;
  return row?.status ?? '<missing>';
}

describe('recoverOrphanHitlGates', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    delete process.env.OMNIFORGE_HITL_ORPHAN_AGE_MS;
  });

  afterEach(() => {
    db.close();
    delete process.env.OMNIFORGE_HITL_ORPHAN_AGE_MS;
  });

  it('returns zero counts when no gates exist', () => {
    const result = recoverOrphanHitlGates(db);
    expect(result).toEqual({ scanned: 0, surfaced: 0, skipped: 0, errors: [] });
  });

  it('surfaces an old pending gate and leaves a fresh pending gate alone', () => {
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1');
    insertTask(db, 'tk_2', 'wf_1');

    // Old (>5 min) => orphan
    insertGate(db, 'hg_old', 'wf_1', { ageMs: FIVE_MIN_MS + 120_000, taskId: 'tk_1' });
    // Fresh (<5 min) => not yet an orphan
    insertGate(db, 'hg_fresh', 'wf_1', { ageMs: 30_000, taskId: 'tk_2' });

    const result = recoverOrphanHitlGates(db);

    expect(result.scanned).toBe(1);
    expect(result.surfaced).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);

    const events = getEventsByType(db, 'hitl_gate_orphan_recovered');
    expect(events).toHaveLength(1);
    expect(events[0].workflow_id).toBe('wf_1');
    expect(events[0].task_id).toBe('tk_1');

    const payload = JSON.parse(events[0].payload_json ?? '{}') as Record<string, unknown>;
    expect(payload.gate_id).toBe('hg_old');
    expect(payload.workflow_id).toBe('wf_1');
    expect(payload.task_id).toBe('tk_1');
    expect(payload.channel).toBe('cli');
    expect(typeof payload.age_ms).toBe('number');
    expect(payload.age_ms as number).toBeGreaterThanOrEqual(FIVE_MIN_MS);

    // Fresh gate was NOT surfaced
    const freshContext = getGateContext(db, 'hg_fresh');
    expect(freshContext.recovery_attempted_at).toBeUndefined();

    // CONSTRAINT: do NOT auto-resolve — old gate is still pending after sweep
    expect(getGateStatus(db, 'hg_old')).toBe('pending');
    expect(getGateStatus(db, 'hg_fresh')).toBe('pending');
  });

  it('is idempotent — calling twice does not double-emit', () => {
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1');
    insertGate(db, 'hg_old', 'wf_1', { ageMs: FIVE_MIN_MS + 60_000, taskId: 'tk_1' });

    const first = recoverOrphanHitlGates(db);
    expect(first.surfaced).toBe(1);
    expect(first.skipped).toBe(0);

    // recovery_attempted_at written
    const ctx1 = getGateContext(db, 'hg_old');
    expect(typeof ctx1.recovery_attempted_at).toBe('number');

    const second = recoverOrphanHitlGates(db);
    expect(second.scanned).toBe(1); // still pending+old, still scanned
    expect(second.surfaced).toBe(0); // but not re-emitted
    expect(second.skipped).toBe(1);

    const events = getEventsByType(db, 'hitl_gate_orphan_recovered');
    expect(events).toHaveLength(1); // exactly one event total
  });

  it('ignores terminal gates regardless of age', () => {
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1');

    insertGate(db, 'hg_approved', 'wf_1', {
      status: 'approved',
      ageMs: FIVE_MIN_MS + 600_000,
      taskId: 'tk_1',
    });
    insertGate(db, 'hg_rejected', 'wf_1', {
      status: 'rejected',
      ageMs: FIVE_MIN_MS + 600_000,
      taskId: 'tk_1',
    });
    insertGate(db, 'hg_modify', 'wf_1', {
      status: 'modify',
      ageMs: FIVE_MIN_MS + 600_000,
      taskId: 'tk_1',
    });

    const result = recoverOrphanHitlGates(db);
    expect(result.scanned).toBe(0);
    expect(result.surfaced).toBe(0);
    expect(getEventsByType(db, 'hitl_gate_orphan_recovered')).toHaveLength(0);
  });

  it('honors OMNIFORGE_HITL_ORPHAN_AGE_MS env override', () => {
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1');
    // 60s old — would be fresh under the 5-min default
    insertGate(db, 'hg_borderline', 'wf_1', { ageMs: 60_000, taskId: 'tk_1' });

    // Without override — not surfaced
    const baseline = recoverOrphanHitlGates(db);
    expect(baseline.scanned).toBe(0);

    // With override (10s window) — surfaced
    process.env.OMNIFORGE_HITL_ORPHAN_AGE_MS = '10000';
    const tightened = recoverOrphanHitlGates(db);
    expect(tightened.scanned).toBe(1);
    expect(tightened.surfaced).toBe(1);
  });

  it('preserves existing context_json keys when adding recovery_attempted_at', () => {
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1');
    insertGate(db, 'hg_old', 'wf_1', {
      ageMs: FIVE_MIN_MS + 30_000,
      taskId: 'tk_1',
      contextJson: JSON.stringify({ mcp_feedback: 'prior note', custom_key: 42 }),
    });

    recoverOrphanHitlGates(db);

    const ctx = getGateContext(db, 'hg_old');
    expect(ctx.mcp_feedback).toBe('prior note');
    expect(ctx.custom_key).toBe(42);
    expect(typeof ctx.recovery_attempted_at).toBe('number');
  });

  it('tolerates corrupted context_json without throwing', () => {
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1');
    insertGate(db, 'hg_corrupt', 'wf_1', {
      ageMs: FIVE_MIN_MS + 60_000,
      contextJson: '{not valid json',
      taskId: 'tk_1',
    });

    const result = recoverOrphanHitlGates(db);
    expect(result.surfaced).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('supports a deterministic `now` override for tests', () => {
    insertWorkflow(db, 'wf_1');
    insertTask(db, 'tk_1', 'wf_1');

    const realNow = Date.now();
    const ancientCreatedAt = realNow - (FIVE_MIN_MS + 30_000);
    db.prepare(
      `INSERT INTO hitl_gates
         (id, workflow_id, task_id, gate_type, prompt, status, channel, created_at)
       VALUES (?, ?, ?, 'cli', 'prompt', 'pending', 'cli', ?)`,
    ).run('hg_at_t0', 'wf_1', 'tk_1', ancientCreatedAt);

    const result = recoverOrphanHitlGates(db, { now: realNow });
    expect(result.scanned).toBe(1);
    expect(result.surfaced).toBe(1);

    const payload = JSON.parse(
      getEventsByType(db, 'hitl_gate_orphan_recovered')[0].payload_json ?? '{}',
    ) as Record<string, unknown>;
    expect(payload.window_ms).toBe(FIVE_MIN_MS);
    expect(payload.age_ms as number).toBe(realNow - ancientCreatedAt);
  });
});
