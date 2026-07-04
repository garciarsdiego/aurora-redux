// Aurora Tier 0 / Wave 4 / item 0.4 (F-REL-2 follow-up):
// transactional-outbox for trigger dispatches.
//
// Every schedule tick + webhook receive records a `trigger_fires` row BEFORE
// the dispatch attempt. On daemon startup `runTriggerOrphanRetrySweep` scans
// for rows whose dispatch never completed (dispatched_at IS NULL after the
// grace window) and re-attempts the workflow creation. This closes the
// race window in F-REL-2 where a daemon crash between "schedule is due" and
// "workflow row inserted" silently dropped the trigger fire.
//
// The grace window (5 minutes by default) lets in-flight dispatches finish
// before the sweep treats them as orphaned. Sweep runs ONCE on daemon
// bootstrap; the 60-second tick loop already handles steady-state retries
// for transient failures via `dashboard_schedule_runs`.

import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { initDb } from '../../db/client.js';
import { getDbPath } from '../../utils/config.js';
import { insertEvent, setDaemonState } from '../../db/persist.js';
import { runDashboardTriggerTarget } from './_dashboard-dag-helpers.js';

export const TRIGGER_FIRE_GRACE_MS = 5 * 60 * 1000;
const TRIGGER_FIRE_SWEEP_LIMIT = 50;

export type TriggerSource = 'schedule' | 'webhook';
export type TriggerTargetKind = 'objective' | 'dag';

export interface TriggerFireInput {
  trigger_source: TriggerSource;
  schedule_id?: string | null;
  webhook_id?: string | null;
  invocation_id?: string | null;
  workspace: string;
  target_kind: TriggerTargetKind;
  target_ref: string;
  input_payload_json: string;
  live_payload?: string | null;
  attempt?: number;
}

export interface TriggerFireRow {
  id: string;
  trigger_source: TriggerSource;
  schedule_id: string | null;
  webhook_id: string | null;
  invocation_id: string | null;
  workspace: string;
  target_kind: TriggerTargetKind;
  target_ref: string;
  input_payload_json: string;
  live_payload: string | null;
  fired_at: number;
  dispatched_at: number | null;
  workflow_id: string | null;
  attempt: number;
  error: string | null;
  created_at: number;
}

export interface TriggerOrphanSweepResult {
  scanned: number;
  dispatched: string[];   // trigger_fire ids that completed
  failed: Array<{ id: string; error: string }>;
  skipped: number;        // rows still inside grace window
}

function makeTriggerFireId(): string {
  return `tf_${randomBytes(10).toString('hex')}`;
}

/**
 * Record a fire attempt BEFORE dispatch. Caller must wrap the dispatch in a
 * try/catch and invoke `markTriggerFireDispatched` (success) or
 * `markTriggerFireError` (failure) on the returned id.
 *
 * Failures here are intentionally surfaced — if we cannot record the fire,
 * the caller should not proceed with the dispatch (we would lose the audit
 * trail on a daemon crash).
 */
export function recordTriggerFire(
  db: Database.Database,
  input: TriggerFireInput,
  now = Date.now(),
): TriggerFireRow {
  const row: TriggerFireRow = {
    id: makeTriggerFireId(),
    trigger_source: input.trigger_source,
    schedule_id: input.trigger_source === 'schedule' ? (input.schedule_id ?? null) : null,
    webhook_id: input.trigger_source === 'webhook' ? (input.webhook_id ?? null) : null,
    invocation_id: input.invocation_id ?? null,
    workspace: input.workspace,
    target_kind: input.target_kind,
    target_ref: input.target_ref,
    input_payload_json: input.input_payload_json,
    live_payload: input.live_payload ?? null,
    fired_at: now,
    dispatched_at: null,
    workflow_id: null,
    attempt: input.attempt ?? 1,
    error: null,
    created_at: now,
  };

  if (row.trigger_source === 'schedule' && !row.schedule_id) {
    throw new Error('recordTriggerFire: trigger_source=schedule requires schedule_id');
  }
  if (row.trigger_source === 'webhook' && !row.webhook_id) {
    throw new Error('recordTriggerFire: trigger_source=webhook requires webhook_id');
  }

  db.prepare(
    `INSERT INTO trigger_fires
       (id, trigger_source, schedule_id, webhook_id, invocation_id, workspace,
        target_kind, target_ref, input_payload_json, live_payload,
        fired_at, dispatched_at, workflow_id, attempt, error, created_at)
     VALUES
       (@id, @trigger_source, @schedule_id, @webhook_id, @invocation_id, @workspace,
        @target_kind, @target_ref, @input_payload_json, @live_payload,
        @fired_at, @dispatched_at, @workflow_id, @attempt, @error, @created_at)`,
  ).run(row);

  return row;
}

