import type Database from 'better-sqlite3';
import { insertEvent } from '../../db/persist.js';
import { notifyTelegram } from '../../utils/telegram-notify.js';
import type { BudgetThresholdEvent } from '../../types/index.js';

export class BudgetExceededError extends Error {
  readonly workflowId: string;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  constructor(workflowId: string, spentUsd: number, budgetUsd: number) {
    super(
      `Workflow model budget exceeded: spent $${spentUsd.toFixed(4)} > budget $${budgetUsd.toFixed(4)}`,
    );
    this.name = 'BudgetExceededError';
    this.workflowId = workflowId;
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
  }
}

/**
 * Pre-call cost-router enforce gate (Aurora-parity Wave 2, opt-in via
 * OMNIFORGE_COST_ROUTER_ENFORCE). Distinct from BudgetExceededError so the
 * audit message does NOT claim money was already spent: the gate fires BEFORE
 * any HTTP call, comparing the upcoming call's ESTIMATED cost against the
 * remaining budget HEADROOM (not the cap, and not realized spend). Subclasses
 * BudgetExceededError so the retry loop still recognises it as terminal
 * (`err instanceof BudgetExceededError`) and never retries it, while the fields
 * are correctly labelled (`estimatedCostUsd` / `headroomUsd`).
 */
/**
 * Pre-dispatch cost-router enforce gate. Subclasses BudgetExceededError so the
 * retry loop's `err instanceof BudgetExceededError` terminal check still treats
 * it as non-retryable — but read `estimatedCostUsd` / `headroomUsd` here, NOT
 * the inherited `spentUsd` / `budgetUsd`: on this subclass those inherited
 * fields hold the upcoming-call ESTIMATE and the remaining HEADROOM respectively
 * (no money was spent — the call was blocked before dispatch).
 */
export class CostRouterBudgetExceededError extends BudgetExceededError {
  readonly estimatedCostUsd: number;
  readonly headroomUsd: number;
  constructor(workflowId: string, estimatedCostUsd: number, headroomUsd: number) {
    super(workflowId, estimatedCostUsd, headroomUsd);
    // Overwrite the inherited "spent $X > budget $Y" message — nothing was
    // spent yet; this is a forward-looking estimate vs remaining headroom.
    this.message =
      `Cost-router budget gate: next call (est. $${estimatedCostUsd.toFixed(4)}) ` +
      `exceeds remaining budget headroom ($${headroomUsd.toFixed(4)}); ` +
      `no in-budget model met the required quality. Blocked before dispatch (no spend).`;
    this.name = 'CostRouterBudgetExceededError';
    this.estimatedCostUsd = estimatedCostUsd;
    this.headroomUsd = headroomUsd;
  }
}

function parseBudgetEnv(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function getWorkflowBudgetUsd(): number | null {
  return parseBudgetEnv(process.env.OMNIFORGE_WORKFLOW_BUDGET_USD);
}

/**
 * True if any row returned by `sql` (a SELECT of events.payload_json) has a
 * JSON payload matching `predicate`. Malformed payloads are skipped.
 */
function anyEventPayloadMatches(
  db: Database.Database,
  sql: string,
  params: ReadonlyArray<string | number>,
  predicate: (payload: unknown) => boolean,
): boolean {
  const rows = db.prepare(sql).all(...params) as Array<{ payload_json: string | null }>;
  for (const row of rows) {
    if (!row.payload_json) continue;
    try {
      if (predicate(JSON.parse(row.payload_json))) return true;
    } catch {
      // ignore malformed payload
    }
  }
  return false;
}

export function getWorkflowModelSpendUsd(
  db: Database.Database,
  workflowId: string,
): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE workflow_id = ?')
    .get(workflowId) as { total: number | null };
  return row.total ?? 0;
}

function wasThresholdAlreadyEmitted(
  db: Database.Database,
  workflowId: string,
  thresholdPct: number,
): boolean {
  return anyEventPayloadMatches(
    db,
    `SELECT payload_json FROM events
     WHERE workflow_id = ? AND type = 'budget_threshold_crossed'
     ORDER BY timestamp DESC`,
    [workflowId],
    (payload) => (payload as BudgetThresholdEvent).threshold_pct === thresholdPct,
  );
}

const THRESHOLDS = [50, 75, 90, 100] as const;
export const BUDGET_THRESHOLD_PCTS = THRESHOLDS;

