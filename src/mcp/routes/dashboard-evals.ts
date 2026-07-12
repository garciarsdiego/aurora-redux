// Dashboard evals observability API routes.
//
// Provides REST endpoints for eval runs, A/B tests, optimizations, and prompt variants.
// All endpoints are Bearer-auth gated upstream by the HTTP server.
//
// Routes:
//   GET  /api/dashboard/eval-cases                    - List eval cases (light, bare array)
//   POST /api/dashboard/evals/run                     - Run a suite (light EvalRun shape)
//   GET  /api/dashboard/evals/:id                     - Get a run (light EvalRun shape, polling)
//   GET  /api/dashboard/evals/runs                    - List eval runs (with filters)
//   GET  /api/dashboard/evals/runs/:id                - Get run details (rich envelope)
//   GET  /api/dashboard/evals/runs/:id/metrics        - Get metric scores for run
//   GET  /api/dashboard/evals/ab-tests                - List A/B tests
//   GET  /api/dashboard/evals/ab-tests/:id            - Get A/B test details
//   GET  /api/dashboard/evals/variants                - List prompt variants
//   POST /api/dashboard/evals/variants/:id/activate   - Activate variant
//   GET  /api/dashboard/evals/optimizations           - List optimization runs
//   GET  /api/dashboard/evals/optimizations/:id       - Get optimization details
//
// NOTE: the light /evals/:id (bare EvalRun) is DISTINCT from the rich
// /evals/runs/:id (EvalRunDetails envelope). The router orders the simple
// /evals/:id branch LAST so it only catches the bare run id form.

import type { ServerResponse } from 'node:http';
import type { initDb } from '../../db/client.js';
import {
  ListEvalRunsFilterSchema,
  ListABTestsFilterSchema,
  ListOptimizationsFilterSchema,
  ListVariantsFilterSchema,
  ActivateVariantRequestSchema,
  type EvalRunSummary,
  type EvalRunDetails,
  type ABTestSummary,
  type ABTestDetails,
  type OptimizationRunSummary,
  type OptimizationRunDetails,
  type PromptVariantSummary,
  type MetricScoreDetail,
  type TestCaseResult,
  type EvalRunEvent,
  type OptimizationTrial,
} from '../../v2/evals/reporting/types.js';
import {
  listEvalCases,
  runEvalSuite,
  getEvalRun,
  loadEvalResults,
  type EvalCase as HarnessEvalCase,
  type EvalRun as HarnessEvalRun,
} from '../../v2/evals/harness.js';
import type { Router } from './types.js';
import { jsonOk, notFound, readBodyOr400, withDb, withDbAsync } from './_shared.js';

// ────────────────────────────────────────────────────────────────────
//  EVAL CASES + SIMPLE RUN (Aurora EvalSuite screen)
//
//  These endpoints serve the dashboard EvalSuite screen and use a LIGHT,
//  unwrapped shape distinct from the rich observability EvalRunDetails
//  envelope below. The simple EvalRun shape is shared by POST /evals/run
//  and the bare GET /evals/:id polling target.
// ────────────────────────────────────────────────────────────────────

const DEFAULT_EVAL_WORKSPACE = 'internal';
const DEFAULT_EVAL_SUITE_NAME = 'dashboard-run';

/** FE EvalCase summary shape (mapped from harness EvalCase). */
interface DashboardEvalCase {
  id: string;
  name: string;
  workspace: string;
  tags: string[];
  expected_output?: string;
  created_at: string;
}

/** FE EvalRun shape (mapped from harness EvalRun + a passed-results count). */
interface DashboardEvalRun {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  score?: number;
  cases_total: number;
  cases_passed: number;
  started_at: string;
  finished_at?: string;
}

function toDashboardEvalCase(c: HarnessEvalCase): DashboardEvalCase {
  return {
    id: c.id,
    name: c.name,
    workspace: c.workspace,
    tags: c.tags,
    expected_output:
      typeof c.expected === 'string' ? c.expected : JSON.stringify(c.expected),
    created_at: new Date(c.created_at).toISOString(),
  };
}

/**
 * Maps a harness EvalRun + count of passed results onto the light FE shape.
 *   harness 'completed' → 'passed' if every case passed (score >= 1), else 'failed'
 *   harness 'failed'    → 'error'
 *   harness 'running'   → 'running'
 */