/**
 * Mark a fire as successfully dispatched. Idempotent: re-calling with a
 * different workflow_id will overwrite (last write wins) — but the recovery
 * sweep never re-fires an already-dispatched row, so this should not happen.
 *
 * Emits `trigger_fire_dispatched` on the workflow's event stream so the
 * F-REL-2 observability gap (schedule tick is invisible from workflow side)
 * is closed.
 */
export function markTriggerFireDispatched(
  db: Database.Database,
  id: string,
  workflowId: string,
  now = Date.now(),
): void {
  const result = db.prepare(
    `UPDATE trigger_fires
        SET dispatched_at = ?, workflow_id = ?, error = NULL
      WHERE id = ?`,
  ).run(now, workflowId, id);

  if (result.changes === 0) {
    // Sweep recovery may legitimately race with normal completion. Surface
    // it as an event but do not throw — the workflow itself ran fine.
    try {
      insertEvent(db, {
        workflow_id: workflowId,
        type: 'trigger_fire_dispatch_mismatch',
        payload: { trigger_fire_id: id, dispatched_at: now },
      });
    } catch {
      // best-effort observability; never block the dispatch path.
    }
    return;
  }

  try {
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'trigger_fire_dispatched',
      payload: { trigger_fire_id: id, dispatched_at: now },
    });
  } catch {
    // observability is best-effort; the row update is the source of truth.
  }
}

/**
 * Record a dispatch failure WITHOUT clearing dispatched_at. The sweep will
 * retry the row on next daemon start (fired_at + grace window).
 */
export function markTriggerFireError(
  db: Database.Database,
  id: string,
  error: string,
): void {
  db.prepare(
    `UPDATE trigger_fires
        SET error = ?
      WHERE id = ?`,
  ).run(error, id);
}

/**
 * Emit the `trigger_fire_recorded` event onto an EXISTING workflow stream.
 * This is purely observability — F-REL-2 wanted operators to see in the
 * workflow timeline that "this run came from trigger X at time Y". We only
 * call this AFTER the workflow has been created (we have a real workflow_id
 * to attach to).
 */
export function emitTriggerFireRecordedEvent(
  db: Database.Database,
  fireId: string,
  workflowId: string,
  trigger: {
    source: TriggerSource;
    schedule_id?: string | null;
    webhook_id?: string | null;
    invocation_id?: string | null;
    fired_at: number;
  },
): void {
  try {
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'trigger_fire_recorded',
      payload: {
        trigger_fire_id: fireId,
        trigger_source: trigger.source,
        schedule_id: trigger.schedule_id ?? null,
        webhook_id: trigger.webhook_id ?? null,
        invocation_id: trigger.invocation_id ?? null,
        fired_at: trigger.fired_at,
      },
    });
  } catch {
    // Best-effort — the trigger_fires row remains the source of truth.
  }
}

interface OrphanRow {
  id: string;
  trigger_source: TriggerSource;
  schedule_id: string | null;
  webhook_id: string | null;
  workspace: string;
  target_kind: TriggerTargetKind;
  target_ref: string;
  input_payload_json: string;
  live_payload: string | null;
  fired_at: number;
  attempt: number;
  schedule_is_active: 0 | 1 | null;
  webhook_is_active: 0 | 1 | null;
}

/**
 * Scan `trigger_fires` for rows that are past the grace window and still
 * undispatched. For each, attempt to create the workflow via the standard
 * `runDashboardTriggerTarget` helper. On success, fill dispatched_at +
 * workflow_id. On failure, write the error and leave dispatched_at NULL —
 * next daemon start will retry.
 *
 * Designed to be called from `daemon.runForeground()` BEFORE the HTTP
 * server starts accepting traffic. Safe to call repeatedly; rows already
 * dispatched are excluded by the partial index.
 */
