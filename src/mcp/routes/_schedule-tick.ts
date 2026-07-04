// Sprint 4.6 (D-H2.066): schedule tick implementation.
//
// Shared between triggers router (manual "Tick now" button) and the daemon
// bootstrap timer (every 60s). Sprint 2.6 added per-tick observability:
// every run — success or failure — writes daemon_state['schedule_tick'].

import { randomBytes } from 'node:crypto';
import { initDb } from '../../db/client.js';
import { setDaemonState } from '../../db/persist.js';
import { getDbPath } from '../../utils/config.js';
import {
  advanceDashboardSchedule,
  dueDashboardSchedules,
  insertDashboardScheduleRun,
  markDashboardScheduleRun,
} from '../dashboard-triggers.js';
import { runDashboardTriggerTarget } from './_dashboard-dag-helpers.js';
import {
  emitTriggerFireRecordedEvent,
  markTriggerFireDispatched,
  markTriggerFireError,
  recordTriggerFire,
} from './_trigger-orphan-retry.js';

interface DashboardScheduleRowForTick {
  id: string;
  name: string;
  workspace: string;
  target_kind: 'objective' | 'dag';
  target_ref: string;
  input_payload_json: string;
  cron_expression: string;
  timezone: string;
  next_run_at: number;
  retry_max: number;
  retry_backoff_seconds: number;
}

interface DashboardScheduleRunRowForTick {
  id: string;
  schedule_id: string;
  workflow_id: string | null;
  status: string;
  attempt: number;
  scheduled_for: number;
  created_at: number;
  workflow_status?: string | null;
  schedule_name?: string;
  retry_max?: number;
  retry_backoff_seconds?: number;
  workspace?: string;
  target_kind?: 'objective' | 'dag';
  target_ref?: string;
  input_payload_json?: string;
  cron_expression?: string;
  timezone?: string;
  next_run_at?: number;
}

function dashboardScheduleRunId(): string {
  return `sr_${randomBytes(10).toString('hex')}`;
}