function toDashboardEvalRun(run: HarnessEvalRun, casesPassed: number): DashboardEvalRun {
  let status: DashboardEvalRun['status'];
  if (run.status === 'running') {
    status = 'running';
  } else if (run.status === 'failed') {
    status = 'error';
  } else {
    // completed
    status = run.score >= 1 ? 'passed' : 'failed';
  }
  return {
    id: run.id,
    status,
    score: run.score,
    cases_total: run.case_count,
    cases_passed: casesPassed,
    started_at: new Date(run.created_at).toISOString(),
    finished_at: run.completed_at != null ? new Date(run.completed_at).toISOString() : undefined,
  };
}

/** Count eval_results rows in 'passed' status for a run. */
function countPassedResults(
  db: ReturnType<typeof initDb>,
  runId: string,
): number {
  return loadEvalResults(db, runId).filter((r) => r.status === 'passed').length;
}

function handleListEvalCases(url: URL, res: ServerResponse): void {
  const workspace = url.searchParams.get('workspace') ?? DEFAULT_EVAL_WORKSPACE;
  withDb(res, (db) => {
    const cases = listEvalCases(db, { workspace });
    // BARE JSON array (no envelope) — FE request<T> does not unwrap.
    jsonOk(res, cases.map(toDashboardEvalCase));
  });
}

async function handleRunEvalSuite(body: unknown, res: ServerResponse): Promise<void> {
  const input = (body && typeof body === 'object' ? body : {}) as {
    case_ids?: unknown;
    workspace?: unknown;
    suite_name?: unknown;
  };

  const caseIds = Array.isArray(input.case_ids)
    ? input.case_ids.filter((v): v is string => typeof v === 'string')
    : undefined;
  const workspace = typeof input.workspace === 'string' && input.workspace.length > 0
    ? input.workspace
    : DEFAULT_EVAL_WORKSPACE;
  const suiteName = typeof input.suite_name === 'string' && input.suite_name.length > 0
    ? input.suite_name
    : DEFAULT_EVAL_SUITE_NAME;

  await withDbAsync(res, async (db) => {
    // Default contract runner: echo the case input so a freshly-registered
    // case where input === expected passes under the harness exact-match judge.
    // The harness exact-match judge is the default (we pass no judge).
    const run = await runEvalSuite(db, {
      workspace,
      suiteName,
      caseIds,
      runner: async (testCase) => testCase.input,
    });
    const casesPassed = countPassedResults(db, run.id);
    // SINGLE EvalRun object (no envelope), same light shape as GET /evals/:id.
    jsonOk(res, toDashboardEvalRun(run, casesPassed));
  });
}

function handleGetSimpleEvalRun(runId: string, res: ServerResponse): void {
  withDb(res, (db) => {
    const run = getEvalRun(db, runId);
    if (!run) {
      notFound(res, `Eval run not found: ${runId}`);
      return;
    }
    const casesPassed = countPassedResults(db, run.id);
    jsonOk(res, toDashboardEvalRun(run, casesPassed));
  });
}

// ────────────────────────────────────────────────────────────────────
//  EVAL RUNS
// ────────────────────────────────────────────────────────────────────

/** Row shape shared by every SELECT over eval_runs in this file. */
interface EvalRunRow {
  id: string;
  workspace: string;
  suite_name: string;
  status: string;
  score: number;
  case_count: number;
  variant_id: string | null;
  ab_test_id: string | null;
  created_at: number;
  completed_at: number | null;
  total_cost_usd: number;
  total_clock_ms: number;
  agent_type: string | null;
  metadata_json: string;
}

/** Maps an eval_runs row onto the EvalRunSummary API shape. */
function mapEvalRunSummary(row: EvalRunRow): EvalRunSummary {
  return {
    id: row.id,
    workspace: row.workspace,
    suite_name: row.suite_name,
    status: row.status as 'running' | 'completed' | 'failed',
    score: row.score,
    case_count: row.case_count,
    variant_id: row.variant_id,
    ab_test_id: row.ab_test_id,
    agent_type: row.agent_type as 'decomposer' | 'planner' | 'reviewer' | null,
    total_cost_usd: row.total_cost_usd,
    total_clock_ms: row.total_clock_ms,
    created_at: row.created_at,
    completed_at: row.completed_at,
    metadata: JSON.parse(row.metadata_json),
  };
}

