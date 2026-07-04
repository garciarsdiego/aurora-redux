// C2 budget enforcement tests — round 4 (D-H2.075).
// Cobre cap enforcement, threshold alerts, pricing, e cost agg queries
// que o ciclo de fan-out gemini hung antes de entregar.
//
// Setup mínimo: in-memory better-sqlite3 + manual schema slice. Não usa
// `initDb` from production code para isolar a unidade.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  BudgetExceededError,
  BUDGET_THRESHOLD_PCTS,
  assertWorkflowBudgetAllowsModelCall,
  emitBudgetAlert,
  getWorkflowBudgetUsd,
  getWorkflowModelSpendUsd,
} from '../../src/v2/budget/control.js';
import {
  recordModelCall,
  getLedgerForWorkflow,
} from '../../src/v2/llm-ledger/store.js';
import {
  getPricingForModel,
  estimateCost,
  listPricingEntries,
} from '../../src/v2/llm-ledger/pricing.js';

// ── Test schema ───────────────────────────────────────────────────────────
//
// Subset of production schema needed for budget tests. We avoid initDb to
// keep tests fast and migration-independent. Columns mirror migrations
// 010_model_calls + the workflows/tasks/events/hitl_gates baselines.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace TEXT,
  status TEXT,
  objective TEXT,
  created_at INTEGER,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  name TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT,
  task_id TEXT,
  type TEXT,
  payload_json TEXT,
  timestamp INTEGER,
  chain_hash TEXT,
  prev_chain_hash TEXT
);
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  workflow_id TEXT,
  task_id TEXT,
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  latency_ms INTEGER,
  source TEXT,
  status TEXT,
  created_at INTEGER
);
`;

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(
    'INSERT INTO workflows (id, workspace, status, objective, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run('wf_test', 'internal', 'executing', 'test workflow', Date.now());
  db.prepare(
    'INSERT INTO tasks (id, workflow_id, name, status) VALUES (?, ?, ?, ?)',
  ).run('tk_test', 'wf_test', 'Test task', 'running');
  return db;
}

function insertModelCall(
  db: Database.Database,
  cost: number,
  inputTokens = 1000,
  outputTokens = 500,
  workflowId = 'wf_test',
): void {
  recordModelCall(db, {
    workflowId,
    taskId: workflowId === 'wf_test' ? 'tk_test' : 'tk_other',
    provider: 'cc',
    model: 'cc/claude-sonnet-4-6',
    inputTokens,
    outputTokens,
    costUsd: cost,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('C2 budget enforcement', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    else process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = originalEnv;
  });

  describe('getWorkflowBudgetUsd()', () => {
    it('returns null when env var is unset (back-compat: no enforcement)', () => {
      delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
      expect(getWorkflowBudgetUsd()).toBeNull();
    });

    it('returns parsed number when env var is set', () => {
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.5';
      expect(getWorkflowBudgetUsd()).toBe(1.5);
    });

    it('returns null for malformed input', () => {
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = 'not-a-number';
      expect(getWorkflowBudgetUsd()).toBeNull();
    });

    it('returns null for negative values', () => {
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '-1';
      expect(getWorkflowBudgetUsd()).toBeNull();
    });
  });

  describe('assertWorkflowBudgetAllowsModelCall()', () => {
    it('passes silently when cap is null (back-compat)', () => {
      delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
      const db = setupDb();
      insertModelCall(db, 999); // way over any reasonable cap
      expect(() =>
        assertWorkflowBudgetAllowsModelCall(db, 'wf_test', 'tk_test'),
      ).not.toThrow();
    });

    it('passes when ledger total is under cap', () => {
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
      const db = setupDb();
      insertModelCall(db, 0.4);
      expect(() =>
        assertWorkflowBudgetAllowsModelCall(db, 'wf_test', 'tk_test'),
      ).not.toThrow();
    });

    it('throws BudgetExceededError when ledger total exceeds cap', () => {
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
      const db = setupDb();
      insertModelCall(db, 1.5);
      expect(() =>
        assertWorkflowBudgetAllowsModelCall(db, 'wf_test', 'tk_test'),
      ).toThrow(BudgetExceededError);
    });

    it('BudgetExceededError carries workflowId + budgetUsd + spentUsd context', () => {
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
      const db = setupDb();
      insertModelCall(db, 1.2);
      try {
        assertWorkflowBudgetAllowsModelCall(db, 'wf_test', 'tk_test');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetExceededError);
        const bee = err as BudgetExceededError;
        expect(bee.workflowId).toBe('wf_test');
        expect(bee.budgetUsd).toBe(1.0);
        expect(bee.spentUsd).toBeCloseTo(1.2, 5);
      }
    });
  });

  describe('emitBudgetAlert() threshold dedup', () => {
    it('emits 50% event when crossing 50% threshold', () => {
      const db = setupDb();
      emitBudgetAlert(db, 'wf_test', 0.55, 1.0);
      const events = db
        .prepare("SELECT payload_json FROM events WHERE type = 'budget_threshold_crossed'")
        .all() as Array<{ payload_json: string }>;
      expect(events.length).toBe(1);
      const payload = JSON.parse(events[0]!.payload_json) as { threshold_pct: number };
      expect(payload.threshold_pct).toBe(50);
    });

    it('does not re-emit same threshold on second call', () => {
      const db = setupDb();
      emitBudgetAlert(db, 'wf_test', 0.55, 1.0);
      emitBudgetAlert(db, 'wf_test', 0.60, 1.0);
      const count = (
        db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'budget_threshold_crossed'")
          .get() as { c: number }
      ).c;
      expect(count).toBe(1);
    });

    it('emits cumulative thresholds 50/75/90/100 as cap is crossed', () => {
      const db = setupDb();
      emitBudgetAlert(db, 'wf_test', 0.51, 1.0); // 51% → 50
      emitBudgetAlert(db, 'wf_test', 0.76, 1.0); // 76% → 75
      emitBudgetAlert(db, 'wf_test', 0.91, 1.0); // 91% → 90
      emitBudgetAlert(db, 'wf_test', 1.01, 1.0); // 101% → 100
      const events = db
        .prepare(
          "SELECT payload_json FROM events WHERE type = 'budget_threshold_crossed' ORDER BY id",
        )
        .all() as Array<{ payload_json: string }>;
      const pcts = events.map(
        (e) => (JSON.parse(e.payload_json) as { threshold_pct: number }).threshold_pct,
      );
      expect(pcts).toEqual([50, 75, 90, 100]);
    });

    it('skips emission when cap is 0 or negative (degenerate)', () => {
      const db = setupDb();
      emitBudgetAlert(db, 'wf_test', 0.5, 0);
      const count = (
        db
          .prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'budget_threshold_crossed'")
          .get() as { c: number }
      ).c;
      expect(count).toBe(0);
    });

    it('exposes the canonical threshold list', () => {
      expect([...BUDGET_THRESHOLD_PCTS]).toEqual([50, 75, 90, 100]);
    });
  });

  describe('getWorkflowModelSpendUsd()', () => {
    it('returns 0 when no calls', () => {
      const db = setupDb();
      expect(getWorkflowModelSpendUsd(db, 'wf_test')).toBe(0);
    });

    it('sums all calls for the workflow', () => {
      const db = setupDb();
      insertModelCall(db, 0.1);
      insertModelCall(db, 0.2);
      insertModelCall(db, 0.3);
      expect(getWorkflowModelSpendUsd(db, 'wf_test')).toBeCloseTo(0.6, 5);
    });

    it('isolates by workflow_id', () => {
      const db = setupDb();
      insertModelCall(db, 0.5);
      // Insert a call for a different workflow_id (also need a workflow row)
      db.prepare(
        'INSERT INTO workflows (id, workspace, status, objective, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run('wf_other', 'internal', 'executing', 'other', Date.now());
      insertModelCall(db, 99, 100, 50, 'wf_other');
      expect(getWorkflowModelSpendUsd(db, 'wf_test')).toBeCloseTo(0.5, 5);
      expect(getWorkflowModelSpendUsd(db, 'wf_other')).toBeCloseTo(99, 5);
    });
  });
});

describe('C2 pricing table', () => {
  it('cc/* maps to $3 input / $15 output per Mtok', async () => {
    const p = await getPricingForModel('cc/claude-sonnet-4-6', {fallbackOnly: true});
    expect(p.inputPerMtok).toBe(3);
    expect(p.outputPerMtok).toBe(15);
  });

  it('cx/* maps to $1.25 input / $10 output per Mtok', async () => {
    const p = await getPricingForModel('cx/gpt-5.5', {fallbackOnly: true});
    expect(p.inputPerMtok).toBe(1.25);
    expect(p.outputPerMtok).toBe(10);
  });

  it('gemini-cli/* maps to $1.25 input / $10 output per Mtok', async () => {
    const p = await getPricingForModel('gemini-cli/gemini-3.1-pro-preview', {fallbackOnly: true});
    expect(p.inputPerMtok).toBe(1.25);
    expect(p.outputPerMtok).toBe(10);
  });

  it('unknown prefix falls back to default $1 / $3 per Mtok', async () => {
    const p = await getPricingForModel('opencode-go/qwen-3.6-plus', {fallbackOnly: true});
    expect(p.inputPerMtok).toBe(1);
    expect(p.outputPerMtok).toBe(3);
  });

  it('estimateCost computes correct total for cc/* model', async () => {
    // 1M input tokens at $3/M = $3.00; 500K output at $15/M = $7.50; total = $10.50
    const cost = await estimateCost('cc/claude-sonnet-4-6', 1_000_000, 500_000);
    expect(cost).toBeCloseTo(10.5, 5);
  });

  it('listPricingEntries returns at least cc/cx/gemini-cli rows', () => {
    const entries = listPricingEntries();
    const prefixes = entries.map((e) => e.prefix);
    expect(prefixes).toContain('cc/');
    expect(prefixes).toContain('cx/');
    expect(prefixes).toContain('gemini-cli/');
  });
});

describe('C2 ledger summary', () => {
  it('returns zeros for empty ledger', () => {
    const db = setupDb();
    const summary = getLedgerForWorkflow(db, 'wf_test');
    expect(summary.totalUsd).toBe(0);
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
  });

  it('aggregates calls correctly', () => {
    const db = setupDb();
    insertModelCall(db, 0.1, 1000, 500);
    insertModelCall(db, 0.2, 2000, 1000);
    const summary = getLedgerForWorkflow(db, 'wf_test');
    expect(summary.totalUsd).toBeCloseTo(0.3, 5);
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalInputTokens).toBe(3000);
    expect(summary.totalOutputTokens).toBe(1500);
  });
});
