import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { emitBudgetThresholdAlert, getWorkflowBudgetUsd } from '../budget/control.js';
import { emitCostDelta, type CostDeltaPayload } from '../../mcp/sse-meta-emitter.js';

/** Task kinds that incur model cost. Used by the W5 cost_delta SSE payload
 *  so the dashboard can attribute cumulative-cost movement back to the
 *  task category that caused it. */
const COST_SOURCE_KINDS = ['llm_call', 'cli_spawn', 'pal_call', 'tool_call'] as const;
type CostSourceKind = (typeof COST_SOURCE_KINDS)[number];
const COST_SOURCE_KIND_SET: ReadonlySet<string> = new Set(COST_SOURCE_KINDS);

const RecordModelCallSchema = z.object({
  workflowId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  model: z.string().min(1),
  provider: z.string().min(1).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  source: z.string().min(1).default('executor'),
  /** Optional task kind hint. Drives the `source` field of the synthetic
   *  W5 `cost_delta` SSE event. When unset, the emitter falls back to the
   *  closest matching value (or `llm_call` as a last resort). */
  kind: z.enum(COST_SOURCE_KINDS).optional(),
});

export interface ModelCallRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  model: string;
  provider: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  source: string;
  created_at: number;
}

export function newModelCallId(): string {
  return `mc_${randomUUID()}`;
}

export function providerFromModel(model: string): string | null {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

export function recordModelCall(
  db: Database.Database,
  raw: z.input<typeof RecordModelCallSchema>,
): ModelCallRow {
  const params = RecordModelCallSchema.parse(raw);
  const id = newModelCallId();
  db.prepare(
    `INSERT INTO model_calls
       (id, workflow_id, task_id, model, provider, input_tokens, output_tokens,
        cost_usd, latency_ms, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.workflowId,
    params.taskId ?? null,
    params.model,
    params.provider ?? providerFromModel(params.model),
    params.inputTokens ?? null,
    params.outputTokens ?? null,
    params.costUsd ?? null,
    params.latencyMs ?? null,
    params.source,
    Date.now(),
  );

  // W5-backend (2026-05-11): push `cost_delta` to SSE subscribers so the
  // dashboard's 8s `getDashboardSummary` poll becomes a backstop. We emit
  // only when this call actually added cost — zero-cost rows (e.g. local
  // tool execution) carry no signal. Cumulative sum reads the freshly-
  // inserted row plus prior history so the dashboard never sees a stale
  // cumulative figure. The emitter handles the per-workflow 500 ms
  // throttle.
  const deltaUsd = params.costUsd ?? 0;
  if (deltaUsd > 0) {
    try {
      const cumulativeUsd = sumModelCallCostForWorkflow(db, params.workflowId);
      const source = resolveCostDeltaSource(params.kind, params.source);
      emitCostDelta(params.workflowId, deltaUsd, cumulativeUsd, source);
    } catch {
      // SSE emission MUST NOT break cost recording — the row is committed.
    }
  }

  const capUsd = getWorkflowBudgetUsd();
  if (capUsd !== null) {
    const usedUsd = sumModelCallCostForWorkflow(db, params.workflowId);
    emitBudgetThresholdAlert(db, params.workflowId, usedUsd, capUsd);
  }

  return db
    .prepare(`SELECT * FROM model_calls WHERE id = ?`)
    .get(id) as ModelCallRow;
}

/** Map the recordModelCall input to a `cost_delta` payload `source` value.
 *  Preference order:
 *    1. Explicit `kind` parameter from the caller.
 *    2. `source` if it already matches one of the canonical task kinds.
 *    3. Fallback to 'llm_call' — every existing recordModelCall site today
 *       runs from the llm_call branch in run-task.ts, so this is the safe
 *       default when the caller has not been migrated to pass `kind`. */
function resolveCostDeltaSource(
  kind: CostSourceKind | undefined,
  source: string,
): CostDeltaPayload['source'] {
  if (kind !== undefined) return kind;
  if (COST_SOURCE_KIND_SET.has(source)) return source as CostDeltaPayload['source'];
  return 'llm_call';
}

export function listModelCallsForWorkflow(
  db: Database.Database,
  workflowId: string,
): ModelCallRow[] {
  return db
    .prepare(`SELECT * FROM model_calls WHERE workflow_id = ? ORDER BY created_at ASC`)
    .all(workflowId) as ModelCallRow[];
}

export function sumModelCallCostForWorkflow(
  db: Database.Database,
  workflowId: string,
): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE workflow_id = ?`)
    .get(workflowId) as { total: number };
  return row.total;
}

export interface WorkflowLedgerSummary {
  workflowId: string;
  totalUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export function getLedgerForWorkflow(
  db: Database.Database,
  workflowId: string,
): WorkflowLedgerSummary {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total_usd,
              COUNT(*) AS total_calls,
              COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
              COALESCE(SUM(output_tokens), 0) AS total_output_tokens
       FROM model_calls
       WHERE workflow_id = ?`,
    )
    .get(workflowId) as {
      total_usd: number;
      total_calls: number;
      total_input_tokens: number;
      total_output_tokens: number;
    };
  return {
    workflowId,
    totalUsd: row.total_usd,
    totalCalls: row.total_calls,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
  };
}