function parseTriggerPayload(raw: string | undefined): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw) as unknown; }
  catch (err) {
    throw new Error(`invalid schedule payload JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function markDashboardScheduleLastStatus(
  db: ReturnType<typeof initDb>,
  scheduleId: string,
  status: string,
  now = Date.now(),
): void {
  db.prepare(
    `UPDATE dashboard_schedules
        SET last_status = ?, last_run_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(status, now, now, scheduleId);
}

function queueDashboardScheduleRetry(
  db: ReturnType<typeof initDb>,
  row: Pick<DashboardScheduleRunRowForTick, 'schedule_id' | 'attempt'> & { retry_backoff_seconds?: number },
  now = Date.now(),
): string | null {
  const retryMax = (db.prepare(
    `SELECT retry_max, retry_backoff_seconds FROM dashboard_schedules WHERE id = ?`,
  ).get(row.schedule_id) as { retry_max: number; retry_backoff_seconds: number } | undefined) ?? {
    retry_max: 0,
    retry_backoff_seconds: row.retry_backoff_seconds ?? 60,
  };
  if (row.attempt >= retryMax.retry_max) return null;
  const nextAttempt = row.attempt + 1;
  const backoffMs = retryMax.retry_backoff_seconds * 1000 * (2 ** Math.max(0, row.attempt - 1));
  const retryId = dashboardScheduleRunId();
  db.prepare(
    `INSERT INTO dashboard_schedule_runs
       (id, schedule_id, workflow_id, status, attempt, scheduled_for, started_at, completed_at, error_message, created_at)
     VALUES (?, ?, NULL, 'queued', ?, ?, NULL, NULL, NULL, ?)`,
  ).run(retryId, row.schedule_id, nextAttempt, now + backoffMs, now);
  markDashboardScheduleLastStatus(db, row.schedule_id, 'retry_queued', now);
  return retryId;
}

async function executeDashboardScheduleRun(
  db: ReturnType<typeof initDb>,
  run: DashboardScheduleRunRowForTick,
  schedule: DashboardScheduleRowForTick,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  markDashboardScheduleRun(db, run.id, { status: 'running', started_at: now, completed_at: null }, now);

  // Tier 0 / Wave 4 / 0.4 (F-REL-2): outbox row BEFORE dispatch so a daemon
  // crash mid-dispatch is recoverable on next start. The row is updated with
  // workflow_id on success or `error` on failure; either way the orphan-retry
  // sweep skips it.
  const triggerFire = recordTriggerFire(db, {
    trigger_source: 'schedule',
    schedule_id: schedule.id,
    workspace: schedule.workspace,
    target_kind: schedule.target_kind,
    target_ref: schedule.target_ref,
    input_payload_json: schedule.input_payload_json,
    attempt: run.attempt,
  }, now);

  try {
    const result = await runDashboardTriggerTarget({
      workspace: schedule.workspace,
      target_kind: schedule.target_kind,
      target_ref: schedule.target_ref,
      input_payload: parseTriggerPayload(schedule.input_payload_json),
    });
    const workflowId = typeof result['workflow_id'] === 'string' ? result['workflow_id'] : null;
    markDashboardScheduleRun(db, run.id, { workflow_id: workflowId, status: 'running', completed_at: null }, now);
    markDashboardScheduleLastStatus(db, schedule.id, 'running', now);
    if (workflowId) {
      markTriggerFireDispatched(db, triggerFire.id, workflowId);
      emitTriggerFireRecordedEvent(db, triggerFire.id, workflowId, {
        source: 'schedule',
        schedule_id: schedule.id,
        fired_at: triggerFire.fired_at,
      });
    } else {
      markTriggerFireError(db, triggerFire.id, 'dispatch returned no workflow_id');
    }
    return { schedule_id: schedule.id, run_id: run.id, workflow_id: workflowId, status: 'running', attempt: run.attempt, trigger_fire_id: triggerFire.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markDashboardScheduleRun(db, run.id, { status: 'error', error_message: message }, now);
    markTriggerFireError(db, triggerFire.id, message);
    const retryRunId = queueDashboardScheduleRetry(db, {
      schedule_id: schedule.id,
      attempt: run.attempt,
      retry_backoff_seconds: schedule.retry_backoff_seconds,
    }, now);
    if (!retryRunId) markDashboardScheduleLastStatus(db, schedule.id, 'error', now);
    return { schedule_id: schedule.id, run_id: run.id, status: 'error', error: message, retry_run_id: retryRunId, trigger_fire_id: triggerFire.id };
  }
}

function settleDashboardScheduleRuns(db: ReturnType<typeof initDb>, now = Date.now()): Array<Record<string, unknown>> {
  const rows = db.prepare(
    `SELECT sr.id, sr.schedule_id, sr.workflow_id, sr.status, sr.attempt, sr.scheduled_for,
            sr.created_at, w.status AS workflow_status, s.name AS schedule_name,
            s.retry_max, s.retry_backoff_seconds
       FROM dashboard_schedule_runs sr
       JOIN dashboard_schedules s ON s.id = sr.schedule_id
       LEFT JOIN workflows w ON w.id = sr.workflow_id
      WHERE sr.status = 'running' AND sr.workflow_id IS NOT NULL
      ORDER BY sr.created_at ASC LIMIT 50`,
  ).all() as DashboardScheduleRunRowForTick[];
  const settled: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.workflow_status === 'completed') {
      markDashboardScheduleRun(db, row.id, { status: 'success' }, now);
      markDashboardScheduleLastStatus(db, row.schedule_id, 'success', now);
      settled.push({ schedule_id: row.schedule_id, run_id: row.id, workflow_id: row.workflow_id, status: 'success' });
      continue;
    }
    if (row.workflow_status === 'failed' || row.workflow_status === 'cancelled') {
      markDashboardScheduleRun(db, row.id, { status: 'error', error_message: `workflow ${row.workflow_status}` }, now);
      const retryRunId = queueDashboardScheduleRetry(db, row, now);
      if (!retryRunId) markDashboardScheduleLastStatus(db, row.schedule_id, 'error', now);
      settled.push({
        schedule_id: row.schedule_id, run_id: row.id, workflow_id: row.workflow_id,
        status: 'error', workflow_status: row.workflow_status, retry_run_id: retryRunId,
      });
    }
  }
  return settled;
}

