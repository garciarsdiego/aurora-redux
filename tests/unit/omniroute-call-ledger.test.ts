import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spanContextStorage } from '../../src/v2/observability/tracing.js';
import { callOmnirouteWithUsage } from '../../src/utils/omniroute-call.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE model_calls (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, task_id TEXT,
      model TEXT NOT NULL, provider TEXT, input_tokens INTEGER,
      output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER,
      source TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE trace_spans (
      id TEXT PRIMARY KEY, workflow_id TEXT, task_id TEXT, parent_span_id TEXT,
      name TEXT, kind TEXT, status TEXT, started_at INTEGER, ended_at INTEGER,
      duration_ms INTEGER, attributes_json TEXT
    );
  `);
  return db;
}

const okResponse = () =>
  new Response(JSON.stringify({
    choices: [{ message: { content: 'resposta' } }],
    model: 'glm-5.2',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_cost_usd: 0 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('MÉDIO-4 — ledger de brain-role no chokepoint', () => {
  const originalBudget = process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;

  beforeEach(() => {
    // Garante que o caminho emitBudgetThresholdAlert (que toca a tabela
    // `events`, ausente do schema mínimo) fique quieto neste teste.
    delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalBudget === undefined) delete process.env.OMNIFORGE_WORKFLOW_BUDGET_USD;
    else process.env.OMNIFORGE_WORKFLOW_BUDGET_USD = originalBudget;
  });

  it('grava model_calls quando ledgerSource está no span context', async () => {
    const db = makeDb();
    await spanContextStorage.run(
      { db, parentSpanId: null, workflowId: 'wf_test', ledgerSource: 'reviewer' },
      () => callOmnirouteWithUsage({ systemPrompt: 's', userPrompt: 'u', model: 'any-model' }),
    );
    const rows = db.prepare('SELECT * FROM model_calls').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('reviewer');
    expect(rows[0]!.workflow_id).toBe('wf_test');
    expect(rows[0]!.input_tokens).toBe(10);
  });

  it('NÃO grava quando ledgerSource ausente (caminho do executor — sem double-count)', async () => {
    const db = makeDb();
    await spanContextStorage.run(
      { db, parentSpanId: null, workflowId: 'wf_test' },
      () => callOmnirouteWithUsage({ systemPrompt: 's', userPrompt: 'u', model: 'any-model' }),
    );
    expect(db.prepare('SELECT COUNT(*) c FROM model_calls').get()).toMatchObject({ c: 0 });
  });

  it('NÃO grava em caso de erro da chamada', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 400 })));
    const db = makeDb();
    await expect(
      spanContextStorage.run(
        { db, parentSpanId: null, workflowId: 'wf_test', ledgerSource: 'reviewer' },
        () => callOmnirouteWithUsage({ systemPrompt: 's', userPrompt: 'u', model: 'any-model' }),
      ),
    ).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM model_calls').get()).toMatchObject({ c: 0 });
  });
});
