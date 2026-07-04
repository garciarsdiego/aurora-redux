import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { VALID_WORKSPACE_RE } from '../../utils/workspace.js';
import { aggregatePassAtK } from './metrics/pass-at-k.js';

export const RegisterEvalCaseSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  name: z.string().min(1).max(160),
  input: z.unknown(),
  expected: z.unknown(),
  tags: z.array(z.string().min(1)).optional().default([]),
});

export const ListEvalCasesSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  tags: z.array(z.string().min(1)).optional(),
});

export const RunEvalSuiteSchema = z.object({
  workspace: z.string().regex(VALID_WORKSPACE_RE),
  suiteName: z.string().min(1).max(160),
  tags: z.array(z.string().min(1)).optional(),
});

export interface EvalCase {
  id: string;
  workspace: string;
  name: string;
  input: unknown;
  expected: unknown;
  tags: string[];
  created_at: number;
}

interface EvalCaseRow {
  id: string;
  workspace: string;
  name: string;
  input_json: string;
  expected_json: string;
  tags_json: string;
  created_at: number;
}

export interface EvalRun {
  id: string;
  workspace: string;
  suite_name: string;
  status: 'running' | 'completed' | 'failed';
  score: number;
  case_count: number;
  created_at: number;
  completed_at: number | null;
}

export interface EvalResult {
  id: string;
  run_id: string;
  case_id: string;
  status: 'passed' | 'failed' | 'error';
  score: number;
  output_json: string | null;
  feedback: string | null;
  error: string | null;
  created_at: number;
}

export interface JudgeResult {
  score: number;
  passed: boolean;
  feedback?: string;
}

export interface RunEvalSuiteParams {
  workspace: string;
  suiteName: string;
  tags?: string[];
  /**
   * Optional subset of eval-case ids to run. When provided, only cases whose
   * id is in this list (after the workspace + tags filter) are executed. An
   * empty array is treated the same as `undefined` (run all matching cases).
   * Additive — pre-existing callers that omit it keep the run-all behavior.
   */
  caseIds?: string[];
  runner(testCase: EvalCase): Promise<unknown>;
  judge?(params: { testCase: EvalCase; output: unknown; expected: unknown }): Promise<JudgeResult>;
}

export function newEvalCaseId(): string {
  return `ec_${randomUUID()}`;
}

export function newEvalRunId(): string {
  return `er_${randomUUID()}`;
}

export function newEvalResultId(): string {
  return `ers_${randomUUID()}`;
}

function rowToCase(row: EvalCaseRow): EvalCase {
  return {
    id: row.id,
    workspace: row.workspace,
    name: row.name,
    input: JSON.parse(row.input_json) as unknown,
    expected: JSON.parse(row.expected_json) as unknown,
    tags: JSON.parse(row.tags_json) as string[],
    created_at: row.created_at,
  };
}