export function emitBudgetThresholdAlert(
  db: Database.Database,
  workflowId: string,
  usedUsd: number,
  capUsd: number,
): void {
  if (capUsd <= 0) return;
  const pct = (usedUsd / capUsd) * 100;
  for (const threshold of THRESHOLDS) {
    if (pct >= threshold) {
      if (wasThresholdAlreadyEmitted(db, workflowId, threshold)) continue;
      insertEvent(db, {
        workflow_id: workflowId,
        type: 'budget_threshold_crossed',
        payload: {
          threshold_pct: threshold,
          used: usedUsd,
          cap: capUsd,
        } satisfies BudgetThresholdEvent,
      });
    }
  }
}

export function assertWorkflowBudgetAllowsModelCall(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  // Estimated cost of the call we're ABOUT to make. Including it makes the guard
  // forward-looking (pre-reservation) so a single expensive call can't overshoot
  // the cap before enforcement fires (Aurora dogfood finding). Default 0 keeps
  // the historic backward-looking behaviour for callers that don't estimate.
  pendingCostUsd = 0,
): void {
  const budget = getWorkflowBudgetUsd();
  if (budget === null) return;
  const spent = getWorkflowModelSpendUsd(db, workflowId);
  const projected = spent + Math.max(0, pendingCostUsd);
  if (projected <= budget) return;

  insertEvent(db, {
    workflow_id: workflowId,
    task_id: taskId,
    type: 'workflow_budget_exceeded',
    payload: {
      budget_usd: budget,
      spent_usd: spent,
      pending_cost_usd: pendingCostUsd,
      projected_usd: projected,
    },
  });
  throw new BudgetExceededError(workflowId, projected, budget);
}

// ─────────────────────────────────────────────────────────────────────────────
// Global / daily hard spend ceiling (Aurora-parity Wave 0).
//
// `assertWorkflowBudgetAllowsModelCall` only caps a SINGLE workflow. A solo
// operator running an overnight loop, or many workflows back-to-back, has no
// aggregate ceiling — each workflow's budget resets independently, so a runaway
// can drain the account. These add a rolling-24h ceiling (OMNIFORGE_DAILY_BUDGET_USD)
// and an all-time ceiling (OMNIFORGE_MAX_SPEND_USD) that BLOCK the next LLM call
// (not just report) and fire a one-shot Telegram alert before blocking.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling-24h spend ceiling across ALL workflows. */
export function getDailyBudgetUsd(): number | null {
  return parseBudgetEnv(process.env.OMNIFORGE_DAILY_BUDGET_USD);
}

/** All-time spend ceiling across ALL workflows. */
export function getMaxSpendUsd(): number | null {
  return parseBudgetEnv(process.env.OMNIFORGE_MAX_SPEND_USD);
}

/**
 * SUM(cost_usd) across every workflow. When `sinceMs` is provided, only counts
 * model_calls with created_at >= sinceMs (rolling window). created_at is unix ms
 * (matches Date.now()). NOTE: there is no standalone index on created_at, so this
 * is a full scan of model_calls — fine for a single-operator DB; add a dedicated
 * idx_model_calls_created_at if the table ever grows large.
 */
export function getGlobalModelSpendUsd(db: Database.Database, sinceMs?: number): number {
  const row = (sinceMs === undefined
    ? db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls').get()
    : db
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE created_at >= ?')
        .get(sinceMs)) as { total: number | null };
  return row.total ?? 0;
}

export type GlobalBudgetScope = 'daily' | 'total';

export class GlobalBudgetExceededError extends Error {
  readonly scope: GlobalBudgetScope;
  readonly spentUsd: number;
  readonly budgetUsd: number;
  constructor(scope: GlobalBudgetScope, spentUsd: number, budgetUsd: number) {
    super(
      `Global ${scope} model budget exceeded: spent $${spentUsd.toFixed(4)} > budget $${budgetUsd.toFixed(4)}`,
    );
    this.name = 'GlobalBudgetExceededError';
    this.scope = scope;
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
  }
}

/**
 * True if a `global_budget_exceeded` event for `scope` already exists at/after
 * `sinceMs`. Reuses the threshold-dedupe pattern so the Telegram alert fires
 * once per window instead of on every blocked call.
 */
function wasGlobalBudgetEventEmitted(
  db: Database.Database,
  scope: GlobalBudgetScope,
  sinceMs: number,
): boolean {
  return anyEventPayloadMatches(
    db,
    `SELECT payload_json FROM events
     WHERE type = 'global_budget_exceeded' AND timestamp >= ?
     ORDER BY timestamp DESC`,
    [sinceMs],
    (payload) => (payload as { scope?: string }).scope === scope,
  );
}