function handleListEvalRuns(url: URL, res: ServerResponse): void {
  withDb(res, (db) => {
    // Parse INSIDE the try so an invalid query param answers 400 instead of
    // throwing an uncaught ZodError out of the router (contract in types.ts).
    const filters = ListEvalRunsFilterSchema.parse({
      workspace: url.searchParams.get('workspace') ?? undefined,
      agent_type: url.searchParams.get('agent_type') ?? undefined,
      variant_id: url.searchParams.get('variant_id') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined,
      until: url.searchParams.get('until') ? Number(url.searchParams.get('until')) : undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
    });

    // Build the filter clauses once — the paginated SELECT and the COUNT
    // share them, so the two queries can never drift apart.
    const conds: string[] = [];
    const condParams: (string | number)[] = [];

    if (filters.workspace) {
      conds.push('workspace = ?');
      condParams.push(filters.workspace);
    }
    if (filters.agent_type) {
      conds.push('agent_type = ?');
      condParams.push(filters.agent_type);
    }
    if (filters.variant_id) {
      conds.push('variant_id = ?');
      condParams.push(filters.variant_id);
    }
    if (filters.status) {
      conds.push('status = ?');
      condParams.push(filters.status);
    }
    if (filters.since) {
      conds.push('created_at >= ?');
      condParams.push(filters.since);
    }
    if (filters.until) {
      conds.push('created_at <= ?');
      condParams.push(filters.until);
    }

    const whereClause = conds.length > 0 ? ` AND ${conds.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT
        id, workspace, suite_name, status, score, case_count,
        variant_id, ab_test_id, created_at, completed_at,
        total_cost_usd, total_clock_ms, agent_type, metadata_json
      FROM eval_runs
      WHERE 1=1${whereClause}
      ORDER BY created_at DESC LIMIT ?
    `).all(...condParams, filters.limit) as EvalRunRow[];

    const runs: EvalRunSummary[] = rows.map(mapEvalRunSummary);

    // Get total count
    const countRow = db.prepare(
      `SELECT COUNT(*) as total FROM eval_runs WHERE 1=1${whereClause}`,
    ).get(...condParams) as { total: number };

    jsonOk(res, { runs, total: countRow.total });
  });
}

function handleGetEvalRun(runId: string, res: ServerResponse): void {
  withDb(res, (db) => {
    // Fetch run
    const runRow = db.prepare(`
      SELECT
        id, workspace, suite_name, status, score, case_count,
        variant_id, ab_test_id, created_at, completed_at,
        total_cost_usd, total_clock_ms, agent_type, metadata_json
      FROM eval_runs
      WHERE id = ?
    `).get(runId) as EvalRunRow | undefined;

    if (!runRow) {
      notFound(res, 'Eval run not found');
      return;
    }

    const run: EvalRunSummary = mapEvalRunSummary(runRow);

    // Fetch results
    const resultRows = db.prepare(`
      SELECT
        er.id, er.case_id, er.status, er.score, er.output_json,
        er.feedback, er.error, er.created_at,
        ec.name as case_name
      FROM eval_results er
      LEFT JOIN eval_cases ec ON er.case_id = ec.id
      WHERE er.run_id = ?
      ORDER BY er.created_at
    `).all(runId) as Array<{
      id: string;
      case_id: string;
      case_name: string | null;
      status: string;
      score: number;
      output_json: string | null;
      feedback: string | null;
      error: string | null;
      created_at: number;
    }>;

    const results: TestCaseResult[] = resultRows.map((row) => ({
      id: row.id,
      case_id: row.case_id,
      case_name: row.case_name ?? 'Unknown',
      status: row.status as 'passed' | 'failed' | 'error' | 'skipped',
      score: row.score,
      output_json: row.output_json,
      feedback: row.feedback,
      error: row.error,
      metric_scores: [], // Fetched separately
      created_at: row.created_at,
    }));

    // Fetch metric scores for all results in ONE query (same JOIN shape as
    // handleGetEvalRunMetrics) and group in memory — avoids N+1 per result.
    const metricRows = db.prepare(`
      SELECT
        ems.id, ems.result_id, ems.metric_name, ems.score, ems.threshold,
        ems.passed, ems.reason, ems.cost_usd, ems.latency_ms, ems.meta_json
      FROM eval_metric_scores ems
      INNER JOIN eval_results er ON ems.result_id = er.id
      WHERE er.run_id = ?
    `).all(runId) as Array<{
      id: string;
      result_id: string;
      metric_name: string;
      score: number;
      threshold: number;
      passed: number;
      reason: string | null;
      cost_usd: number;
      latency_ms: number;
      meta_json: string;
    }>;

    const scoresByResult = new Map<string, MetricScoreDetail[]>();
    for (const m of metricRows) {
      const detail: MetricScoreDetail = {
        id: m.id,
        metric_name: m.metric_name,
        score: m.score,
        threshold: m.threshold,
        passed: m.passed === 1,
        reason: m.reason ?? undefined,
        cost_usd: m.cost_usd,
        latency_ms: m.latency_ms,
        meta: JSON.parse(m.meta_json),
      };
      const list = scoresByResult.get(m.result_id);
      if (list) list.push(detail);
      else scoresByResult.set(m.result_id, [detail]);
    }

    for (const result of results) {
      result.metric_scores = scoresByResult.get(result.id) ?? [];
    }

    // Calculate per-metric summary
    const perMetricSummary: Record<string, { mean: number; median: number; pass_rate: number; n: number }> = {};
    const metricScoresMap = new Map<string, number[]>();
    const metricPassMap = new Map<string, number>();

    for (const result of results) {
      for (const metric of result.metric_scores) {
        if (!metricScoresMap.has(metric.metric_name)) {
          metricScoresMap.set(metric.metric_name, []);
          metricPassMap.set(metric.metric_name, 0);
        }
        metricScoresMap.get(metric.metric_name)!.push(metric.score);
        if (metric.passed) {
          metricPassMap.set(metric.metric_name, (metricPassMap.get(metric.metric_name) ?? 0) + 1);
        }
      }
    }

    for (const [metricName, scores] of metricScoresMap) {
      const sorted = [...scores].sort((a, b) => a - b);
      const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
      const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      const passRate = (metricPassMap.get(metricName) ?? 0) / scores.length;

      perMetricSummary[metricName] = { mean, median, pass_rate: passRate, n: scores.length };
    }

    // Fetch events
    const eventRows = db.prepare(`
      SELECT
        id, run_id, event_type, message, metadata_json, created_at
      FROM eval_run_events
      WHERE run_id = ?
      ORDER BY created_at
    `).all(runId) as Array<{
      id: string;
      run_id: string;
      event_type: string;
      message: string | null;
      metadata_json: string;
      created_at: number;
    }>;

    const events: EvalRunEvent[] = eventRows.map((row) => ({
      id: row.id,
      run_id: row.run_id,
      event_type: row.event_type as EvalRunEvent['event_type'],
      message: row.message ?? undefined,
      metadata: JSON.parse(row.metadata_json),
      created_at: row.created_at,
    }));

    const details: EvalRunDetails = {
      run,
      results,
      per_metric_summary: perMetricSummary,
      events,
    };

    jsonOk(res, details);
  });
}

