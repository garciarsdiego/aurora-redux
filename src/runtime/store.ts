import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

import { withSqliteRetrySync } from '../db/sqlite-retry.js';
import { listRuntimeExecutorCapabilities, type RuntimeProtocolTier, type RuntimeStreamFormat } from './capabilities.js';
import { redactRuntimeValue, type RuntimeRunEvent, type RuntimeStructuredError } from './events.js';

export interface RuntimeSessionInput {
  workflowId?: string | null;
  taskId?: string | null;
  executorId: string;
  protocolTier: RuntimeProtocolTier;
  streamFormat: RuntimeStreamFormat;
  nativeSessionId?: string | null;
  runtimeMode: 'oneshot' | 'persistent' | 'auto';
  status?: RuntimeSessionStatus;
  workspacePath?: string | null;
  fallbackReason?: string | null;
  approvalStatus?: 'not_required' | 'pending' | 'approved' | 'denied';
  auditStatus?: 'not_required' | 'pending' | 'recorded' | 'failed';
  runMode?: 'dry-run' | 'approved-run';
  metadata?: Record<string, unknown>;
}

export type RuntimeSessionStatus = 'active' | 'stale' | 'failed' | 'archived';

export interface RuntimeSessionRow {
  id: string;
  workflow_id: string | null;
  task_id: string | null;
  executor_id: string;
  protocol_tier: string;
  stream_format: string;
  native_session_id: string | null;
  runtime_mode: string;
  status: string;
  workspace_path: string | null;
  fallback_reason: string | null;
  approval_status: string;
  audit_status: string;
  run_mode: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
  last_used_at: number;
}

export interface RuntimeTurnInput {
  sessionId: string;
  workflowId?: string | null;
  taskId?: string | null;
  attempt?: number;
  promptSummary?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RuntimeTurnRow {
  id: string;
  session_id: string;
  workflow_id: string | null;
  task_id: string | null;
  attempt: number;
  status: string;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  prompt_summary: string | null;
  result_summary: string | null;
  error_json: string | null;
  metadata_json: string;
}

export interface RuntimeStreamEventRow {
  id: number;
  session_id: string;
  turn_id: string;
  workflow_id: string | null;
  task_id: string | null;
  seq: number;
  type: string;
  event_json: string;
  created_at: number;
}

function json(value: unknown): string {
  return JSON.stringify(redactRuntimeValue(value) ?? {});
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function runtimeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function upsertRuntimeCapabilities(db: Database.Database): void {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO runtime_capabilities
       (executor_id, capability_json, status, created_at, updated_at)
     VALUES (?, ?, 'known', ?, ?)
     ON CONFLICT(executor_id) DO UPDATE SET
       capability_json = excluded.capability_json,
       updated_at = excluded.updated_at`,
  );
  const tx = db.transaction(() => {
    for (const capability of listRuntimeExecutorCapabilities()) {
      stmt.run(capability.executorId, json(capability), now, now);
    }
  });
  withSqliteRetrySync(() => tx());
}

export function createRuntimeSession(
  db: Database.Database,
  input: RuntimeSessionInput,
): RuntimeSessionRow {
  const now = Date.now();
  const id = runtimeId('rt_sess');
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO runtime_sessions
      (id, workflow_id, task_id, executor_id, protocol_tier, stream_format,
       native_session_id, runtime_mode, status, workspace_path, fallback_reason,
       approval_status, audit_status, run_mode, metadata_json, created_at, updated_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.workflowId ?? null,
      input.taskId ?? null,
      input.executorId,
      input.protocolTier,
      input.streamFormat,
      input.nativeSessionId ?? null,
      input.runtimeMode,
      input.status ?? 'active',
      input.workspacePath ?? null,
      input.fallbackReason ?? null,
      input.approvalStatus ?? 'not_required',
      input.auditStatus ?? 'not_required',
      input.runMode ?? 'dry-run',
      json(input.metadata ?? {}),
      now,
      now,
      now,
    ),
  );
  return getRuntimeSession(db, id)!;
}

export function getRuntimeSession(db: Database.Database, id: string): RuntimeSessionRow | null {
  return db.prepare(`SELECT * FROM runtime_sessions WHERE id = ?`).get(id) as RuntimeSessionRow | undefined ?? null;
}

/**
 * Persist the CLI-emitted native session identifier on an existing runtime
 * session row. Wave 2 Phase 8 (codex/gemini wiring): captures session id from
 * stream-json output for resume semantics. Wrapped in best-effort try/catch by
 * cli.ts callers — runtime metadata recording must never break a CLI execution.
 */
export function updateRuntimeSessionNativeId(
  db: Database.Database,
  sessionId: string,
  nativeId: string,
): void {
  if (!sessionId || !nativeId) return;
  const now = Date.now();
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE runtime_sessions SET native_session_id = ?, updated_at = ? WHERE id = ?`,
    ).run(nativeId, now, sessionId),
  );
}

