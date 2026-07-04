import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  listEvalCases,
  registerEvalCase,
  runEvalSuite,
  listEvalRuns,
  loadEvalResults,
  loadMetricScores,
  derivePassAtK,
} from '../../src/v2/evals/harness.js';

describe('eval harness', () => {
  it('registers golden eval cases with workspace scope and tags', () => {
    const db = initDb(':memory:');
    const row = registerEvalCase(db, {
      workspace: 'internal',
      name: 'simple-summary',
      input: { objective: 'Resuma em 3 bullets' },
      expected: { mustContain: ['bullet'] },
      tags: ['summary', 'golden'],
    });

    expect(row.id).toMatch(/^ec_/);
    expect(row.workspace).toBe('internal');
    expect(row.input).toEqual({ objective: 'Resuma em 3 bullets' });
    expect(row.tags).toEqual(['summary', 'golden']);
    expect(listEvalCases(db, { workspace: 'internal' })).toHaveLength(1);
    db.close();
  });

  it('runs a deterministic eval suite and persists per-case results', async () => {
    const db = initDb(':memory:');
    const c1 = registerEvalCase(db, {
      workspace: 'internal',
      name: 'contains-ok',
      input: { prompt: 'return ok' },
      expected: { text: 'ok' },
      tags: ['smoke'],
    });
    const c2 = registerEvalCase(db, {
      workspace: 'internal',
      name: 'contains-fail',
      input: { prompt: 'return fail' },
      expected: { text: 'missing' },
      tags: ['smoke'],
    });

    const run = await runEvalSuite(db, {
      workspace: 'internal',
      suiteName: 'smoke',
      tags: ['smoke'],
      runner: async (testCase) => ({ text: testCase.id === c1.id ? 'ok' : 'nope' }),
      judge: async ({ output, expected }) => {
        const expectedText = (expected as { text: string }).text;
        const actualText = (output as { text: string }).text;
        const passed = actualText.includes(expectedText);
        return { score: passed ? 1 : 0, passed, feedback: passed ? 'matched' : 'missing text' };
      },
    });

    expect(run.id).toMatch(/^er_/);
    expect(run.status).toBe('completed');
    expect(run.score).toBeCloseTo(0.5, 6);

    const runs = listEvalRuns(db, { workspace: 'internal' });
    expect(runs).toHaveLength(1);
    const results = loadEvalResults(db, run.id);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.case_id).sort()).toEqual([c1.id, c2.id].sort());
    expect(results.filter((r) => r.status === 'passed')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'failed')).toHaveLength(1);
    db.close();
  });

  it('marks a case errored when the runner throws and keeps the suite completed', async () => {
    const db = initDb(':memory:');
    registerEvalCase(db, {
      workspace: 'internal',
      name: 'throws',
      input: { prompt: 'boom' },
      expected: {},
      tags: ['chaos'],
    });

    const run = await runEvalSuite(db, {
      workspace: 'internal',
      suiteName: 'chaos',
      tags: ['chaos'],
      runner: async () => { throw new Error('provider down'); },
    });

    expect(run.status).toBe('completed');
    expect(run.score).toBe(0);
    const results = loadEvalResults(db, run.id);
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.error).toContain('provider down');
    db.close();
  });
});

describe('pass@k wiring (INTEL-01 / INTEL-06)', () => {
  it('derivePassAtK computes the suite pass rate (k=1) from per-case results', () => {
    expect(derivePassAtK([
      { status: 'passed' },
      { status: 'passed' },
      { status: 'failed' },
      { status: 'error' },
    ])).toEqual({ rate: 0.5, cases: 4, k: 1 });

    expect(derivePassAtK([])).toEqual({ rate: 0, cases: 0, k: 1 });
  });

  it('persists a pass_at_k metric score per result so the dashboard detail is non-empty', async () => {
    const db = initDb(':memory:');
    const passing = registerEvalCase(db, {
      workspace: 'internal', name: 'mp-pass', input: { x: 1 }, expected: { x: 1 }, tags: ['metric'],
    });
    const failing = registerEvalCase(db, {
      workspace: 'internal', name: 'mp-fail', input: { x: 2 }, expected: { x: 999 }, tags: ['metric'],
    });

    const run = await runEvalSuite(db, {
      workspace: 'internal',
      suiteName: 'metric-persist',
      tags: ['metric'],
      runner: async (testCase) => testCase.input, // default exact-match judge
    });

    const metricScores = loadMetricScores(db, run.id);
    // One pass_at_k row per case.
    expect(metricScores).toHaveLength(2);
    expect(metricScores.every((m) => m.metric_name === 'pass_at_k')).toBe(true);

    const results = loadEvalResults(db, run.id);
    const passResultId = results.find((r) => r.case_id === passing.id)!.id;
    const failResultId = results.find((r) => r.case_id === failing.id)!.id;
    expect(metricScores.find((m) => m.result_id === passResultId)!.passed).toBe(true);
    expect(metricScores.find((m) => m.result_id === passResultId)!.score).toBe(1);
    expect(metricScores.find((m) => m.result_id === failResultId)!.passed).toBe(false);
    expect(metricScores.find((m) => m.result_id === failResultId)!.score).toBe(0);

    // And the derived suite pass@k matches: 1 of 2 cases passed.
    expect(derivePassAtK(results)).toEqual({ rate: 0.5, cases: 2, k: 1 });
    db.close();
  });
});