function handleGetEvalRunMetrics(runId: string, res: ServerResponse): void {
  withDb(res, (db) => {
    const rows = db.prepare(`
      SELECT
        ems.id, ems.metric_name, ems.score, ems.threshold, ems.passed,
        ems.reason, ems.cost_usd, ems.latency_ms, ems.meta_json,
        er.case_id, ec.name as case_name
      FROM eval_metric_scores ems
      INNER JOIN eval_results er ON ems.result_id = er.id
      LEFT JOIN eval_cases ec ON er.case_id = ec.id
      WHERE er.run_id = ?
      ORDER BY ems.metric_name, ems.created_at
    `).all(runId) as Array<{
      id: string;
      metric_name: string;
      score: number;
      threshold: number;
      passed: number;
      reason: string | null;
      cost_usd: number;
      latency_ms: number;
      meta_json: string;
      case_id: string;
      case_name: string | null;
    }>;

    const metrics: Array<{
      metric_name: string;
      scores: MetricScoreDetail[];
    }> = [];

    const metricMap = new Map<string, MetricScoreDetail[]>();
    for (const row of rows) {
      const detail: MetricScoreDetail = {
        id: row.id,
        metric_name: row.metric_name,
        score: row.score,
        threshold: row.threshold,
        passed: row.passed === 1,
        reason: row.reason ?? undefined,
        cost_usd: row.cost_usd,
        latency_ms: row.latency_ms,
        meta: JSON.parse(row.meta_json),
      };

      if (!metricMap.has(row.metric_name)) {
        metricMap.set(row.metric_name, []);
      }
      metricMap.get(row.metric_name)!.push(detail);
    }

    for (const [metricName, scores] of metricMap) {
      metrics.push({ metric_name: metricName, scores });
    }

    jsonOk(res, { metrics });
  });
}

// ────────────────────────────────────────────────────────────────────
//  A/B TESTS
// ────────────────────────────────────────────────────────────────────