/**
 * Shared skeleton for the metadata/status update paths: fetch → merge the
 * metadata patch → UPDATE (optionally flipping status) → re-fetch. Internal
 * only — callers go through updateRuntimeSessionMetadata/Status below.
 */
function patchRuntimeSession(
  db: Database.Database,
  id: string,
  metadataPatch: Record<string, unknown>,
  status?: RuntimeSessionStatus,
): RuntimeSessionRow | null {
  const existing = getRuntimeSession(db, id);
  if (!existing) return null;
  const metadata = {
    ...parseMetadata(existing.metadata_json),
    ...metadataPatch,
  };
  const now = Date.now();
  withSqliteRetrySync(() =>
    status
      ? db.prepare(
          `UPDATE runtime_sessions
            SET status = ?, metadata_json = ?, updated_at = ?, last_used_at = ?
          WHERE id = ?`,
        ).run(status, json(metadata), now, now, id)
      : db.prepare(
          `UPDATE runtime_sessions
            SET metadata_json = ?, updated_at = ?, last_used_at = ?
          WHERE id = ?`,
        ).run(json(metadata), now, now, id),
  );
  return getRuntimeSession(db, id);
}

export function updateRuntimeSessionMetadata(
  db: Database.Database,
  id: string,
  patch: Record<string, unknown>,
): RuntimeSessionRow | null {
  return patchRuntimeSession(db, id, patch);
}

export function updateRuntimeSessionStatus(
  db: Database.Database,
  id: string,
  status: RuntimeSessionStatus,
  metadataPatch: Record<string, unknown> = {},
): RuntimeSessionRow | null {
  return patchRuntimeSession(db, id, metadataPatch, status);
}

export function heartbeatRuntimeSession(
  db: Database.Database,
  id: string,
  metadataPatch: Record<string, unknown> = {},
): RuntimeSessionRow | null {
  return updateRuntimeSessionMetadata(db, id, {
    ...metadataPatch,
    last_heartbeat_at: Date.now(),
  });
}

export function listRuntimeSessionsForWorkflow(
  db: Database.Database,
  workflowId: string,
): RuntimeSessionRow[] {
  return db
    .prepare(`SELECT * FROM runtime_sessions WHERE workflow_id = ? ORDER BY updated_at ASC, id ASC`)
    .all(workflowId) as RuntimeSessionRow[];
}

/**
 * Wave C Agent O — list every runtime_session row that was opened on the
 * `acp-stdio` protocol tier.
 *
 * Used by:
 *   - the per-workspace acquire path in RuntimeProcessPool to find a row that
 *     can be reused (matches workspace + active + recent heartbeat).
 *   - the 60s heartbeat tick that scans all ACP rows looking for stale ones.
 *   - the daemon startup orphan-recovery sweep (filters status='active' rows
 *     whose owning daemon process is no longer alive).
 *
 * `optionalStatus`:
 *   - omitted          → returns rows in ANY status (used for stats/inspection)
 *   - 'active'         → only currently-live persistent ACP processes
 *   - 'stale'/'failed' → forensic inspection
 *   - 'archived'       → cleanly closed sessions
 *
 * Order: newest first (updated_at DESC) so callers iterating for reuse hit
 * the freshest candidate first and short-circuit.
 */
export function listAcpStdioSessions(
  db: Database.Database,
  optionalStatus?: RuntimeSessionStatus,
): RuntimeSessionRow[] {
  if (optionalStatus) {
    return db
      .prepare(
        `SELECT * FROM runtime_sessions
          WHERE protocol_tier = 'acp-stdio' AND status = ?
          ORDER BY updated_at DESC, id ASC`,
      )
      .all(optionalStatus) as RuntimeSessionRow[];
  }
  return db
    .prepare(
      `SELECT * FROM runtime_sessions
        WHERE protocol_tier = 'acp-stdio'
        ORDER BY updated_at DESC, id ASC`,
    )
    .all() as RuntimeSessionRow[];
}

/**
 * Wave C Agent O — flip an active acp-stdio row to status='stale' with a
 * structured reason describing what the orphan recovery saw at startup.
 *
 * `reason` is one of:
 *   - 'parent_daemon_died'  — the recorded daemon_pid is no longer alive
 *   - 'orphan_recovery'     — the row is older than the recovery window AND
 *                             the recorded child pid is gone
 *   - any custom string from a future caller
 *
 * Returns the updated row, or null if `sessionId` does not exist.
 *
 * Status flip is idempotent: calling this on an already-stale row reapplies
 * the metadata patch (so the most recent reason wins) but does not flip
 * status back from 'archived' or 'failed'. Caller is expected to have
 * filtered on status='active' before invoking.
 */
