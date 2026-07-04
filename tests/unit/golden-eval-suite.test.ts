import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { loadEvalResults } from '../../src/v2/evals/harness.js';
import {
  DEFAULT_GOLDEN_EVAL_CASES,
  runGoldenEvalSuite,
} from '../../src/v2/evals/golden-suite.js';

describe('golden eval suite', () => {
  it('runs deterministic golden cases through the real eval harness', async () => {
    const db = initDb(':memory:');
    const report = await runGoldenEvalSuite(db, { workspace: 'ci', threshold: 1 });

    expect(report.passed).toBe(true);
    expect(report.run.status).toBe('completed');
    expect(report.run.score).toBe(1);
    expect(report.run.case_count).toBe(DEFAULT_GOLDEN_EVAL_CASES.length);
    expect(loadEvalResults(db, report.run.id)).toHaveLength(DEFAULT_GOLDEN_EVAL_CASES.length);
    db.close();
  });
});
