import { z } from 'zod';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { getEvalRun, loadEvalResults, derivePassAtK } from '../../v2/evals/harness.js';

export const GetEvalRunSchema = z.object({
  run_id: z.string().min(1),
});

export async function getEvalRunTool(raw: unknown): Promise<string> {
  const { run_id } = GetEvalRunSchema.parse(raw);
  const db = initDb(getDbPath());
  try {
    const run = getEvalRun(db, run_id);
    if (!run) {
      return JSON.stringify({ error: `Eval run not found: ${run_id}` });
    }
    const results = loadEvalResults(db, run_id);
    return JSON.stringify({
      run,
      results,
      // INTEL-01: surface the suite-level pass@k (k=1) derived from per-case
      // results so callers see reliability, not just the mean score.
      pass_at_k: derivePassAtK(results),
    });
  } finally {
    db.close();
  }
}
