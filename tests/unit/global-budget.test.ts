/**
 * Tests for the global/daily aggregate spend ceiling in src/v2/budget/control.ts
 * (Aurora-parity Wave 0). Unlike the per-workflow budget, these cap spend ACROSS
 * all workflows, block the next LLM call, and fire a one-shot Telegram alert.
 *
 * Covered:
 *   - getDailyBudgetUsd / getMaxSpendUsd env parsing
 *   - getGlobalModelSpendUsd: all-time vs rolling-window (created_at filter)
 *   - assertGlobalBudgetAllowsModelCall: no-op unset, daily breach, total breach,
 *     boundary-inclusive, rolling-window excludes old spend, one-shot dedupe event
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertGlobalBudgetAllowsModelCall,
  getDailyBudgetUsd,
  getGlobalModelSpendUsd,
  getMaxSpendUsd,
  GlobalBudgetExceededError,
} from '../../src/v2/budget/control.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, status TEXT, created_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workflow_id TEXT, workspace TEXT, status TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT, task_id TEXT, workspace TEXT,
      type TEXT NOT NULL, payload_json TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE TABLE model_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT, task_id TEXT, model TEXT, source TEXT,
      cost_usd REAL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    -- insertEvent → deepRedactPayload scans STRING payload values against the
    -- secrets vault (our payload carries a 'scope' string). Empty table = no redaction.
    CREATE TABLE secrets (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, key TEXT NOT NULL,
      value_encrypted BLOB NOT NULL, iv BLOB NOT NULL, auth_tag BLOB NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace, key)
    );
  `);
  db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?, ?, ?, ?)')
    .run('wf-1', 'internal', 'executing', Date.now());
  db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?, ?, ?, ?)')
    .run('wf-2', 'internal', 'executing', Date.now());
  return db;
}

function spendAt(db: Database.Database, workflowId: string, costUsd: number, createdAt: number): void {
  db.prepare('INSERT INTO model_calls(workflow_id, cost_usd, created_at) VALUES (?, ?, ?)')
    .run(workflowId, costUsd, createdAt);
}

function listEvents(db: Database.Database): Array<{ type: string; payload: Record<string, unknown> | null }> {
  const rows = db.prepare('SELECT type, payload_json FROM events ORDER BY id ASC').all() as Array<{
    type: string;
    payload_json: string | null;
  }>;
  return rows.map((r) => ({ type: r.type, payload: r.payload_json ? JSON.parse(r.payload_json) : null }));
}

const ENV_KEYS = ['OMNIFORGE_DAILY_BUDGET_USD', 'OMNIFORGE_MAX_SPEND_USD'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.TELEGRAM_NOTIFY_SILENT = '1'; // suppress the missing-creds warning
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('getDailyBudgetUsd / getMaxSpendUsd', () => {
  it('return null when unset', () => {
    expect(getDailyBudgetUsd()).toBeNull();
    expect(getMaxSpendUsd()).toBeNull();
  });
  it('parse valid numbers and reject NaN/negative', () => {
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '5';
    process.env.OMNIFORGE_MAX_SPEND_USD = '100';
    expect(getDailyBudgetUsd()).toBe(5);
    expect(getMaxSpendUsd()).toBe(100);
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '-1';
    process.env.OMNIFORGE_MAX_SPEND_USD = 'x';
    expect(getDailyBudgetUsd()).toBeNull();
    expect(getMaxSpendUsd()).toBeNull();
  });
});

describe('getGlobalModelSpendUsd', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('sums across ALL workflows when no window given', () => {
    const now = Date.now();
    spendAt(db, 'wf-1', 1.0, now);
    spendAt(db, 'wf-2', 2.5, now);
    expect(getGlobalModelSpendUsd(db)).toBeCloseTo(3.5, 5);
  });

  it('excludes spend older than the rolling window', () => {
    const now = Date.now();
    spendAt(db, 'wf-1', 9.0, now - 2 * DAY_MS); // 2 days ago — excluded
    spendAt(db, 'wf-1', 1.0, now);              // today — counted
    expect(getGlobalModelSpendUsd(db, now - DAY_MS)).toBeCloseTo(1.0, 5);
    expect(getGlobalModelSpendUsd(db)).toBeCloseTo(10.0, 5); // all-time still sees both
  });
});

describe('assertGlobalBudgetAllowsModelCall', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('no-ops when neither ceiling is configured', () => {
    spendAt(db, 'wf-1', 1000, Date.now());
    expect(() => assertGlobalBudgetAllowsModelCall(db, 'wf-1', 't1')).not.toThrow();
    expect(listEvents(db)).toHaveLength(0);
  });

  it('throws GlobalBudgetExceededError(daily) + emits one event when 24h spend exceeds daily cap', () => {
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '0.01';
    const now = Date.now();
    spendAt(db, 'wf-2', 0.05, now); // another workflow's spend counts toward the global daily total
    expect(() => assertGlobalBudgetAllowsModelCall(db, 'wf-1', 't1', now)).toThrow(GlobalBudgetExceededError);
    const events = listEvents(db).filter((e) => e.type === 'global_budget_exceeded');
    expect(events).toHaveLength(1);
    expect(events[0].payload?.scope).toBe('daily');
  });

  it('does NOT trip the daily cap on spend older than 24h', () => {
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '0.01';
    const now = Date.now();
    spendAt(db, 'wf-1', 5.0, now - 2 * DAY_MS); // 2 days ago — outside the window
    expect(() => assertGlobalBudgetAllowsModelCall(db, 'wf-1', 't1', now)).not.toThrow();
  });

  it('throws GlobalBudgetExceededError(total) when all-time spend exceeds the max cap', () => {
    process.env.OMNIFORGE_MAX_SPEND_USD = '1';
    const now = Date.now();
    spendAt(db, 'wf-1', 0.6, now - 5 * DAY_MS); // old but counts toward all-time
    spendAt(db, 'wf-2', 0.6, now);
    let err: unknown;
    try { assertGlobalBudgetAllowsModelCall(db, 'wf-1', 't1', now); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GlobalBudgetExceededError);
    expect((err as GlobalBudgetExceededError).scope).toBe('total');
  });

  it('treats spend == cap as allowed (boundary inclusive)', () => {
    process.env.OMNIFORGE_MAX_SPEND_USD = '2';
    spendAt(db, 'wf-1', 2, Date.now());
    expect(() => assertGlobalBudgetAllowsModelCall(db, 'wf-1', 't1')).not.toThrow();
  });

  it('emits only ONE breach event across repeated blocked calls in the same window', () => {
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '0.01';
    const now = Date.now();
    spendAt(db, 'wf-1', 1.0, now);
    for (let i = 0; i < 3; i++) {
      expect(() => assertGlobalBudgetAllowsModelCall(db, 'wf-1', `t${i}`, now)).toThrow();
    }
    // The throw fires every time, but the dedupe means exactly one audit event
    // (and one Telegram alert) per scope+window.
    const events = listEvents(db).filter((e) => e.type === 'global_budget_exceeded');
    expect(events).toHaveLength(1);
  });

  it('pre-reserves the upcoming call cost (blocks before RECORDED spend exceeds the cap)', () => {
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '5';
    const now = Date.now();
    spendAt(db, 'wf-1', 3, now); // recorded 3 ≤ 5 — backward-looking would allow it
    // A $3 pending call projects to 6 > 5 → must block NOW (forward-looking).
    expect(() => assertGlobalBudgetAllowsModelCall(db, 'wf-1', 't1', now, 3)).toThrow(GlobalBudgetExceededError);
    // …but with no estimate it stays allowed (3 ≤ 5) — proves default-0 is backward-compatible.
    expect(() => assertGlobalBudgetAllowsModelCall(db, 'wf-1', 't2', now, 0)).not.toThrow();
  });
});
