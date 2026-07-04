import type Database from 'better-sqlite3';
import type { Task } from '../../types/index.js';
import { getWorkflowModelSpendUsd } from '../../v2/budget/control.js';
import {
  insertEvent,
  setWorkflowDone,
  setTaskSkipped,
} from '../../db/persist.js';
import {
  EXECUTOR_COST_CAP_EVENT,
  EXECUTOR_COST_CAP_FIELD,
  EXECUTOR_COST_CAP_SKIP_REASON,
} from './cost-cap-meta.js';

const DEFAULT_LLM_ESTIMATE_USD = 0.02;
const DEFAULT_CLI_ESTIMATE_USD = 0.05;

// ── BRAIN-04: in-process cost reservation ledger ──────────────────────────────
// The per-DAG cost cap was a SOFT ceiling: each ready task's pre-dispatch check
// read `used` from the DB (completed model_calls / actual_cost_usd only) and
// compared `used + upcoming <= cap`. When a wide batch fans out in parallel
// (runTaskLoop's Promise.allSettled over the ephemeral batch), every task saw
// the SAME stale `used` — none observed the others' in-flight spend — so N tasks
// each estimating C could all pass and collectively overshoot the cap by
// (N-1)*C, a full batch's worth.
//
// Fix: when a cap is set, reserve a task's estimated cost atomically at the
// check site so the cap becomes a HARD ceiling. enforceWorkflowCostCapBeforeTask
// is synchronous (no await), so on the single-threaded event loop the
// read-check-reserve sequence runs to completion for one task before the next
// task's check begins — concurrent batch members are effectively serialized and
// each sees the prior reservations. The reservation is released once the real
// cost lands in the ledger (finalizeSuccess) or when the workflow terminates
// (orchestrate.ts terminal paths) so a long-lived daemon never accumulates
// stale reservations.
const costReservations = new Map<string, Map<string, number>>();

function sumReservations(workflowId: string): number {
  const perTask = costReservations.get(workflowId);
  if (!perTask) return 0;
  let total = 0;
  for (const v of perTask.values()) total += v;
  return total;
}

function reserveCost(workflowId: string, taskId: string, amount: number): void {
  if (!(amount > 0)) return;
  let perTask = costReservations.get(workflowId);
  if (!perTask) {
    perTask = new Map<string, number>();
    costReservations.set(workflowId, perTask);
  }
  // Overwrite (not add) so a retried task re-checking the cap does not
  // double-count its own prior reservation.
  perTask.set(taskId, amount);
}

/**
 * Release a single task's cost reservation once its real spend is recorded
 * (so the estimate is not double-counted against the actual ledger value) or
 * the task reached a terminal state. Idempotent — safe to call when no
 * reservation exists. Fail-safe (never throws).
 */
export function releaseCostReservation(workflowId: string, taskId: string): void {
  const perTask = costReservations.get(workflowId);
  if (!perTask) return;
  perTask.delete(taskId);
  if (perTask.size === 0) costReservations.delete(workflowId);
}

/**
 * Drop all cost reservations for a workflow. Called at workflow terminal points
 * (success / failure) so the per-process ledger cannot leak across runs on a
 * long-lived daemon. Idempotent + fail-safe.
 */
export function clearWorkflowCostReservations(workflowId: string): void {
  costReservations.delete(workflowId);
}

/** Test/diagnostic helper — current reserved (committed-but-unspent) USD. */
export function getReservedCostUsd(workflowId: string): number {
  return sumReservations(workflowId);
}

export class WorkflowCostCapError extends Error {
  constructor(
    message: string,
    public readonly workflowId: string,
    public readonly used: number,
    public readonly cap: number,
  ) {
    super(message);
    this.name = 'WorkflowCostCapError';
  }
}

export function getWorkflowMaxTotalCostUsd(
  db: Database.Database,
  workflowId: string,
): number | null {
  const row = db
    .prepare(`SELECT ${EXECUTOR_COST_CAP_FIELD} AS cap FROM workflows WHERE id = ?`)
    .get(workflowId) as { cap: number | null } | undefined;
  const v = row?.cap;
  if (v == null || !Number.isFinite(Number(v))) return null;
  return Number(v);
}

/**
 * Spend counted toward the per-DAG cap: `workflows.actual_cost_usd` when set,
 * otherwise the sum of `model_calls.cost_usd` for the workflow (executor path).
 */
export function getWorkflowUsedUsdForCap(db: Database.Database, workflowId: string): number {
  const row = db
    .prepare('SELECT actual_cost_usd AS a FROM workflows WHERE id = ?')
    .get(workflowId) as { a: number | null } | undefined;
  const col = row?.a;
  if (col != null && Number.isFinite(Number(col))) return Number(col);
  return getWorkflowModelSpendUsd(db, workflowId);
}

