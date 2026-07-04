// Aurora-parity Wave 2 — wire CostAwareRouter into the live path (opt-in).
// Covers the leaf pieces: config flags, remaining-budget headroom, and the
// selectModel within_budget signal that drives opt-in enforce.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  getCostRouterEnabled,
  getCostRouterEnforce,
  getCostRouterMinQuality,
} from '../../src/utils/config.js';
import { getRemainingBudgetHeadroomUsd } from '../../src/v2/budget/control.js';
import { recordModelCall } from '../../src/v2/llm-ledger/store.js';

// Mock ONLY the streaming caller (separate module from omniroute-call.ts, which
// stays real so the non-streaming routing tests exercise the actual cost-router
// path). The streaming branch of runOmniRouteTask must NOT route — this stub
// yields a fixed chunk over no network so the streaming-no-route assertion below
// proves selectModel is never consulted for a stream_output=true task.
vi.mock('../../src/utils/omniroute-stream.js', () => ({
  callOmnirouteStream: async function* () {
    yield 'streamed-ok';
  },
}));

// ── config flags ────────────────────────────────────────────────────────────

describe('cost-router config flags', () => {
  const KEYS = [
    'OMNIFORGE_COST_ROUTER',
    'OMNIFORGE_COST_ROUTER_ENFORCE',
    'OMNIFORGE_COST_ROUTER_MIN_QUALITY',
  ] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('getCostRouterEnabled defaults to false (opt-in)', () => {
    expect(getCostRouterEnabled()).toBe(false);
  });

  it('getCostRouterEnabled accepts true/1', () => {
    process.env.OMNIFORGE_COST_ROUTER = 'true';
    expect(getCostRouterEnabled()).toBe(true);
    process.env.OMNIFORGE_COST_ROUTER = '1';
    expect(getCostRouterEnabled()).toBe(true);
    process.env.OMNIFORGE_COST_ROUTER = 'false';
    expect(getCostRouterEnabled()).toBe(false);
  });

  it('getCostRouterEnforce defaults to false', () => {
    expect(getCostRouterEnforce()).toBe(false);
    process.env.OMNIFORGE_COST_ROUTER_ENFORCE = 'true';
    expect(getCostRouterEnforce()).toBe(true);
  });

  it('getCostRouterMinQuality defaults to 0.7 and clamps to [0,1]', () => {
    expect(getCostRouterMinQuality()).toBeCloseTo(0.7, 5);
    process.env.OMNIFORGE_COST_ROUTER_MIN_QUALITY = '0.9';
    expect(getCostRouterMinQuality()).toBeCloseTo(0.9, 5);
    process.env.OMNIFORGE_COST_ROUTER_MIN_QUALITY = '5';
    expect(getCostRouterMinQuality()).toBe(1);
    process.env.OMNIFORGE_COST_ROUTER_MIN_QUALITY = '-3';
    expect(getCostRouterMinQuality()).toBe(0);
  });
});

// ── remaining-budget headroom ─────────────────────────────────────────────────

const BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, workspace TEXT, status TEXT, objective TEXT, created_at INTEGER, completed_at INTEGER);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workflow_id TEXT, name TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT, task_id TEXT, type TEXT,
  payload_json TEXT, timestamp INTEGER, chain_hash TEXT, prev_chain_hash TEXT
);
CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY, workflow_id TEXT, task_id TEXT, provider TEXT, model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER,
  source TEXT, status TEXT, created_at INTEGER
);
`;

function budgetDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(BUDGET_SCHEMA);
  db.prepare('INSERT INTO workflows (id, workspace, status, objective, created_at) VALUES (?,?,?,?,?)')
    .run('wf_test', 'internal', 'executing', 'o', Date.now());
  db.prepare('INSERT INTO tasks (id, workflow_id, name, status) VALUES (?,?,?,?)')
    .run('tk_test', 'wf_test', 'T', 'running');
  return db;
}

function spend(db: Database.Database, cost: number): void {
  recordModelCall(db, {
    workflowId: 'wf_test',
    taskId: 'tk_test',
    provider: 'cc',
    model: 'cc/claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    costUsd: cost,
  });
}

describe('getRemainingBudgetHeadroomUsd', () => {
  const KEYS = [
    'OMNIFORGE_WORKFLOW_BUDGET_USD',
    'OMNIFORGE_DAILY_BUDGET_USD',
    'OMNIFORGE_MAX_SPEND_USD',
  ] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns null when no budget cap is set (no constraint)', () => {
    const db = budgetDb();
    spend(db, 0.5);
    expect(getRemainingBudgetHeadroomUsd(db, 'wf_test')).toBeNull();
    db.close();
  });

  it('returns workflow-cap headroom (cap minus workflow spend)', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
    const db = budgetDb();
    spend(db, 0.3);
    expect(getRemainingBudgetHeadroomUsd(db, 'wf_test')).toBeCloseTo(0.7, 5);
    db.close();
  });

  it('returns the MIN across all set caps', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '0.5';
    const db = budgetDb();
    spend(db, 0.3); // workflow remaining 0.7; daily remaining 0.2
    expect(getRemainingBudgetHeadroomUsd(db, 'wf_test')).toBeCloseTo(0.2, 5);
    db.close();
  });

  it('floors at 0 when already over a cap', () => {
    process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
    const db = budgetDb();
    spend(db, 1.5);
    expect(getRemainingBudgetHeadroomUsd(db, 'wf_test')).toBe(0);
    db.close();
  });

  it('returns daily-cap headroom when only the daily cap is set', () => {
    process.env.OMNIFORGE_DAILY_BUDGET_USD = '0.4';
    const db = budgetDb();
    spend(db, 0.1); // counts toward the rolling-24h global spend (created_at = now)
    expect(getRemainingBudgetHeadroomUsd(db, 'wf_test')).toBeCloseTo(0.3, 5);
    db.close();
  });

  it('returns all-time-cap headroom when only the total cap is set', () => {
    process.env.OMNIFORGE_MAX_SPEND_USD = '2.0';
    const db = budgetDb();
    spend(db, 0.5);
    expect(getRemainingBudgetHeadroomUsd(db, 'wf_test')).toBeCloseTo(1.5, 5);
    db.close();
  });
});

// ── cost-DB-backed: selectModel signal + callOmnirouteWithUsage routing ───────

const TMP_DB = `./data/.test-cost-router-${process.pid}.db`;

describe('cost-router (cost-DB-backed)', () => {
  let getRouter: () => import('../../src/cost/CostAwareRouter.js').CostAwareRouter;
  let seedCost: (model: string, inPer1k: number, outPer1k: number, avgTokens: number) => void;
  let savedDbPath: string | undefined;

  beforeAll(async () => {
    savedDbPath = process.env.DB_PATH;
    process.env.DB_PATH = TMP_DB;
    const { getCostAwareRouter } = await import('../../src/cost/CostAwareRouter.js');
    const { getCostDatabase } = await import('../../src/cost/CostDatabase.js');
    getRouter = getCostAwareRouter;
    // Force the cost-DB singleton to initialise (runs migrations → creates
    // model_costs) before the per-test DELETE cleanup touches the table.
    getCostDatabase();
    seedCost = (model, inPer1k, outPer1k, avgTokens) =>
      getCostDatabase().updateCost({
        model,
        provider: 'omniroute',
        input_cost_per_1k: inPer1k,
        output_cost_per_1k: outPer1k,
        avg_tokens_per_request: avgTokens,
        max_tokens: 8192,
        last_updated: Math.floor(Date.now() / 1000),
      });
  });

  beforeEach(() => {
    // Clear seeded rates so each test is isolated (same on-disk DB as the singleton).
    const raw = new Database(TMP_DB);
    raw.exec('DELETE FROM model_costs');
    raw.close();
  });

  afterAll(() => {
    // Hygiene: restore DB_PATH so a non-isolated re-use never inherits the temp
    // path. (Under isolate:true the fork is torn down anyway; this is belt-and-
    // braces and keeps the env clean for any in-process consumers.)
    if (savedDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = savedDbPath;
  });

  describe('selectModel — within_budget + estimated_cost_usd', () => {
    it('no budget → recommends the requested model, within_budget true', () => {
      const r = getRouter().selectModel({
        requested_model: 'expensive/model',
        task_type: 'code',
        min_quality: 0,
        use_case: 'code',
      });
      expect(r.recommended_model).toBe('expensive/model');
      expect(r.within_budget).toBe(true);
    });

    it('requested model unknown to cost DB → within_budget true (cannot evaluate)', () => {
      const r = getRouter().selectModel({
        requested_model: 'unknown/model',
        task_type: 'code',
        budget_usd: 0.01,
        min_quality: 0,
        use_case: 'code',
      });
      expect(r.recommended_model).toBe('unknown/model');
      expect(r.within_budget).toBe(true);
    });

    it('requested model fits budget → within_budget true', () => {
      seedCost('fits/model', 0.1, 0.1, 1000); // est ≈ $0.1003
      const r = getRouter().selectModel({
        requested_model: 'fits/model',
        task_type: 'code',
        budget_usd: 100,
        min_quality: 0,
        use_case: 'code',
      });
      expect(r.recommended_model).toBe('fits/model');
      expect(r.within_budget).toBe(true);
      expect(r.estimated_cost_usd).toBeGreaterThan(0);
    });

    it('over budget with a cheaper alternative → downshifts, within_budget true', () => {
      seedCost('pricey/model', 10, 10, 1000); // est ≈ $10.03
      seedCost('cheap/model', 0.1, 0.1, 1000); // est ≈ $0.1003
      const r = getRouter().selectModel({
        requested_model: 'pricey/model',
        task_type: 'code',
        budget_usd: 5,
        min_quality: 0,
        use_case: 'code',
      });
      expect(r.recommended_model).toBe('cheap/model');
      expect(r.within_budget).toBe(true);
    });

    it('over budget with NO in-budget alternative → keeps requested, within_budget false', () => {
      seedCost('pricey/model', 10, 10, 1000); // est ≈ $10.03, only model seeded
      const r = getRouter().selectModel({
        requested_model: 'pricey/model',
        task_type: 'code',
        budget_usd: 5,
        min_quality: 0,
        use_case: 'code',
      });
      expect(r.recommended_model).toBe('pricey/model');
      expect(r.within_budget).toBe(false);
    });

    it('does NOT downshift to a cheaper model that drops a required capability', () => {
      // Requested is a Claude model (inferCapabilities → tool_calling true).
      seedCost('anthropic/claude-pricey', 10, 10, 1000); // est ≈ $10
      // Only affordable alternative is a plain model with NO tool_calling.
      seedCost('vendor/plain-cheap', 0.1, 0.1, 1000); // est ≈ $0.1, tool_calling false
      const r = getRouter().selectModel({
        requested_model: 'anthropic/claude-pricey',
        task_type: 'code',
        budget_usd: 5,
        min_quality: 0,
        use_case: 'code',
      });
      // The capability-dropping cheap model is rejected → keeps requested,
      // within_budget false (so enforce would gate rather than corrupt).
      expect(r.recommended_model).toBe('anthropic/claude-pricey');
      expect(r.within_budget).toBe(false);
    });

    it('DOES downshift to a cheaper model that preserves the required capability', () => {
      seedCost('anthropic/claude-pricey', 10, 10, 1000);
      seedCost('anthropic/claude-cheap', 0.1, 0.1, 1000); // also Claude → tool_calling true
      const r = getRouter().selectModel({
        requested_model: 'anthropic/claude-pricey',
        task_type: 'code',
        budget_usd: 5,
        min_quality: 0,
        use_case: 'code',
      });
      expect(r.recommended_model).toBe('anthropic/claude-cheap');
      expect(r.within_budget).toBe(true);
    });
  });

  // ── prompt_chars threading — the per-call estimate must reflect the REAL ─────
  // call size, not a ~13-char "task: <type>" literal. These tests pin the fix
  // for the inert cost-router gate: without a realistic prompt size the
  // requested-model estimate collapses to a sub-cent figure, so within_budget
  // stays true and neither the downshift nor the enforce gate ever fires until
  // the budget headroom itself goes sub-cent.
  describe('selectModel — prompt_chars drives a realistic per-call estimate', () => {
    // A model whose per-call cost is dominated by INPUT tokens: tiny output
    // (avg_tokens=10) so the prompt size — not the output — decides the budget.
    // Inert estimate ("task: code" = 10 chars → 3 input tokens):
    //   (3/1000)*1.0 + (10/1000)*1.0 = $0.013  → looks cheap, fits $1 budget.
    // Real estimate (80_000-char prompt → 20_000 input tokens):
    //   (20000/1000)*1.0 + (10/1000)*1.0 = $20.01 → blows a $1 budget.
    const PRICEY = { in: 1.0, out: 1.0, avg: 10 };
    const BIG_PROMPT_CHARS = 80_000;

    afterEach(() => {
      // The last test stubs fetch — unstub so it never leaks into sibling tests.
      vi.unstubAllGlobals();
    });

    it('FAILS the inert estimate: a realistic prompt over budget → within_budget false / no fit', () => {
      // Pin the desired behaviour. Against the OLD inert estimate this would be
      // within_budget TRUE (est ~$0.013 <= $1) — i.e. the bug. With prompt_chars
      // threaded the est is ~$20.01 > $1, and with no affordable alternative the
      // requested model is kept but flagged over budget so enforce can gate.
      seedCost('pricey/model', PRICEY.in, PRICEY.out, PRICEY.avg);
      const r = getRouter().selectModel({
        requested_model: 'pricey/model',
        task_type: 'code',
        budget_usd: 1.0,
        min_quality: 0,
        use_case: 'code',
        prompt_chars: BIG_PROMPT_CHARS,
      });
      expect(r.recommended_model).toBe('pricey/model');
      expect(r.within_budget).toBe(false);
      // The estimate must reflect the real ~$20 call, not a sub-cent literal.
      expect(r.estimated_cost_usd).toBeGreaterThan(10);
    });

    it('downshifts to a cheaper model once the realistic prompt size is over budget', () => {
      seedCost('pricey/model', PRICEY.in, PRICEY.out, PRICEY.avg);
      // cheap/model stays affordable even at 20_000 input tokens:
      //   (20000/1000)*0.001 + (10/1000)*0.001 ≈ $0.02 <= $1.
      seedCost('cheap/model', 0.001, 0.001, 10);
      const r = getRouter().selectModel({
        requested_model: 'pricey/model',
        task_type: 'code',
        budget_usd: 1.0,
        min_quality: 0,
        use_case: 'code',
        prompt_chars: BIG_PROMPT_CHARS,
      });
      expect(r.recommended_model).toBe('cheap/model');
      expect(r.within_budget).toBe(true);
    });

    it('does NOT downshift when the realistic estimate still fits a large headroom', () => {
      // Same model + same big prompt, but the headroom ($100) comfortably covers
      // the real ~$20 estimate → keep the requested model, within_budget true.
      seedCost('pricey/model', PRICEY.in, PRICEY.out, PRICEY.avg);
      seedCost('cheap/model', 0.001, 0.001, 10);
      const r = getRouter().selectModel({
        requested_model: 'pricey/model',
        task_type: 'code',
        budget_usd: 100,
        min_quality: 0,
        use_case: 'code',
        prompt_chars: BIG_PROMPT_CHARS,
      });
      expect(r.recommended_model).toBe('pricey/model');
      expect(r.within_budget).toBe(true);
      expect(r.estimated_cost_usd).toBeGreaterThan(10);
    });

    it('without prompt_chars the estimate falls back to the (tiny) objective heuristic', () => {
      // Back-compat guard: the param is optional. Omitting it reproduces the OLD
      // sub-cent estimate, so the same $1 budget that the realistic estimate
      // blows is NOT exceeded here — proving the param is what changes the math.
      seedCost('pricey/model', PRICEY.in, PRICEY.out, PRICEY.avg);
      const r = getRouter().selectModel({
        requested_model: 'pricey/model',
        task_type: 'code',
        budget_usd: 1.0,
        min_quality: 0,
        use_case: 'code',
        // prompt_chars omitted
      });
      expect(r.recommended_model).toBe('pricey/model');
      expect(r.within_budget).toBe(true);
      expect(r.estimated_cost_usd).toBeLessThan(0.1);
    });

    it('threads prompt_chars from callOmnirouteWithUsage so a large prompt trips enforce', async () => {
      // End-to-end through the real call path: a large user prompt makes the
      // requested model over the threaded headroom; with enforce on and no
      // affordable alternative the call is hard-gated BEFORE any HTTP request.
      const { callOmnirouteWithUsage } = await import('../../src/utils/omniroute-call.js');
      const { CostRouterBudgetExceededError } = await import('../../src/v2/budget/control.js');
      seedCost('pricey/model', PRICEY.in, PRICEY.out, PRICEY.avg);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        callOmnirouteWithUsage({
          systemPrompt: 's',
          userPrompt: 'x'.repeat(BIG_PROMPT_CHARS), // ~20_000 input tokens
          model: 'pricey/model',
          budgetUsd: 1.0, // headroom < real ~$20 estimate
          taskType: 'code',
          enforceBudget: true,
          workflowId: 'wf1',
          taskId: 't1',
        }),
      ).rejects.toBeInstanceOf(CostRouterBudgetExceededError);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('callOmnirouteWithUsage — budget args drive routing', () => {
    let callOmnirouteWithUsage: typeof import('../../src/utils/omniroute-call.js').callOmnirouteWithUsage;
    let BudgetExceededError: typeof import('../../src/v2/budget/control.js').BudgetExceededError;
    const envSaved = new Map<string, string | undefined>();

    beforeAll(async () => {
      ({ callOmnirouteWithUsage } = await import('../../src/utils/omniroute-call.js'));
      ({ BudgetExceededError } = await import('../../src/v2/budget/control.js'));
    });

    beforeEach(() => {
      for (const k of ['OMNIROUTE_URL', 'OMNIROUTE_API_KEY', 'OMNIROUTE_MAX_RETRIES']) {
        envSaved.set(k, process.env[k]);
      }
      process.env.OMNIROUTE_URL = 'http://omniroute.test';
      process.env.OMNIROUTE_API_KEY = 'test-key';
      process.env.OMNIROUTE_MAX_RETRIES = '0';
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const [k, v] of envSaved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function okFetch(): ReturnType<typeof vi.fn> {
      return vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
    }

    it('downshifts the model sent to the provider when the requested one is over budget', async () => {
      seedCost('pricey/model', 10, 10, 1000);
      seedCost('cheap/model', 0.1, 0.1, 1000);
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);

      await callOmnirouteWithUsage({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'pricey/model',
        budgetUsd: 5,
        taskType: 'code',
      });

      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string) as { model: string };
      expect(body.model).toBe('cheap/model');
    });

    it('enforce + over budget + no alternative → throws BudgetExceededError before any HTTP call', async () => {
      seedCost('pricey/model', 10, 10, 1000);
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);

      await expect(
        callOmnirouteWithUsage({
          systemPrompt: 's',
          userPrompt: 'u',
          model: 'pricey/model',
          budgetUsd: 5,
          taskType: 'code',
          enforceBudget: true,
          workflowId: 'wf1',
          taskId: 't1',
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('soft (no enforce) + over budget + no alternative → proceeds with the requested model', async () => {
      seedCost('pricey/model', 10, 10, 1000);
      const mockFetch = okFetch();
      vi.stubGlobal('fetch', mockFetch);

      const res = await callOmnirouteWithUsage({
        systemPrompt: 's',
        userPrompt: 'u',
        model: 'pricey/model',
        budgetUsd: 5,
        taskType: 'code',
        // enforceBudget omitted → soft
      });

      expect(res.content).toBe('ok');
      const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string) as { model: string };
      expect(body.model).toBe('pricey/model');
    });

    it('passes a configured minQuality=0 through to the router (not coerced to 0.7)', async () => {
      const { getCostAwareRouter } = await import('../../src/cost/CostAwareRouter.js');
      const spy = vi.spyOn(getCostAwareRouter(), 'selectModel').mockReturnValue({
        recommended_model: 'm', reasoning: '', within_budget: true, estimated_cost_usd: 0,
      });
      vi.stubGlobal('fetch', okFetch());

      await callOmnirouteWithUsage({
        systemPrompt: 's', userPrompt: 'u', model: 'm',
        budgetUsd: 5, taskType: 'code', minQuality: 0,
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ min_quality: 0 }));
      spy.mockRestore();
    });
  });

  describe('executeTask llm_call — opt-in wiring (flag + cap → routing engages)', () => {
    let executeTask: typeof import('../../src/brain/executor/internal-utils.js').executeTask;
    const envSaved = new Map<string, string | undefined>();
    const WF_SCHEMA = `CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY, workflow_id TEXT, task_id TEXT, provider TEXT, model TEXT,
      input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER,
      source TEXT, status TEXT, created_at INTEGER);`;

    beforeAll(async () => {
      ({ executeTask } = await import('../../src/brain/executor/internal-utils.js'));
    });

    beforeEach(() => {
      for (const k of [
        'OMNIROUTE_URL', 'OMNIROUTE_API_KEY', 'OMNIROUTE_MAX_RETRIES',
        'OMNIFORGE_COST_ROUTER', 'OMNIFORGE_WORKFLOW_BUDGET_USD',
      ]) envSaved.set(k, process.env[k]);
      process.env.OMNIROUTE_URL = 'http://omniroute.test';
      process.env.OMNIROUTE_API_KEY = 'test-key';
      process.env.OMNIROUTE_MAX_RETRIES = '0';
      delete process.env.OMNIFORGE_COST_ROUTER;
      delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const [k, v] of envSaved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function fetchSpy(): ReturnType<typeof vi.fn> {
      const f = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
      vi.stubGlobal('fetch', f);
      return f;
    }

    function wfDb(): Database.Database {
      const db = new Database(':memory:');
      db.exec(WF_SCHEMA);
      return db;
    }

    function llmTask() {
      return {
        id: 'tk1', workflow_id: 'wf1', name: 'T', kind: 'llm_call',
        depends_on: [], model: 'pricey/model', input_json: null,
        retry_policy: 'fixed:0', retry_count: 0, timeout_seconds: 30, status: 'running',
      } as unknown as import('../../src/types/index.js').Task;
    }

    it('flag OFF → no routing, sends the requested model even with a budget cap', async () => {
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
      seedCost('pricey/model', 10, 10, 1000);
      seedCost('cheap/model', 0.1, 0.1, 1000);
      const f = fetchSpy();
      const db = wfDb();

      await executeTask(llmTask(), { db, workflowId: 'wf1' });

      const body = JSON.parse(f.mock.calls[0]![1].body as string) as { model: string };
      expect(body.model).toBe('pricey/model');
      db.close();
    });

    it('flag ON + cap (headroom < requested est) → downshifts to the cheaper model', async () => {
      process.env.OMNIFORGE_COST_ROUTER = 'true';
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0'; // headroom $1.0 < pricey est ~$10
      seedCost('pricey/model', 10, 10, 1000);
      seedCost('cheap/model', 0.1, 0.1, 1000);
      const f = fetchSpy();
      const db = wfDb();

      await executeTask(llmTask(), { db, workflowId: 'wf1' });

      const body = JSON.parse(f.mock.calls[0]![1].body as string) as { model: string };
      expect(body.model).toBe('cheap/model');
      db.close();
    });

    it('flag ON but NO cap set → headroom null → no routing (unchanged)', async () => {
      process.env.OMNIFORGE_COST_ROUTER = 'true';
      seedCost('pricey/model', 10, 10, 1000);
      seedCost('cheap/model', 0.1, 0.1, 1000);
      const f = fetchSpy();
      const db = wfDb();

      await executeTask(llmTask(), { db, workflowId: 'wf1' });

      const body = JSON.parse(f.mock.calls[0]![1].body as string) as { model: string };
      expect(body.model).toBe('pricey/model');
      db.close();
    });
  });

  // ── streaming is NEVER routed (scope: non-streaming llm_call only) ───────────
  describe('cost router does not engage on the streaming path', () => {
    let executeTask: typeof import('../../src/brain/executor/internal-utils.js').executeTask;
    const envSaved = new Map<string, string | undefined>();

    beforeAll(async () => {
      ({ executeTask } = await import('../../src/brain/executor/internal-utils.js'));
    });

    beforeEach(() => {
      for (const k of [
        'OMNIROUTE_URL', 'OMNIROUTE_API_KEY',
        'OMNIFORGE_COST_ROUTER', 'OMNIFORGE_COST_ROUTER_ENFORCE',
        'OMNIFORGE_WORKFLOW_BUDGET_USD',
      ]) envSaved.set(k, process.env[k]);
      process.env.OMNIROUTE_URL = 'http://omniroute.test';
      process.env.OMNIROUTE_API_KEY = 'test-key';
    });

    afterEach(() => {
      vi.restoreAllMocks();
      for (const [k, v] of envSaved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function streamWfDb(): Database.Database {
      const db = new Database(':memory:');
      db.exec(`CREATE TABLE IF NOT EXISTS model_calls (
        id TEXT PRIMARY KEY, workflow_id TEXT, task_id TEXT, provider TEXT, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER,
        source TEXT, status TEXT, created_at INTEGER);`);
      return db;
    }

    function streamTask() {
      return {
        id: 'tk_stream', workflow_id: 'wf_stream', name: 'T', kind: 'llm_call',
        depends_on: [], model: 'pricey/model', input_json: null, stream_output: true,
        retry_policy: 'fixed:0', retry_count: 0, timeout_seconds: 30, status: 'running',
      } as unknown as import('../../src/types/index.js').Task;
    }

    it('stream_output=true with COST_ROUTER+ENFORCE is NOT downshifted nor gated', async () => {
      // Even with enforce on and a headroom far below the requested model's cost,
      // the streaming branch never calls selectModel — routing applies to the
      // non-streaming path only (RunOmnirouteOpts SCOPE note). The stream caller
      // is mocked at the top of this file so no network call happens.
      process.env.OMNIFORGE_COST_ROUTER = 'true';
      process.env.OMNIFORGE_COST_ROUTER_ENFORCE = 'true';
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '0.001'; // headroom ≪ pricey est
      seedCost('pricey/model', 100, 100, 1000);
      const { getCostAwareRouter } = await import('../../src/cost/CostAwareRouter.js');
      const selectSpy = vi.spyOn(getCostAwareRouter(), 'selectModel');
      const db = streamWfDb();

      // Resolves (no BudgetExceededError) and yields the mocked stream chunk —
      // proving the enforce gate never fired for a streaming task.
      const out = await executeTask(streamTask(), { db, workflowId: 'wf_stream' });
      expect(out).toBe('streamed-ok');
      expect(selectSpy).not.toHaveBeenCalled();
      db.close();
    });
  });

  // ── end-to-end: enforce → terminal through runTaskLoop DEFAULT dispatch ──────
  describe('enforce gate is terminal through runTaskLoop (no executeTaskFn)', () => {
    let runTaskLoop: typeof import('../../src/brain/executor.js').runTaskLoop;
    let insertWorkflow: typeof import('../../src/db/persist.js').insertWorkflow;
    let insertTask: typeof import('../../src/db/persist.js').insertTask;
    let initDb: typeof import('../../src/db/client.js').initDb;
    const envSaved = new Map<string, string | undefined>();

    beforeAll(async () => {
      ({ runTaskLoop } = await import('../../src/brain/executor.js'));
      ({ insertWorkflow, insertTask } = await import('../../src/db/persist.js'));
      ({ initDb } = await import('../../src/db/client.js'));
    });

    beforeEach(() => {
      for (const k of [
        'OMNIROUTE_URL', 'OMNIROUTE_API_KEY', 'OMNIROUTE_MAX_RETRIES',
        'OMNIFORGE_COST_ROUTER', 'OMNIFORGE_COST_ROUTER_ENFORCE',
        'OMNIFORGE_WORKFLOW_BUDGET_USD', 'OMNIFORGE_USE_PERSONAS',
      ]) envSaved.set(k, process.env[k]);
      process.env.OMNIROUTE_URL = 'http://omniroute.test';
      process.env.OMNIROUTE_API_KEY = 'test-key';
      process.env.OMNIROUTE_MAX_RETRIES = '0';
      process.env.OMNIFORGE_USE_PERSONAS = 'false';
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const [k, v] of envSaved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    function e2eTask(wfId: string, taskId: string): import('../../src/types/index.js').Task {
      return {
        id: taskId, workflow_id: wfId, name: 'T', kind: 'llm_call',
        input_json: null, output_json: null, status: 'pending', depends_on: [],
        executor_hint: null, timeout_seconds: 30, max_retries: 0, retry_count: 0,
        retry_policy: 'fixed:0', started_at: null, completed_at: null, created_at: Date.now(),
        acceptance_criteria: null, refine_count: 0, max_refine: 0, refine_feedback: null,
        model: 'pricey/model', hitl: false,
      } as unknown as import('../../src/types/index.js').Task;
    }

    it('COST_ROUTER+ENFORCE+cap + over-budget model → task fails terminally, no fetch, no retry', async () => {
      process.env.OMNIFORGE_COST_ROUTER = 'true';
      process.env.OMNIFORGE_COST_ROUTER_ENFORCE = 'true';
      // Headroom $1.0 (no spend yet); pricey est ≫ $1.0 even on a tiny prompt and
      // no alternative seeded → within_budget false → enforce gates before HTTP.
      process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = '1.0';
      seedCost('pricey/model', 100, 100, 1000);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const db = initDb(':memory:');
      const wfId = 'wf_e2e';
      const taskId = 'tk_e2e';
      const now = Date.now();
      insertWorkflow(db, {
        id: wfId, workspace: 'internal', objective: 'enforce e2e', pattern_id: null,
        status: 'executing', started_at: now, completed_at: null, created_at: now,
        created_by: null, estimated_cost_usd: null, actual_cost_usd: null,
        max_total_cost_usd: null, max_duration_seconds: null, metadata: null,
      });
      const task = e2eTask(wfId, taskId);
      insertTask(db, task);

      // No executeTaskFn → dispatchDeterministic threads db + workflowId, so the
      // opt-in cost router engages on the real llm_call path. The terminal budget
      // error fails the task, which fails the workflow → runTaskLoop rejects.
      await expect(
        runTaskLoop(db, [task], wfId, new Set(), { sleepFn: async () => {} }),
      ).rejects.toThrow();

      // The HTTP layer was never reached — enforce gated before dispatch.
      expect(mockFetch).not.toHaveBeenCalled();

      // task_budget_terminal emitted; task_retrying NEVER (budget errors are terminal).
      const terminal = db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND type = 'task_budget_terminal'`)
        .get(wfId) as { n: number };
      expect(terminal.n).toBe(1);
      const retrying = db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE workflow_id = ? AND type = 'task_retrying'`)
        .get(wfId) as { n: number };
      expect(retrying.n).toBe(0);

      const taskRow = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as { status: string };
      expect(taskRow.status).toBe('failed');
      db.close();
    });
  });

  // ── enforce-gate error message correctness (no false "spent" claim) ──────────
  describe('CostRouterBudgetExceededError message correctness', () => {
    let CostRouterBudgetExceededError: typeof import('../../src/v2/budget/control.js').CostRouterBudgetExceededError;
    let BudgetExceededError: typeof import('../../src/v2/budget/control.js').BudgetExceededError;

    beforeAll(async () => {
      ({ CostRouterBudgetExceededError, BudgetExceededError } =
        await import('../../src/v2/budget/control.js'));
    });

    it('is a BudgetExceededError subclass (still terminal in the retry loop)', () => {
      const err = new CostRouterBudgetExceededError('wf1', 12.5, 1.0);
      expect(err).toBeInstanceOf(BudgetExceededError);
      expect(err.name).toBe('CostRouterBudgetExceededError');
    });

    it('labels the estimate + headroom and does NOT claim money was spent', () => {
      const err = new CostRouterBudgetExceededError('wf1', 12.5, 1.0);
      // The pre-call gate must not say "spent $X" — nothing was spent.
      expect(err.message).not.toMatch(/spent/i);
      expect(err.message).toMatch(/est\. \$12\.5000/);
      expect(err.message).toMatch(/headroom \(\$1\.0000\)/);
      expect(err.message).toMatch(/no spend/i);
      expect(err.estimatedCostUsd).toBeCloseTo(12.5, 5);
      expect(err.headroomUsd).toBeCloseTo(1.0, 5);
    });
  });
});