export function registerEvalCase(
  db: Database.Database,
  raw: z.input<typeof RegisterEvalCaseSchema>,
): EvalCase {
  const params = RegisterEvalCaseSchema.parse(raw);
  const id = newEvalCaseId();
  try {
    db.prepare(
      `INSERT INTO eval_cases
         (id, workspace, name, input_json, expected_json, tags_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.workspace,
      params.name,
      JSON.stringify(params.input),
      JSON.stringify(params.expected),
      JSON.stringify(params.tags),
      Date.now(),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique constraint/i.test(msg)) {
      throw new Error(`Eval case already exists: ${params.workspace}/${params.name}`);
    }
    throw err;
  }
  const row = db.prepare(`SELECT * FROM eval_cases WHERE id = ?`).get(id) as EvalCaseRow;
  return rowToCase(row);
}

export function listEvalCases(
  db: Database.Database,
  raw: z.input<typeof ListEvalCasesSchema>,
): EvalCase[] {
  const params = ListEvalCasesSchema.parse(raw);
  const rows = db
    .prepare(`SELECT * FROM eval_cases WHERE workspace = ? ORDER BY created_at ASC`)
    .all(params.workspace) as EvalCaseRow[];
  const cases = rows.map(rowToCase);
  if (!params.tags || params.tags.length === 0) return cases;
  return cases.filter((testCase) => params.tags!.every((tag) => testCase.tags.includes(tag)));
}

function insertEvalResult(
  db: Database.Database,
  params: Omit<EvalResult, 'id' | 'created_at'>,
): EvalResult {
  const id = newEvalResultId();
  db.prepare(
    `INSERT INTO eval_results
       (id, run_id, case_id, status, score, output_json, feedback, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.run_id,
    params.case_id,
    params.status,
    params.score,
    params.output_json,
    params.feedback,
    params.error,
    Date.now(),
  );
  return db.prepare(`SELECT * FROM eval_results WHERE id = ?`).get(id) as EvalResult;
}

/**
 * INTEL-06: persist a single metric score row for an eval result so the
 * dashboard eval detail (which reads `eval_metric_scores`) is populated
 * instead of empty.
 *
 * Fail-safe: the harness is also exercised in tests / lightweight contexts
 * where the `eval_metric_scores` table does not exist (minimal schema). A
 * missing table (or any insert failure) must NOT abort the suite run — the
 * per-case result has already been persisted. There is no workflow context
 * here to attach an `insertEvent` to, so we log to stderr per the agent rule
 * for non-workflow catch sites.
 */
function tryInsertMetricScore(
  db: Database.Database,
  params: {
    result_id: string;
    metric_name: string;
    score: number;
    threshold: number;
    passed: boolean;
    reason: string | null;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO eval_metric_scores
         (id, result_id, metric_name, score, threshold, passed, reason,
          cost_usd, latency_ms, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, '{}', ?)`,
    ).run(
      `ems_${randomUUID()}`,
      params.result_id,
      params.metric_name,
      // The schema CHECK clamps score/threshold to [0,1]; pass_at_k is binary.
      Math.max(0, Math.min(1, params.score)),
      Math.max(0, Math.min(1, params.threshold)),
      params.passed ? 1 : 0,
      params.reason,
      Date.now(),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[evals] skipped eval_metric_scores write for result ${params.result_id}: ${msg}\n`,
    );
  }
}

/**
 * INTEL-01: derive the suite-level pass@k (k=1) from per-case results.
 *
 * Each case is run once by `runEvalSuite`, so per-case pass@k score is 1 when
 * the case passed and 0 otherwise; the aggregate is the mean across cases —
 * i.e. the suite pass rate expressed in the pass@k vocabulary. Surfaced by the
 * `get_eval_run` MCP tool and derivable directly from `eval_results` so it is
 * available even when no metric-score rows were written.
 */
export function derivePassAtK(
  results: ReadonlyArray<Pick<EvalResult, 'status'>>,
  k = 1,
): { rate: number; cases: number; k: number } {
  const perCase = results.map((r) => ({ score: r.status === 'passed' ? 1 : 0 }));
  const { rate, cases } = aggregatePassAtK(perCase);
  return { rate, cases, k };
}

export async function runEvalSuite(
  db: Database.Database,
  raw: RunEvalSuiteParams,
): Promise<EvalRun> {
  const params = RunEvalSuiteSchema.parse(raw);
  const allCases = listEvalCases(db, { workspace: params.workspace, tags: params.tags });
  // Optional id subset: honor an explicit selection from the caller (e.g. the
  // dashboard "run selected" action). Empty/absent means "run all matching".
  const idFilter =
    raw.caseIds && raw.caseIds.length > 0 ? new Set(raw.caseIds) : null;
  const cases = idFilter ? allCases.filter((c) => idFilter.has(c.id)) : allCases;
  const runId = newEvalRunId();
  db.prepare(
    `INSERT INTO eval_runs
       (id, workspace, suite_name, status, score, case_count, created_at, completed_at)
     VALUES (?, ?, ?, 'running', 0, ?, ?, NULL)`,
  ).run(runId, params.workspace, params.suiteName, cases.length, Date.now());

  const judge = raw.judge ?? (async ({ output, expected }) => {
    const passed = JSON.stringify(output) === JSON.stringify(expected);
    return { score: passed ? 1 : 0, passed, feedback: passed ? 'exact match' : 'exact mismatch' };
  });

  for (const testCase of cases) {
    try {
      const output = await raw.runner(testCase);
      const judged = await judge({ testCase, output, expected: testCase.expected });
      const result = insertEvalResult(db, {
        run_id: runId,
        case_id: testCase.id,
        status: judged.passed ? 'passed' : 'failed',
        score: judged.score,
        output_json: JSON.stringify(output),
        feedback: judged.feedback ?? null,
        error: null,
      });
      // INTEL-06: persist a per-case pass@k(1) metric score so the dashboard
      // eval detail renders metric rows. k=1 because each case ran once.
      tryInsertMetricScore(db, {
        result_id: result.id,
        metric_name: 'pass_at_k',
        score: judged.passed ? 1 : 0,
        threshold: 1,
        passed: judged.passed,
        reason: judged.feedback ?? null,
      });
    } catch (err) {
      const result = insertEvalResult(db, {
        run_id: runId,
        case_id: testCase.id,
        status: 'error',
        score: 0,
        output_json: null,
        feedback: null,
        error: err instanceof Error ? err.message : String(err),
      });
      tryInsertMetricScore(db, {
        result_id: result.id,
        metric_name: 'pass_at_k',
        score: 0,
        threshold: 1,
        passed: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const results = loadEvalResults(db, runId);
  const score = results.length === 0
    ? 0
    : results.reduce((sum, result) => sum + result.score, 0) / results.length;
  db.prepare(
    `UPDATE eval_runs SET status = 'completed', score = ?, completed_at = ? WHERE id = ?`,
  ).run(score, Date.now(), runId);
  return db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).get(runId) as EvalRun;
}

export function listEvalRuns(
  db: Database.Database,
  raw: { workspace: string; limit?: number },
): EvalRun[] {
  z.object({
    workspace: z.string().regex(VALID_WORKSPACE_RE),
    limit: z.number().int().min(1).max(100).optional(),
  }).parse(raw);
  return db
    .prepare(`SELECT * FROM eval_runs WHERE workspace = ? ORDER BY created_at DESC LIMIT ?`)
    .all(raw.workspace, raw.limit ?? 20) as EvalRun[];
}

export function getEvalRun(db: Database.Database, runId: string): EvalRun | null {
  z.string().min(1).parse(runId);
  return db.prepare(`SELECT * FROM eval_runs WHERE id = ?`).get(runId) as EvalRun | undefined ?? null;
}

export function loadEvalResults(
  db: Database.Database,
  runId: string,
): EvalResult[] {
  return db
    .prepare(`SELECT * FROM eval_results WHERE run_id = ? ORDER BY created_at ASC`)
    .all(runId) as EvalResult[];
}

export interface EvalMetricScore {
  id: string;
  result_id: string;
  metric_name: string;
  score: number;
  threshold: number;
  passed: boolean;
  reason: string | null;
  cost_usd: number;
  latency_ms: number;
  meta: Record<string, unknown> | null;
  created_at: number;
}

interface EvalMetricScoreRow {
  id: string;
  result_id: string;
  metric_name: string;
  score: number;
  threshold: number;
  passed: number;
  reason: string | null;
  cost_usd: number;
  latency_ms: number;
  meta_json: string | null;
  created_at: number;
}

/**
 * Loads metric scores for an eval run.
 */
export function loadMetricScores(
  db: Database.Database,
  runId: string,
): EvalMetricScore[] {
  const rows = db
    .prepare(
      `SELECT ems.*
       FROM eval_metric_scores ems
       INNER JOIN eval_results er ON er.id = ems.result_id
       WHERE er.run_id = ?
       ORDER BY ems.created_at ASC`,
    )
    .all(runId) as EvalMetricScoreRow[];

  return rows.map(({ meta_json, passed, ...rest }) => ({
    ...rest,
    passed: passed === 1,
    meta: meta_json ? (JSON.parse(meta_json) as Record<string, unknown>) : null,
  }));
}

/**
 * Loads an eval run by variant ID.
 *
 * @param db - Database instance
 * @param variantId - Variant ID
 * @param workspace - Workspace name
 * @returns Eval run or null if not found
 */
export function loadRunByVariant(
  db: Database.Database,
  variantId: string,
  workspace: string,
): EvalRun | null {
  const row = db
    .prepare(
      `SELECT * FROM eval_runs
       WHERE variant_id = ? AND workspace = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(variantId, workspace) as EvalRun | undefined;

  return row ?? null;
}