function handleListABTests(url: URL, res: ServerResponse): void {
  withDb(res, (db) => {
    // Parse inside the try — invalid params answer 400, never throw uncaught.
    const filters = ListABTestsFilterSchema.parse({
      workspace: url.searchParams.get('workspace') ?? undefined,
      variant_id: url.searchParams.get('variant_id') ?? undefined,
      since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined,
      until: url.searchParams.get('until') ? Number(url.searchParams.get('until')) : undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
    });

    let query = `
      SELECT
        ab.id, ab.workspace, ab.variant_a_id, ab.variant_b_id,
        ab.run_a_id, ab.run_b_id, ab.winner, ab.confidence,
        ab.delta_score, ab.ci95_low, ab.ci95_high, ab.per_metric_json,
        ab.created_at,
        pv_a.name as variant_a_name,
        pv_b.name as variant_b_name
      FROM eval_ab_tests ab
      LEFT JOIN eval_prompt_variants pv_a ON ab.variant_a_id = pv_a.id
      LEFT JOIN eval_prompt_variants pv_b ON ab.variant_b_id = pv_b.id
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (filters.workspace) {
      query += ' AND ab.workspace = ?';
      params.push(filters.workspace);
    }
    if (filters.variant_id) {
      query += ' AND (ab.variant_a_id = ? OR ab.variant_b_id = ?)';
      params.push(filters.variant_id, filters.variant_id);
    }
    if (filters.since) {
      query += ' AND ab.created_at >= ?';
      params.push(filters.since);
    }
    if (filters.until) {
      query += ' AND ab.created_at <= ?';
      params.push(filters.until);
    }

    query += ' ORDER BY ab.created_at DESC LIMIT ?';
    params.push(filters.limit);

    const rows = db.prepare(query).all(...params) as Array<{
      id: string;
      workspace: string;
      variant_a_id: string;
      variant_b_id: string;
      run_a_id: string;
      run_b_id: string;
      winner: string;
      confidence: number;
      delta_score: number;
      ci95_low: number;
      ci95_high: number;
      per_metric_json: string;
      created_at: number;
      variant_a_name: string | null;
      variant_b_name: string | null;
    }>;

    const tests: ABTestSummary[] = rows.map((row) => ({
      id: row.id,
      workspace: row.workspace,
      variant_a_id: row.variant_a_id,
      variant_b_id: row.variant_b_id,
      variant_a_name: row.variant_a_name ?? 'Unknown',
      variant_b_name: row.variant_b_name ?? 'Unknown',
      run_a_id: row.run_a_id,
      run_b_id: row.run_b_id,
      winner: row.winner as 'a' | 'b' | 'tie',
      confidence: row.confidence,
      delta_score: row.delta_score,
      ci95_low: row.ci95_low,
      ci95_high: row.ci95_high,
      per_metric: JSON.parse(row.per_metric_json),
      created_at: row.created_at,
    }));

    jsonOk(res, { tests, total: tests.length });
  });
}

function handleGetABTest(testId: string, res: ServerResponse): void {
  withDb(res, (db) => {
    const testRow = db.prepare(`
      SELECT
        ab.id, ab.workspace, ab.variant_a_id, ab.variant_b_id,
        ab.run_a_id, ab.run_b_id, ab.winner, ab.confidence,
        ab.delta_score, ab.ci95_low, ab.ci95_high, ab.per_metric_json,
        ab.created_at,
        pv_a.name as variant_a_name,
        pv_b.name as variant_b_name
      FROM eval_ab_tests ab
      LEFT JOIN eval_prompt_variants pv_a ON ab.variant_a_id = pv_a.id
      LEFT JOIN eval_prompt_variants pv_b ON ab.variant_b_id = pv_b.id
      WHERE ab.id = ?
    `).get(testId) as {
      id: string;
      workspace: string;
      variant_a_id: string;
      variant_b_id: string;
      run_a_id: string;
      run_b_id: string;
      winner: string;
      confidence: number;
      delta_score: number;
      ci95_low: number;
      ci95_high: number;
      per_metric_json: string;
      created_at: number;
      variant_a_name: string | null;
      variant_b_name: string | null;
    } | undefined;

    if (!testRow) {
      notFound(res, 'A/B test not found');
      return;
    }

    const test: ABTestSummary = {
      id: testRow.id,
      workspace: testRow.workspace,
      variant_a_id: testRow.variant_a_id,
      variant_b_id: testRow.variant_b_id,
      variant_a_name: testRow.variant_a_name ?? 'Unknown',
      variant_b_name: testRow.variant_b_name ?? 'Unknown',
      run_a_id: testRow.run_a_id,
      run_b_id: testRow.run_b_id,
      winner: testRow.winner as 'a' | 'b' | 'tie',
      confidence: testRow.confidence,
      delta_score: testRow.delta_score,
      ci95_low: testRow.ci95_low,
      ci95_high: testRow.ci95_high,
      per_metric: JSON.parse(testRow.per_metric_json),
      created_at: testRow.created_at,
    };

    // Fetch run details (simplified - just summaries)
    const runARow = db.prepare(`
      SELECT id, workspace, suite_name, status, score, case_count,
             variant_id, ab_test_id, created_at, completed_at,
             total_cost_usd, total_clock_ms, agent_type, metadata_json
      FROM eval_runs WHERE id = ?
    `).get(testRow.run_a_id) as EvalRunRow | undefined;

    const runBRow = db.prepare(`
      SELECT id, workspace, suite_name, status, score, case_count,
             variant_id, ab_test_id, created_at, completed_at,
             total_cost_usd, total_clock_ms, agent_type, metadata_json
      FROM eval_runs WHERE id = ?
    `).get(testRow.run_b_id) as EvalRunRow | undefined;

    if (!runARow || !runBRow) {
      notFound(res, 'One or both runs not found');
      return;
    }

    const details: ABTestDetails = {
      test,
      run_a: {
        run: mapEvalRunSummary(runARow),
        results: [],
        per_metric_summary: {},
        events: [],
      },
      run_b: {
        run: mapEvalRunSummary(runBRow),
        results: [],
        per_metric_summary: {},
        events: [],
      },
    };

    jsonOk(res, details);
  });
}

// ────────────────────────────────────────────────────────────────────
//  PROMPT VARIANTS
// ────────────────────────────────────────────────────────────────────

function handleListVariants(url: URL, res: ServerResponse): void {
  withDb(res, (db) => {
    // Parse inside the try — invalid params answer 400, never throw uncaught.
    const filters = ListVariantsFilterSchema.parse({
      workspace: url.searchParams.get('workspace') ?? undefined,
      component: url.searchParams.get('component') ?? undefined,
      active_only: url.searchParams.get('active_only') === 'true',
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
    });

    let query = `
      SELECT
        pv.id, pv.workspace, pv.component, pv.name, pv.parent_id, pv.created_at,
        CASE WHEN eav.variant_id IS NOT NULL THEN 1 ELSE 0 END as is_active
      FROM eval_prompt_variants pv
      LEFT JOIN eval_active_variants eav ON pv.id = eav.variant_id
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (filters.workspace) {
      query += ' AND pv.workspace = ?';
      params.push(filters.workspace);
    }
    if (filters.component) {
      query += ' AND pv.component = ?';
      params.push(filters.component);
    }
    if (filters.active_only) {
      query += ' AND eav.variant_id IS NOT NULL';
    }

    query += ' ORDER BY pv.created_at DESC LIMIT ?';
    params.push(filters.limit);

    const rows = db.prepare(query).all(...params) as Array<{
      id: string;
      workspace: string;
      component: string;
      name: string;
      parent_id: string | null;
      created_at: number;
      is_active: number;
    }>;

    const variants: PromptVariantSummary[] = rows.map((row) => ({
      id: row.id,
      workspace: row.workspace,
      component: row.component as 'decomposer' | 'planner' | 'reviewer',
      name: row.name,
      parent_id: row.parent_id,
      created_at: row.created_at,
      is_active: row.is_active === 1,
    }));

    jsonOk(res, { variants, total: variants.length });
  });
}