function breachGlobalBudget(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  scope: GlobalBudgetScope,
  spent: number,
  budget: number,
  windowStartMs: number,
): never {
  // One-shot per scope per window (mirrors emitBudgetThresholdAlert dedupe):
  // record the breach event AND fire the Telegram alert only on the first
  // breach in the window — subsequent blocked calls still throw, but don't
  // spam the audit log or the operator. The throw is unconditional.
  if (!wasGlobalBudgetEventEmitted(db, scope, windowStartMs)) {
    insertEvent(db, {
      workflow_id: workflowId,
      task_id: taskId,
      type: 'global_budget_exceeded',
      payload: { scope, budget_usd: budget, spent_usd: spent },
    });
    // Fire-and-forget; notifyTelegram already swallows transport errors.
    notifyTelegram(
      `🚨 Omniforge ${scope} budget exceeded: spent $${spent.toFixed(2)} > cap $${budget.toFixed(2)}. Blocking further LLM calls.`,
    ).catch(() => {
      /* non-fatal: never block a workflow on a failed notification */
    });
  }
  throw new GlobalBudgetExceededError(scope, spent, budget);
}

/**
 * Aggregate spend guard. Call alongside `assertWorkflowBudgetAllowsModelCall`
 * before issuing a model call. Daily (rolling 24h) is checked before the
 * all-time cap. No-op when neither env var is set.
 */
export function assertGlobalBudgetAllowsModelCall(
  db: Database.Database,
  workflowId: string,
  taskId: string,
  nowMs: number = Date.now(),
  // Estimated cost of the upcoming call — folded in so the ceiling is
  // forward-looking (pre-reservation) rather than backward-looking. Default 0
  // keeps the historic behaviour. (Last param so existing positional callers
  // passing only nowMs are unaffected.)
  pendingCostUsd = 0,
): void {
  const pending = Math.max(0, pendingCostUsd);
  const dailyBudget = getDailyBudgetUsd();
  if (dailyBudget !== null) {
    const windowStart = nowMs - DAY_MS;
    const dailyProjected = getGlobalModelSpendUsd(db, windowStart) + pending;
    if (dailyProjected > dailyBudget) {
      breachGlobalBudget(db, workflowId, taskId, 'daily', dailyProjected, dailyBudget, windowStart);
    }
  }

  const maxSpend = getMaxSpendUsd();
  if (maxSpend !== null) {
    const totalProjected = getGlobalModelSpendUsd(db) + pending;
    if (totalProjected > maxSpend) {
      // All-time scope: dedupe window is the whole history (sinceMs = 0).
      breachGlobalBudget(db, workflowId, taskId, 'total', totalProjected, maxSpend, 0);
    }
  }
}

/**
 * Remaining spend headroom (USD) across whichever budget caps are set — the
 * per-call budget the Aurora-parity Wave-2 cost router uses to downshift to a
 * cheaper model as a cap is approached. Returns the MIN of:
 *   - workflow cap (OMNIFORGE_WORKFLOW_BUDGET_USD) − this workflow's spend
 *   - daily cap   (OMNIFORGE_DAILY_BUDGET_USD)    − rolling-24h global spend
 *   - all-time cap (OMNIFORGE_MAX_SPEND_USD)      − all-time global spend
 * floored at 0. Returns null when NO cap is set (no constraint → router no-ops).
 *
 * This is advisory routing input only; the HARD ceiling enforcement that BLOCKS
 * a call still lives in assertWorkflowBudgetAllowsModelCall /
 * assertGlobalBudgetAllowsModelCall (pre-dispatch). When headroom is 0, those
 * guards have already blocked the call before routing is consulted.
 */
export function getRemainingBudgetHeadroomUsd(
  db: Database.Database,
  workflowId: string,
  nowMs: number = Date.now(),
): number | null {
  const remainings: number[] = [];

  const workflowCap = getWorkflowBudgetUsd();
  if (workflowCap !== null) {
    remainings.push(workflowCap - getWorkflowModelSpendUsd(db, workflowId));
  }
  const dailyCap = getDailyBudgetUsd();
  if (dailyCap !== null) {
    remainings.push(dailyCap - getGlobalModelSpendUsd(db, nowMs - DAY_MS));
  }
  const totalCap = getMaxSpendUsd();
  if (totalCap !== null) {
    remainings.push(totalCap - getGlobalModelSpendUsd(db));
  }

  if (remainings.length === 0) return null;
  return Math.max(0, Math.min(...remainings));
}

/** Alias for emitBudgetThresholdAlert (C2 API compat). */
export const emitBudgetAlert = emitBudgetThresholdAlert;

