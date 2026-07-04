// Dashboard traces API route.
//
// Surfaces the `trace_spans` table (migration 017) as a per-workflow timeline
// for the Aurora TraceInspector screen. The frontend shape is one row per
// task (collapsed across span kinds): see `apps/dashboard-v2/src/screens/
// TraceInspector.tsx` and the `WorkflowTrace` / `TraceSpan` interfaces in
// `apps/dashboard-v2/src/api.ts:2382`.
//
// Route:
//   GET  /api/dashboard/workflows/:id/trace
//        → { workflow_id, spans: TraceSpan[], total_duration_ms, total_cost_usd }
//
// All access is gated by the Bearer auth middleware upstream — this router
// only handles the path match.

import type { ServerResponse } from 'node:http';

import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import type { Router } from './types.js';
import { jsonOk, notFound } from './_shared.js';

interface TraceSpanRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  parent_span_id: string | null;
  name: string;
  kind: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  attributes_json: string;
}

interface TaskRow {
  id: string;
  kind: string;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

interface FrontendTraceSpan {
  task_id: string;
  task_kind: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  status: 'running' | 'done' | 'failed';
}

interface FrontendWorkflowTrace {
  workflow_id: string;
  spans: FrontendTraceSpan[];
  total_duration_ms?: number;
  total_cost_usd?: number;
}

function normalizeStatus(status: string | undefined | null): FrontendTraceSpan['status'] {
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'running' || status === 'pending') return 'running';
  return 'done';
}