function handleActivateVariant(variantId: string, body: unknown, res: ServerResponse): void {
  withDb(res, (db) => {
    // Validate-only parse (the schema carries no fields we consume here);
    // inside the try so an invalid body answers 400, never throws uncaught.
    ActivateVariantRequestSchema.parse(body);

    // Verify variant exists
    const variant = db.prepare(`
      SELECT id, workspace, component FROM eval_prompt_variants WHERE id = ?
    `).get(variantId) as { id: string; workspace: string; component: string } | undefined;

    if (!variant) {
      notFound(res, 'Variant not found');
      return;
    }

    // Upsert active variant record
    db.prepare(`
      INSERT OR REPLACE INTO eval_active_variants (id, workspace, component, variant_id, activated_at, activated_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      `${variant.workspace}-${variant.component}`,
      variant.workspace,
      variant.component,
      variantId,
      Date.now(),
      'dashboard',
    );

    jsonOk(res, { success: true, activated_at: Date.now() });
  });
}

// ────────────────────────────────────────────────────────────────────
//  OPTIMIZATIONS
// ────────────────────────────────────────────────────────────────────

function handleListOptimizations(url: URL, res: ServerResponse): void {
  withDb(res, (db) => {
    // Parse inside the try — invalid params answer 400, never throw uncaught.
    const filters = ListOptimizationsFilterSchema.parse({
      workspace: url.searchParams.get('workspace') ?? undefined,
      strategy: url.searchParams.get('strategy') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined,
      until: url.searchParams.get('until') ? Number(url.searchParams.get('until')) : undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50,
    });

    let query = `
      SELECT
        id, workspace, base_variant_id, strategy, target_metric,
        max_iterations, max_cost_usd, max_clock_ms, status,
        current_iteration, best_score, best_variant_id,
        total_cost_usd, total_clock_ms, stopped_reason,
        created_at, completed_at
      FROM eval_optimization_runs
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (filters.workspace) {
      query += ' AND workspace = ?';
      params.push(filters.workspace);
    }
    if (filters.strategy) {
      query += ' AND strategy = ?';
      params.push(filters.strategy);
    }
    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters.since) {
      query += ' AND created_at >= ?';
      params.push(filters.since);
    }
    if (filters.until) {
      query += ' AND created_at <= ?';
      params.push(filters.until);
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(filters.limit);

    const rows = db.prepare(query).all(...params) as Array<{
      id: string;
      workspace: string;
      base_variant_id: string;
      strategy: string;
      target_metric: string;
      max_iterations: number;
      max_cost_usd: number;
      max_clock_ms: number;
      status: string;
      current_iteration: number;
      best_score: number | null;
      best_variant_id: string | null;
      total_cost_usd: number;
      total_clock_ms: number;
      stopped_reason: string | null;
      created_at: number;
      completed_at: number | null;
    }>;

    const optimizations: OptimizationRunSummary[] = rows.map((row) => ({
      id: row.id,
      workspace: row.workspace,
      base_variant_id: row.base_variant_id,
      strategy: row.strategy as OptimizationRunSummary['strategy'],
      target_metric: row.target_metric,
      max_iterations: row.max_iterations,
      max_cost_usd: row.max_cost_usd,
      max_clock_ms: row.max_clock_ms,
      status: row.status as OptimizationRunSummary['status'],
      current_iteration: row.current_iteration,
      best_score: row.best_score,
      best_variant_id: row.best_variant_id,
      total_cost_usd: row.total_cost_usd,
      total_clock_ms: row.total_clock_ms,
      stopped_reason: row.stopped_reason,
      created_at: row.created_at,
      completed_at: row.completed_at,
    }));

    jsonOk(res, { optimizations, total: optimizations.length });
  });
}

function handleGetOptimization(optimizationId: string, res: ServerResponse): void {
  withDb(res, (db) => {
    const runRow = db.prepare(`
      SELECT
        id, workspace, base_variant_id, strategy, target_metric,
        max_iterations, max_cost_usd, max_clock_ms, status,
        current_iteration, best_score, best_variant_id,
        total_cost_usd, total_clock_ms, stopped_reason,
        created_at, completed_at
      FROM eval_optimization_runs
      WHERE id = ?
    `).get(optimizationId) as {
      id: string;
      workspace: string;
      base_variant_id: string;
      strategy: string;
      target_metric: string;
      max_iterations: number;
      max_cost_usd: number;
      max_clock_ms: number;
      status: string;
      current_iteration: number;
      best_score: number | null;
      best_variant_id: string | null;
      total_cost_usd: number;
      total_clock_ms: number;
      stopped_reason: string | null;
      created_at: number;
      completed_at: number | null;
    } | undefined;

    if (!runRow) {
      notFound(res, 'Optimization run not found');
      return;
    }

    const run: OptimizationRunSummary = {
      id: runRow.id,
      workspace: runRow.workspace,
      base_variant_id: runRow.base_variant_id,
      strategy: runRow.strategy as OptimizationRunSummary['strategy'],
      target_metric: runRow.target_metric,
      max_iterations: runRow.max_iterations,
      max_cost_usd: runRow.max_cost_usd,
      max_clock_ms: runRow.max_clock_ms,
      status: runRow.status as OptimizationRunSummary['status'],
      current_iteration: runRow.current_iteration,
      best_score: runRow.best_score,
      best_variant_id: runRow.best_variant_id,
      total_cost_usd: runRow.total_cost_usd,
      total_clock_ms: runRow.total_clock_ms,
      stopped_reason: runRow.stopped_reason,
      created_at: runRow.created_at,
      completed_at: runRow.completed_at,
    };

    // Fetch trials
    const trialRows = db.prepare(`
      SELECT
        id, optimization_id, iteration, variant_id, axis_values_json,
        objective_score, metric_scores_json, cost_usd, clock_ms, created_at
      FROM eval_optimization_trials
      WHERE optimization_id = ?
      ORDER BY iteration
    `).all(optimizationId) as Array<{
      id: string;
      optimization_id: string;
      iteration: number;
      variant_id: string;
      axis_values_json: string;
      objective_score: number;
      metric_scores_json: string;
      cost_usd: number;
      clock_ms: number;
      created_at: number;
    }>;

    const trials: OptimizationTrial[] = trialRows.map((row) => ({
      id: row.id,
      optimization_id: row.optimization_id,
      iteration: row.iteration,
      variant_id: row.variant_id,
      axis_values: JSON.parse(row.axis_values_json),
      objective_score: row.objective_score,
      metric_scores: JSON.parse(row.metric_scores_json),
      cost_usd: row.cost_usd,
      clock_ms: row.clock_ms,
      created_at: row.created_at,
    }));

    const details: OptimizationRunDetails = {
      run,
      trials,
    };

    jsonOk(res, details);
  });
}

// ────────────────────────────────────────────────────────────────────
//  ROUTER
// ────────────────────────────────────────────────────────────────────

const SIMPLE_EVAL_RUN_RE = /^\/api\/dashboard\/evals\/([^/]+)$/;

export const dashboardEvalsRouter: Router = async (req, url, res) => {
  // Eval cases (light, bare array) — note: NOT under /evals/, so no collision.
  if (req.method === 'GET' && url.pathname === '/api/dashboard/eval-cases') {
    handleListEvalCases(url, res);
    return true;
  }

  // Run a suite (light EvalRun shape). Exact pathname + POST so it cannot be
  // swallowed by the GET /evals/runs list handler (different segment + method).
  if (req.method === 'POST' && url.pathname === '/api/dashboard/evals/run') {
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    await handleRunEvalSuite(body, res);
    return true;
  }

  // Eval runs
  if (req.method === 'GET' && url.pathname === '/api/dashboard/evals/runs') {
    handleListEvalRuns(url, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/dashboard/evals/runs/')) {
    if (url.pathname.endsWith('/metrics')) {
      // Path is /api/dashboard/evals/runs/:id/metrics — the run id is the
      // second-to-last segment, NOT .pop() (that would return 'metrics'
      // itself, so handleGetEvalRunMetrics would query WHERE run_id =
      // 'metrics' and always return an empty list).
      const runId = url.pathname.split('/').slice(-2, -1)[0];
      handleGetEvalRunMetrics(runId!, res);
      return true;
    }
    const runId = url.pathname.split('/').pop();
    handleGetEvalRun(runId!, res);
    return true;
  }

  // A/B tests
  if (req.method === 'GET' && url.pathname === '/api/dashboard/evals/ab-tests') {
    handleListABTests(url, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/dashboard/evals/ab-tests/')) {
    const testId = url.pathname.split('/').pop();
    handleGetABTest(testId!, res);
    return true;
  }

  // Variants
  if (req.method === 'GET' && url.pathname === '/api/dashboard/evals/variants') {
    handleListVariants(url, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname.match(/^\/api\/dashboard\/evals\/variants\/[^/]+\/activate$/)) {
    const variantId = url.pathname.split('/')[5];
    // readBodyOr400 (256 KB cap) — the previous `new Response(req).json()`
    // bypassed the shared buffer-bomb protection.
    const body = await readBodyOr400(req, res);
    if (body === undefined) return true;
    handleActivateVariant(variantId!, body, res);
    return true;
  }

  // Optimizations
  if (req.method === 'GET' && url.pathname === '/api/dashboard/evals/optimizations') {
    handleListOptimizations(url, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/dashboard/evals/optimizations/')) {
    const optimizationId = url.pathname.split('/').pop();
    handleGetOptimization(optimizationId!, res);
    return true;
  }

  // Bare GET /api/dashboard/evals/:id (light EvalRun shape, polling target).
  // Ordered LAST so it only catches the bare run-id form — the literal
  // 'runs' | 'ab-tests' | 'variants' | 'optimizations' segments were all
  // matched by exact-pathname / startsWith checks above.
  if (req.method === 'GET') {
    const simpleMatch = url.pathname.match(SIMPLE_EVAL_RUN_RE);
    if (simpleMatch) {
      handleGetSimpleEvalRun(simpleMatch[1]!, res);
      return true;
    }
  }

  return false;
};