async function runDueDashboardScheduleRetries(db: ReturnType<typeof initDb>, now = Date.now()): Promise<Array<Record<string, unknown>>> {
  const rows = db.prepare(
    `SELECT sr.id, sr.schedule_id, sr.workflow_id, sr.status, sr.attempt, sr.scheduled_for,
            sr.created_at, s.name AS schedule_name, s.workspace, s.target_kind, s.target_ref,
            s.input_payload_json, s.cron_expression, s.timezone, s.next_run_at,
            s.retry_max, s.retry_backoff_seconds
       FROM dashboard_schedule_runs sr
       JOIN dashboard_schedules s ON s.id = sr.schedule_id
      WHERE sr.status = 'queued' AND sr.scheduled_for <= ? AND s.is_active = 1
      ORDER BY sr.scheduled_for ASC LIMIT 25`,
  ).all(now) as DashboardScheduleRunRowForTick[];
  const runs: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    runs.push(await executeDashboardScheduleRun(db, row, {
      id: row.schedule_id,
      name: row.schedule_name ?? row.schedule_id,
      workspace: row.workspace ?? 'internal',
      target_kind: row.target_kind ?? 'objective',
      target_ref: row.target_ref ?? '',
      input_payload_json: row.input_payload_json ?? '{}',
      cron_expression: row.cron_expression ?? '* * * * *',
      timezone: row.timezone ?? 'UTC',
      next_run_at: row.next_run_at ?? now,
      retry_max: row.retry_max ?? 0,
      retry_backoff_seconds: row.retry_backoff_seconds ?? 60,
    }, now));
  }
  return runs;
}

export async function runDashboardScheduleTickOnce(): Promise<{ processed: number; runs: Array<Record<string, unknown>> }> {
  const db = initDb(getDbPath());
  const runs: Array<Record<string, unknown>> = [];
  const startedAt = Date.now();
  let tickError: string | null = null;
  try {
    try {
      runs.push(...settleDashboardScheduleRuns(db));
      runs.push(...await runDueDashboardScheduleRetries(db));
      const schedules = dueDashboardSchedules(db);
      for (const schedule of schedules) {
        const activeRun = db.prepare(
          `SELECT 1 FROM dashboard_schedule_runs
            WHERE schedule_id = ? AND status IN ('queued', 'running') LIMIT 1`,
        ).get(schedule.id) as { 1: number } | undefined;
        if (activeRun) {
          runs.push({ schedule_id: schedule.id, status: 'skipped', reason: 'retry_or_run_already_active' });
          continue;
        }
        const run = insertDashboardScheduleRun(db, schedule);
        const runResult = await executeDashboardScheduleRun(db, run, {
          id: schedule.id,
          name: schedule.name,
          workspace: schedule.workspace,
          target_kind: schedule.target_kind,
          target_ref: schedule.target_ref,
          input_payload_json: JSON.stringify(schedule.input_payload ?? {}),
          cron_expression: schedule.cron_expression,
          timezone: schedule.timezone,
          next_run_at: schedule.next_run_at,
          retry_max: schedule.retry_max,
          retry_backoff_seconds: schedule.retry_backoff_seconds,
        });
        runs.push(runResult);
        const nextStatus = typeof runResult['retry_run_id'] === 'string'
          ? 'retry_queued'
          : String(runResult['status'] ?? 'running');
        advanceDashboardSchedule(db, schedule, nextStatus);
      }
      return { processed: runs.length, runs };
    } catch (err) {
      tickError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  } finally {
    // Sprint 2.6 (F-REL-2): every tick writes daemon_state singleton.
    try {
      setDaemonState(db, 'schedule_tick', {
        status: tickError === null ? 'ok' : 'error',
        processed: runs.length,
        duration_ms: Date.now() - startedAt,
        error: tickError,
      });
    } catch (persistErr) {
      process.stderr.write(`[daemon] failed to persist schedule_tick state: ${
        persistErr instanceof Error ? persistErr.message : String(persistErr)
      }\n`);
    }
    db.close();
  }
}