function isoOrUndefined(ms: number | null | undefined): string | undefined {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function buildWorkflowTrace(
  db: ReturnType<typeof initDb>,
  workflowId: string,
): FrontendWorkflowTrace | null {
  const workflow = db
    .prepare('SELECT id FROM workflows WHERE id = ?')
    .get(workflowId) as { id: string } | undefined;
  if (!workflow) return null;

  const tasks = db
    .prepare(
      `SELECT id, kind, status, started_at, completed_at, model,
              input_tokens, output_tokens
         FROM tasks
        WHERE workflow_id = ?
        ORDER BY started_at IS NULL, started_at ASC, created_at ASC`,
    )
    .all(workflowId) as TaskRow[];

  // Aggregate trace_spans by task_id (collapsing per-call spans into one row
  // per task — the Aurora timeline renders one bar per task).
  const spans = db
    .prepare(
      `SELECT id, workflow_id, task_id, parent_span_id, name, kind, status,
              started_at, ended_at, duration_ms, attributes_json
         FROM trace_spans
        WHERE workflow_id = ?
        ORDER BY started_at ASC`,
    )
    .all(workflowId) as TraceSpanRow[];

  type SpanAgg = {
    task_id: string;
    task_kind: string;
    earliest_start: number;
    latest_end: number | null;
    duration_sum_ms: number;
    failed: boolean;
    running: boolean;
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };

  const aggByTask = new Map<string, SpanAgg>();
  let totalCostUsd = 0;
  let costFound = false;

  for (const span of spans) {
    if (!span.task_id) continue; // workflow-level spans don't appear as task bars
    let attrs: Record<string, unknown> = {};
    try {
      attrs = JSON.parse(span.attributes_json) as Record<string, unknown>;
    } catch {
      attrs = {};
    }

    const existing = aggByTask.get(span.task_id);
    const status = normalizeStatus(span.status);
    const attrCost = typeof attrs.cost_usd === 'number' ? attrs.cost_usd : undefined;
    if (attrCost !== undefined) {
      totalCostUsd += attrCost;
      costFound = true;
    }

    if (!existing) {
      aggByTask.set(span.task_id, {
        task_id: span.task_id,
        task_kind: span.kind,
        earliest_start: span.started_at,
        latest_end: span.ended_at,
        duration_sum_ms: span.duration_ms ?? 0,
        failed: status === 'failed',
        running: status === 'running',
        model: typeof attrs.model === 'string' ? attrs.model : undefined,
        input_tokens: typeof attrs.input_tokens === 'number' ? attrs.input_tokens : undefined,
        output_tokens: typeof attrs.output_tokens === 'number' ? attrs.output_tokens : undefined,
        cost_usd: attrCost,
      });
    } else {
      if (span.started_at < existing.earliest_start) existing.earliest_start = span.started_at;
      if (span.ended_at !== null && (existing.latest_end === null || span.ended_at > existing.latest_end)) {
        existing.latest_end = span.ended_at;
      }
      existing.duration_sum_ms += span.duration_ms ?? 0;
      if (status === 'failed') existing.failed = true;
      if (status === 'running') existing.running = true;
      if (!existing.model && typeof attrs.model === 'string') existing.model = attrs.model;
      if (existing.input_tokens === undefined && typeof attrs.input_tokens === 'number') {
        existing.input_tokens = attrs.input_tokens;
      }
      if (existing.output_tokens === undefined && typeof attrs.output_tokens === 'number') {
        existing.output_tokens = attrs.output_tokens;
      }
    }
  }

  const frontendSpans: FrontendTraceSpan[] = tasks.map((task): FrontendTraceSpan => {
    const agg = aggByTask.get(task.id);
    if (agg) {
      const startedAtMs = agg.earliest_start;
      const endedAtMs = agg.latest_end ?? task.completed_at ?? null;
      const durationMs =
        agg.duration_sum_ms > 0
          ? agg.duration_sum_ms
          : endedAtMs !== null
            ? Math.max(0, endedAtMs - startedAtMs)
            : undefined;
      return {
        task_id: task.id,
        task_kind: agg.task_kind || task.kind,
        started_at: new Date(startedAtMs).toISOString(),
        ended_at: isoOrUndefined(endedAtMs),
        duration_ms: durationMs,
        model: agg.model ?? task.model ?? undefined,
        input_tokens: agg.input_tokens ?? task.input_tokens ?? undefined,
        output_tokens: agg.output_tokens ?? task.output_tokens ?? undefined,
        status: agg.failed ? 'failed' : agg.running ? 'running' : 'done',
      };
    }
    // No spans for this task — fall back to task lifecycle timestamps.
    const startedAtMs = task.started_at ?? task.completed_at ?? Date.now();
    const endedAtMs = task.completed_at;
    return {
      task_id: task.id,
      task_kind: task.kind,
      started_at: new Date(startedAtMs).toISOString(),
      ended_at: isoOrUndefined(endedAtMs),
      duration_ms:
        endedAtMs !== null && task.started_at !== null
          ? Math.max(0, endedAtMs - task.started_at)
          : undefined,
      model: task.model ?? undefined,
      input_tokens: task.input_tokens ?? undefined,
      output_tokens: task.output_tokens ?? undefined,
      status: normalizeStatus(task.status),
    };
  });

  const totalDuration =
    frontendSpans.length === 0
      ? undefined
      : Math.max(
          ...frontendSpans.map((s) => {
            const start = new Date(s.started_at).getTime();
            const end = s.ended_at ? new Date(s.ended_at).getTime() : Date.now();
            return Math.max(0, end - start);
          }),
        );

  return {
    workflow_id: workflowId,
    spans: frontendSpans,
    ...(totalDuration !== undefined ? { total_duration_ms: totalDuration } : {}),
    ...(costFound ? { total_cost_usd: Number(totalCostUsd.toFixed(6)) } : {}),
  };
}

function handleGetWorkflowTrace(workflowId: string, res: ServerResponse): void {
  const db = initDb(getDbPath());
  try {
    const trace = buildWorkflowTrace(db, workflowId);
    if (!trace) {
      notFound(res, `Workflow ${workflowId} not found`);
      return;
    }
    jsonOk(res, trace);
  } finally {
    db.close();
  }
}

const WORKFLOW_TRACE_RE = /^\/api\/dashboard\/workflows\/([A-Za-z0-9_-]+)\/trace$/;

export const dashboardTracesRouter: Router = async (req, url, res) => {
  if (req.method !== 'GET') return false;
  const match = url.pathname.match(WORKFLOW_TRACE_RE);
  if (!match) return false;
  handleGetWorkflowTrace(match[1]!, res);
  return true;
};
