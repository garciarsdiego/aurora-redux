/**
 * Tier 0 Wave 4 item 0.3 — HITL gate orphan recovery sweep.
 *
 * Problem: `src/brain/executor/hitl-gate.ts` inserts a `hitl_gates` row in
 * `pending` state and then polls until the row flips to a terminal status
 * (`approved` | `rejected` | `modify`). If the daemon crashes between the
 * insert and the operator's response, the row stays `pending` forever and
 * the next daemon start has no mechanism to surface it. The executor that
 * was awaiting the gate is also gone, so even an operator approval would
 * have nothing to unblock.
 *
 * Strategy: on daemon start, scan `hitl_gates` for `status = 'pending'` rows
 * older than the configurable window (default 5 min). For each one, emit a
 * `hitl_gate_orphan_recovered` event so the operator + dashboard can see it
 * and decide what to do. We DO NOT auto-resolve — that's a policy call only
 * the operator should make. We mark `context_json.recovery_attempted_at` so
 * a second sweep over the same DB does not double-emit (idempotency).
 *
 * No new migration is needed: `context_json` already exists as a TEXT JSON
 * blob (see `src/db/schema.sql:388`), and the existing callers already merge
 * arbitrary keys into it (mcp_feedback, etc.).
 */

import type Database from 'better-sqlite3';
import { insertEvent } from './persist.js';
import { safeJsonObject } from './safe-json.js';
import { withSqliteRetrySync } from './sqlite-retry.js';

const DEFAULT_ORPHAN_AGE_MS = 5 * 60_000;
const ENV_KEY = 'OMNIFORGE_HITL_ORPHAN_AGE_MS';

export interface HitlOrphanRecoveryResult {
  /** Pending gates older than the window that were inspected. */
  scanned: number;
  /** Orphans surfaced via `hitl_gate_orphan_recovered` event this sweep. */
  surfaced: number;
  /** Pending+old gates skipped because already attempted (idempotency hit). */
  skipped: number;
  errors: Array<{ gate_id: string; error: string }>;
}

export interface HitlOrphanRecoveryOptions {
  /**
   * Override the orphan age window (ms). Falls through to
   * `OMNIFORGE_HITL_ORPHAN_AGE_MS` then to the 5-min default.
   */
  windowMs?: number;
  /**
   * Override "now" for deterministic testing. Defaults to `Date.now()`.
   */
  now?: number;
}

interface PendingGateRow {
  id: string;
  workflow_id: string;
  task_id: string | null;
  channel: string | null;
  context_json: string | null;
  created_at: number;
}

function resolveWindowMs(opts?: HitlOrphanRecoveryOptions): number {
  if (opts?.windowMs != null && Number.isFinite(opts.windowMs) && opts.windowMs >= 0) {
    return opts.windowMs;
  }
  const raw = process.env[ENV_KEY]?.trim();
  if (!raw) return DEFAULT_ORPHAN_AGE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_ORPHAN_AGE_MS;
  return parsed;
}

/**
 * Scan for orphan HITL gates and emit a discovery event for each. Idempotent:
 * a second invocation against the same DB state does not double-emit because
 * `context_json.recovery_attempted_at` is set on the first sweep.
 *
 * Constraints (per Tier 0 Wave 4 0.3):
 *   - Do NOT auto-resolve gates. Surface only.
 *   - Use the retry-wrapped insertEvent helper (DB-A).
 *   - Don't add a new column unless absolutely needed (we don't).
 */
export function recoverOrphanHitlGates(
  db: Database.Database,
  opts?: HitlOrphanRecoveryOptions,
): HitlOrphanRecoveryResult {
  const now = opts?.now ?? Date.now();
  const windowMs = resolveWindowMs(opts);
  const cutoff = now - windowMs;

  const result: HitlOrphanRecoveryResult = {
    scanned: 0,
    surfaced: 0,
    skipped: 0,
    errors: [],
  };

  let rows: PendingGateRow[];
  try {
    rows = db
      .prepare(
        `SELECT id, workflow_id, task_id, channel, context_json, created_at
           FROM hitl_gates
          WHERE status = 'pending'
            AND created_at < ?
          ORDER BY created_at ASC`,
      )
      .all(cutoff) as PendingGateRow[];
  } catch (err) {
    // Catastrophic query failure — surface as a single synthetic error so the
    // daemon log captures it. No partial state to clean up.
    result.errors.push({
      gate_id: '*',
      error: `query failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return result;
  }

  result.scanned = rows.length;

  for (const row of rows) {
    // Corrupted context_json collapses to {} so `recovery_attempted_at`
    // itself is always persistable via a fresh wrapper.
    const context = safeJsonObject(row.context_json);
    if (typeof context.recovery_attempted_at === 'number') {
      // Already surfaced on a prior sweep — keep silent.
      result.skipped += 1;
      continue;
    }

    const ageMs = now - row.created_at;
    const payload = {
      gate_id: row.id,
      workflow_id: row.workflow_id,
      task_id: row.task_id,
      channel: row.channel,
      age_ms: ageMs,
      created_at: row.created_at,
      window_ms: windowMs,
    } as const;

    try {
      const nextContext = { ...context, recovery_attempted_at: now };
      withSqliteRetrySync(() =>
        db
          .prepare(`UPDATE hitl_gates SET context_json = ? WHERE id = ?`)
          .run(JSON.stringify(nextContext), row.id),
      );

      // insertEvent already retries on SQLITE_BUSY internally and is wired to
      // the event broker so SSE subscribers see the orphan in real time.
      insertEvent(db, {
        workflow_id: row.workflow_id,
        task_id: row.task_id,
        type: 'hitl_gate_orphan_recovered',
        payload,
      });

      result.surfaced += 1;
    } catch (err) {
      result.errors.push({
        gate_id: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
