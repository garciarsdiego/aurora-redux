#!/usr/bin/env tsx
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/client.js';
import { runGoldenEvalSuite } from '../src/v2/evals/golden-suite.js';

const workspace = process.env.GOLDEN_EVAL_WORKSPACE ?? 'ci';
const threshold = Number(process.env.GOLDEN_EVAL_THRESHOLD ?? '1');
const tempDir = mkdtempSync(join(tmpdir(), 'omniforge-golden-evals-'));
const db = initDb(join(tempDir, 'golden-evals.db'));

try {
  const report = await runGoldenEvalSuite(db, { workspace, threshold });
  process.stdout.write(
    `Golden evals: score=${report.run.score.toFixed(4)} threshold=${threshold.toFixed(4)} ` +
    `cases=${report.run.case_count} run=${report.run.id}\n`,
  );
  if (!report.passed) {
    for (const result of report.results) {
      if (result.status !== 'passed') {
        process.stderr.write(`${result.case_id}: ${result.status} ${result.feedback ?? result.error ?? ''}\n`);
      }
    }
    process.exit(1);
  }
} finally {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
}