export async function runTriggerOrphanRetrySweep(
  options: { now?: number; graceMs?: number; dbPath?: string } = {},
): Promise<TriggerOrphanSweepResult> {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? TRIGGER_FIRE_GRACE_MS;
  const db = initDb(options.dbPath ?? getDbPath());
  const result: TriggerOrphanSweepResult = {
    scanned: 0,
    dispatched: [],
    failed: [],
    skipped: 0,
  };
  const startedAt = Date.now();

  try {
    // Count the rows that exist but are still inside the grace window. This
    // lets daemon_state expose a meaningful "skipped" tally.
    const skippedRow = db.prepare(
      `SELECT COUNT(*) AS n FROM trigger_fires
        WHERE dispatched_at IS NULL AND fired_at >= ?`,
    ).get(now - graceMs) as { n: number };
    result.skipped = skippedRow.n;

    const rows = db.prepare(
      `SELECT tf.id, tf.trigger_source, tf.schedule_id, tf.webhook_id,
              tf.workspace, tf.target_kind, tf.target_ref,
              tf.input_payload_json, tf.live_payload, tf.fired_at, tf.attempt,
              s.is_active AS schedule_is_active,
              w.is_active AS webhook_is_active
         FROM trigger_fires tf
         LEFT JOIN dashboard_schedules s ON s.id = tf.schedule_id
         LEFT JOIN dashboard_webhook_triggers w ON w.id = tf.webhook_id
        WHERE tf.dispatched_at IS NULL AND tf.fired_at < ?
        ORDER BY tf.fired_at ASC
        LIMIT ?`,
    ).all(now - graceMs, TRIGGER_FIRE_SWEEP_LIMIT) as OrphanRow[];

    result.scanned = rows.length;

    for (const row of rows) {
      // Guard: skip rows whose parent trigger has been disabled since the
      // fire — operator deliberately stopped them. We still leave the row
      // alone (dispatched_at NULL) so it shows up in audit reports.
      const parentDisabled =
        (row.trigger_source === 'schedule' && row.schedule_is_active === 0)
        || (row.trigger_source === 'webhook' && row.webhook_is_active === 0);
      if (parentDisabled) {
        markTriggerFireError(db, row.id, 'parent trigger disabled before recovery');
        result.failed.push({ id: row.id, error: 'parent trigger disabled before recovery' });
        continue;
      }

      let payload: unknown = {};
      try {
        payload = JSON.parse(row.input_payload_json) as unknown;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markTriggerFireError(db, row.id, `invalid payload: ${msg}`);
        result.failed.push({ id: row.id, error: `invalid payload: ${msg}` });
        continue;
      }

      try {
        const dispatchResult = await runDashboardTriggerTarget({
          workspace: row.workspace,
          target_kind: row.target_kind,
          target_ref: row.target_ref,
          input_payload: payload,
          ...(row.live_payload ? { live_payload: row.live_payload } : {}),
        });
        const workflowId = typeof dispatchResult['workflow_id'] === 'string'
          ? dispatchResult['workflow_id']
          : null;
        if (!workflowId) {
          markTriggerFireError(db, row.id, 'dispatch returned no workflow_id');
          result.failed.push({ id: row.id, error: 'dispatch returned no workflow_id' });
          continue;
        }
        markTriggerFireDispatched(db, row.id, workflowId, Date.now());
        emitTriggerFireRecordedEvent(db, row.id, workflowId, {
          source: row.trigger_source,
          schedule_id: row.schedule_id,
          webhook_id: row.webhook_id,
          fired_at: row.fired_at,
        });
        result.dispatched.push(row.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markTriggerFireError(db, row.id, msg);
        result.failed.push({ id: row.id, error: msg });
      }
    }

    return result;
  } finally {
    try {
      setDaemonState(db, 'trigger_orphan_sweep', {
        status: result.failed.length === 0 ? 'ok' : 'partial',
        scanned: result.scanned,
        dispatched: result.dispatched.length,
        failed: result.failed.length,
        skipped: result.skipped,
        duration_ms: Date.now() - startedAt,
      });
    } catch (persistErr) {
      process.stderr.write(`[daemon] failed to persist trigger_orphan_sweep state: ${
        persistErr instanceof Error ? persistErr.message : String(persistErr)
      }\n`);
    }
    db.close();
  }
}