/**
 * Best-effort USD cost the next execution of this task may incur (for pre-run cap checks).
 * Prefers DAG `estimated_cost_usd` copied into `input_json`, else kind defaults.
 *
 * Optional `db` + `workflowId` enable observability of malformed `input_json` —
 * F-D1-2 compliance: silent catches on critical paths must emit an event.
 */
export function estimateUpcomingCost(
  task: Task,
  db?: Database.Database,
  workflowId?: string,
): number {
  if (task.kind !== 'llm_call' && task.kind !== 'cli_spawn') return 0;
  let fromInput: number | undefined;
  try {
    const ctx = task.input_json ? JSON.parse(task.input_json) as Record<string, unknown> : {};
    const v = ctx['estimated_cost_usd'];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) fromInput = v;
  } catch (err) {
    // Malformed input_json — fall back to kind defaults. Emit a low-noise
    // observability event so this is enumerable (F-D1-2). Never let the
    // event itself break the cost-cap path.
    if (db && workflowId) {
      try {
        insertEvent(db, {
          workflow_id: workflowId,
          task_id: task.id,
          type: 'cost_cap_metadata_parse_failed',
          payload: { error: (err as Error).message ?? String(err) },
        });
      } catch {
        /* observability failure must not break cost-cap */
      }
    }
  }
  if (fromInput !== undefined) return fromInput;
  if (task.kind === 'llm_call') return DEFAULT_LLM_ESTIMATE_USD;
  return DEFAULT_CLI_ESTIMATE_USD;
}

/**
 * When the DAG cap would be exceeded before running `llm_call` / `cli_spawn`,
 * skip pending work, fail the workflow, emit `workflow_cost_cap_hit`, and throw.
 */
export function enforceWorkflowCostCapBeforeTask(
  db: Database.Database,
  task: Task,
  wfId: string,
  allTasks: Task[] | undefined,
): void {
  if (task.kind !== 'llm_call' && task.kind !== 'cli_spawn') return;
  const cap = getWorkflowMaxTotalCostUsd(db, wfId);
  if (cap == null) return;

  const used = getWorkflowUsedUsdForCap(db, wfId);
  const upcoming = estimateUpcomingCost(task, db, wfId);

  // BRAIN-04 — HARD ceiling: count already-reserved (committed-but-unspent)
  // estimates from concurrent batch members so a parallel fan-out cannot all
  // pass against the same stale `used`. This block is synchronous; on the
  // single-threaded event loop the read-check-reserve runs atomically with
  // respect to other tasks' checks. Exclude any prior reservation made by THIS
  // task (retry re-entry) so it doesn't count its own estimate twice.
  const reservedByOthers =
    sumReservations(wfId) - (costReservations.get(wfId)?.get(task.id) ?? 0);

  if (used + reservedByOthers + upcoming <= cap + 1e-9) {
    // Reserve this task's estimate before returning so the next concurrent
    // check sees it. Released in finalizeSuccess (once real cost is ledgered)
    // or at workflow terminal cleanup.
    reserveCost(wfId, task.id, upcoming);
    return;
  }

  // Snapshot before mutating the current task — it is still `pending` here.
  const remaining_tasks = (allTasks ?? []).filter((t) => t.status === 'pending').map((t) => t.id);

  // This task is being skipped; drop any reservation it might have held from a
  // prior attempt so it does not inflate the ceiling for siblings.
  releaseCostReservation(wfId, task.id);

  setTaskSkipped(
    db,
    task.id,
    JSON.stringify({
      skip_reason: EXECUTOR_COST_CAP_SKIP_REASON,
      used,
      cap,
      upcoming,
      reserved: reservedByOthers,
    }),
  );
  task.status = 'skipped';

  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: EXECUTOR_COST_CAP_EVENT,
    payload: {
      workflow_id: wfId,
      used,
      reserved: reservedByOthers,
      cap,
      remaining_tasks,
    },
  });

  for (const t of allTasks ?? []) {
    if (t.id === task.id) continue;
    if (t.status !== 'pending') continue;
    setTaskSkipped(db, t.id, JSON.stringify({ skip_reason: 'cost_cap_pending_after_cap' }));
    t.status = 'skipped';
  }

  setWorkflowDone(db, wfId, 'failed');
  // Workflow is terminating on a cap hit — drop its reservations.
  clearWorkflowCostReservations(wfId);
  throw new WorkflowCostCapError(
    `Workflow ${wfId} halted: cost cap $${cap.toFixed(4)} would be exceeded ` +
      `(used $${used.toFixed(4)} + estimate $${upcoming.toFixed(4)})`,
    wfId,
    used,
    cap,
  );
}