export function markOrphanRecovered(
  db: Database.Database,
  sessionId: string,
  reason: 'parent_daemon_died' | 'orphan_recovery' | string = 'orphan_recovery',
): RuntimeSessionRow | null {
  return updateRuntimeSessionStatus(db, sessionId, 'stale', {
    process_state: 'stale',
    stale_reason: reason,
    stale_at: Date.now(),
    orphan_recovered_at: Date.now(),
  });
}

export function startRuntimeTurn(
  db: Database.Database,
  input: RuntimeTurnInput,
): RuntimeTurnRow {
  const id = runtimeId('rt_turn');
  const now = Date.now();
  withSqliteRetrySync(() =>
    db.prepare(
      `INSERT INTO runtime_turns
      (id, session_id, workflow_id, task_id, attempt, status, started_at,
       prompt_summary, metadata_json)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(
      id,
      input.sessionId,
      input.workflowId ?? null,
      input.taskId ?? null,
      input.attempt ?? 1,
      now,
      input.promptSummary ?? null,
      json(input.metadata ?? {}),
    ),
  );
  withSqliteRetrySync(() =>
    db.prepare(`UPDATE runtime_sessions SET last_used_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, input.sessionId),
  );
  return getRuntimeTurn(db, id)!;
}

export function getRuntimeTurn(db: Database.Database, id: string): RuntimeTurnRow | null {
  return db.prepare(`SELECT * FROM runtime_turns WHERE id = ?`).get(id) as RuntimeTurnRow | undefined ?? null;
}

export function listRuntimeTurnsForWorkflow(
  db: Database.Database,
  workflowId: string,
): RuntimeTurnRow[] {
  return db
    .prepare(`SELECT * FROM runtime_turns WHERE workflow_id = ? ORDER BY started_at ASC, id ASC`)
    .all(workflowId) as RuntimeTurnRow[];
}

export function appendRuntimeStreamEvent(
  db: Database.Database,
  input: {
    sessionId: string;
    turnId: string;
    workflowId?: string | null;
    taskId?: string | null;
    event: RuntimeRunEvent;
  },
): RuntimeStreamEventRow {
  // SELECT MAX(seq) + INSERT + re-fetch share one transaction so concurrent
  // writers (daemon + dashboard) cannot compute the same seq for a turn; a
  // busy retry re-runs the whole unit and recomputes seq instead of retrying
  // the INSERT forever with a stale value.
  const tx = db.transaction((): RuntimeStreamEventRow => {
    const row = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM runtime_stream_events WHERE turn_id = ?`)
      .get(input.turnId) as { seq: number };
    const seq = row.seq;
    db.prepare(
      `INSERT INTO runtime_stream_events
      (session_id, turn_id, workflow_id, task_id, seq, type, event_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId,
      input.turnId,
      input.workflowId ?? null,
      input.taskId ?? null,
      seq,
      input.event.type,
      json(input.event),
      Date.now(),
    );
    return db
      .prepare(`SELECT * FROM runtime_stream_events WHERE turn_id = ? AND seq = ?`)
      .get(input.turnId, seq) as RuntimeStreamEventRow;
  });
  return withSqliteRetrySync(() => tx());
}

export function completeRuntimeTurn(
  db: Database.Database,
  turnId: string,
  input: {
    status: 'completed' | 'failed' | 'canceled';
    resultSummary?: string | null;
    error?: RuntimeStructuredError | null;
  },
): RuntimeTurnRow {
  const existing = getRuntimeTurn(db, turnId);
  const now = Date.now();
  const duration = existing ? Math.max(0, now - existing.started_at) : null;
  withSqliteRetrySync(() =>
    db.prepare(
      `UPDATE runtime_turns
        SET status = ?, completed_at = ?, duration_ms = ?, result_summary = ?, error_json = ?
      WHERE id = ?`,
    ).run(
      input.status,
      now,
      duration,
      input.resultSummary ?? null,
      input.error ? json(input.error) : null,
      turnId,
    ),
  );
  return getRuntimeTurn(db, turnId)!;
}

export function listRuntimeStreamEventsForWorkflow(
  db: Database.Database,
  workflowId: string,
): RuntimeStreamEventRow[] {
  return db
    .prepare(`SELECT * FROM runtime_stream_events WHERE workflow_id = ? ORDER BY created_at ASC, id ASC LIMIT 1000`)
    .all(workflowId) as RuntimeStreamEventRow[];
}

export function listRuntimeStreamEventsForTurn(
  db: Database.Database,
  turnId: string,
): RuntimeStreamEventRow[] {
  return db
    .prepare(`SELECT * FROM runtime_stream_events WHERE turn_id = ? ORDER BY seq ASC`)
    .all(turnId) as RuntimeStreamEventRow[];
}
