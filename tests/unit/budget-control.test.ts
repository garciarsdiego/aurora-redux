/**
 * Tests for src/v2/budget/control.ts.
 *
 * Module is small but central: governs whether a workflow is allowed to
 * issue another model call, emits threshold crossings (50/75/90/100 %),
 * and never re-emits the same threshold twice. Covered cases:
 *   - getWorkflowBudgetUsd: env parsing (number, NaN, negative)
 *   - getWorkflowModelSpendUsd: empty / aggregated rows
 *   - emitBudgetThresholdAlert: emits each threshold once, skips dups, no-op on cap=0
 *   - assertWorkflowBudgetAllowsModelCall: throws over budget, silent under
 *
 * Origin: AUDIT-2026-05-05.md §3 gaps (budget/control without tests).
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertWorkflowBudgetAllowsModelCall,
  emitBudgetThresholdAlert,
  getWorkflowBudgetUsd,
  getWorkflowModelSpendUsd,
} from '../../src/v2/budget/control.js';

// ── In-memory schema scaffolding ─────────────────────────────────────────────
// We mirror only the columns the module reads/writes; the production schema
// has more columns + indexes but we don't need them for unit tests.

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Schema mirrors the production columns insertEvent / model_calls reads from.
  // workspaces column is required by resolveWorkspace in src/db/persist.ts.
  db.exec(`
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      status TEXT,
      created_at INTEGER
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workflow_id TEXT, workspace TEXT, status TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT,
      task_id TEXT,
      workspace TEXT,
      type TEXT NOT NULL,
      payload_json TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE TABLE model_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT,
      task_id TEXT,
      cost_usd REAL DEFAULT 0,
      ts INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);
  // Seed a workflow row so insertEvent can resolve workspace.
  db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?, ?, ?, ?)')
    .run('wf-1', 'internal', 'executing', Date.now());
  return db;
}

function recordSpend(db: Database.Database, workflowId: string, costUsd: number): void {
  db.prepare('INSERT INTO model_calls(workflow_id, cost_usd) VALUES (?, ?)').run(workflowId, costUsd);
}

function listEvents(db: Database.Database, workflowId: string): Array<{ type: string; payload: unknown }> {
  const rows = db
    .prepare('SELECT type, payload_json FROM events WHERE workflow_id = ? ORDER BY id ASC')
    .all(workflowId) as Array<{ type: string; payload_json: string | null }>;
  return rows.map((r) => ({ type: r.type, payload: r.payload_json ? JSON.parse(r.payload_json) : null }));
}

describe('getWorkflowBudgetUsd', () => {
  const ORIGINAL = process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    else process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = ORIGINAL;
  });

  it('returns null when env var unset', () => {
    delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    expect(getWorkflowBudgetUsd()).toBeNull();
  });

  it('returns parsed number when valid', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '12.5';
    expect(getWorkflowBudgetUsd()).toBe(12.5);
  });

  it('returns null on NaN', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = 'not-a-number';
    expect(getWorkflowBudgetUsd()).toBeNull();
  });

  it('returns null on negative values', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '-5';
    expect(getWorkflowBudgetUsd()).toBeNull();
  });

  it('accepts 0 (free tier)', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '0';
    expect(getWorkflowBudgetUsd()).toBe(0);
  });
});

describe('getWorkflowModelSpendUsd', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('returns 0 when no model calls exist', () => {
    expect(getWorkflowModelSpendUsd(db, 'wf-1')).toBe(0);
  });

  it('sums all model_calls rows for the workflow', () => {
    recordSpend(db, 'wf-1', 0.10);
    recordSpend(db, 'wf-1', 0.25);
    recordSpend(db, 'wf-1', 1.65);
    recordSpend(db, 'wf-2', 99.0); // different workflow — must not be counted
    expect(getWorkflowModelSpendUsd(db, 'wf-1')).toBeCloseTo(2.0, 5);
  });

  it('handles a NULL sum (legacy schema with no rows)', () => {
    expect(getWorkflowModelSpendUsd(db, 'wf-nonexistent')).toBe(0);
  });
});

describe('emitBudgetThresholdAlert', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('no-ops when capUsd <= 0', () => {
    emitBudgetThresholdAlert(db, 'wf-1', 5, 0);
    expect(listEvents(db, 'wf-1')).toHaveLength(0);
  });

  it('emits 50% threshold when usage crosses it', () => {
    emitBudgetThresholdAlert(db, 'wf-1', 5, 10); // 50%
    const events = listEvents(db, 'wf-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('budget_threshold_crossed');
    expect((events[0].payload as { threshold_pct: number }).threshold_pct).toBe(50);
  });

  it('emits 50/75/90/100 in one call when usage is above all four', () => {
    emitBudgetThresholdAlert(db, 'wf-1', 10, 10); // 100%
    const events = listEvents(db, 'wf-1');
    const thresholds = events.map((e) => (e.payload as { threshold_pct: number }).threshold_pct).sort((a, b) => a - b);
    expect(thresholds).toEqual([50, 75, 90, 100]);
  });

  it('does NOT re-emit thresholds already crossed', () => {
    emitBudgetThresholdAlert(db, 'wf-1', 6, 10); // emits 50
    emitBudgetThresholdAlert(db, 'wf-1', 8, 10); // emits 75 (50 already there)
    const events = listEvents(db, 'wf-1');
    expect(events).toHaveLength(2);
    const thresholds = events.map((e) => (e.payload as { threshold_pct: number }).threshold_pct).sort((a, b) => a - b);
    expect(thresholds).toEqual([50, 75]);
  });

  it('skips thresholds the workflow has not crossed yet', () => {
    emitBudgetThresholdAlert(db, 'wf-1', 4, 10); // 40% — none of the gates fire
    expect(listEvents(db, 'wf-1')).toHaveLength(0);
  });
});

describe('assertWorkflowBudgetAllowsModelCall', () => {
  let db: Database.Database;
  const ORIGINAL = process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => {
    db.close();
    if (ORIGINAL === undefined) delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    else process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = ORIGINAL;
  });

  it('no-ops when no budget configured', () => {
    delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    recordSpend(db, 'wf-1', 100);
    expect(() => assertWorkflowBudgetAllowsModelCall(db, 'wf-1', 'task-1')).not.toThrow();
    expect(listEvents(db, 'wf-1')).toHaveLength(0);
  });

  it('passes silently when spend <= budget', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '5';
    recordSpend(db, 'wf-1', 3);
    expect(() => assertWorkflowBudgetAllowsModelCall(db, 'wf-1', 'task-1')).not.toThrow();
    expect(listEvents(db, 'wf-1')).toHaveLength(0);
  });

  it('throws + emits workflow_budget_exceeded when spend > budget', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1';
    recordSpend(db, 'wf-1', 1.50);
    expect(() => assertWorkflowBudgetAllowsModelCall(db, 'wf-1', 'task-1')).toThrow(/budget exceeded/i);
    const events = listEvents(db, 'wf-1');
    expect(events.find((e) => e.type === 'workflow_budget_exceeded')).toBeTruthy();
  });

  it('treats spend == budget as OK (boundary inclusive)', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '2';
    recordSpend(db, 'wf-1', 2);
    expect(() => assertWorkflowBudgetAllowsModelCall(db, 'wf-1', 'task-1')).not.toThrow();
  });

  it('pre-reserves the pending call cost (forward-looking, default 0 is backward-compatible)', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '5';
    recordSpend(db, 'wf-1', 3); // recorded 3 ≤ 5
    // a $3 pending call projects to 6 > 5 → blocks now
    expect(() => assertWorkflowBudgetAllowsModelCall(db, 'wf-1', 'task-1', 3)).toThrow(/budget exceeded/i);
    // no estimate → unchanged (3 ≤ 5)
    expect(() => assertWorkflowBudgetAllowsModelCall(db, 'wf-1', 'task-1', 0)).not.toThrow();
  });
});
