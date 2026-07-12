import type Database from 'better-sqlite3';
import { insertEvent, loadWorkflowById, setWorkflowMetadata } from './persist.js';
import { safeJsonObject } from './safe-json.js';
import { broadcastCancelToWorkflow } from '../v2/subagent/control.js';
import { redactSecrets } from '../v2/security/redact.js';

export type WorkflowControlAction = 'pause' | 'resume' | 'cancel';
export type WorkflowControlState =
  | 'running'
  | 'pause_requested'
  | 'paused'
  | 'resume_requested'
  | 'cancel_requested'
  | 'canceled';

export interface WorkflowControlRow {
  workflow_id: string;
  state: WorkflowControlState;
  requested_by: string | null;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowControlRequest {
  action: WorkflowControlAction;
  reason?: string | null;
  requestedBy?: string | null;
}

export interface WorkflowControlResult {
  workflow_id: string;
  action: WorkflowControlAction;
  state: WorkflowControlState;
  daemon_acknowledged: boolean;
  audit_event: string;
  requested_by: string;
  reason: string | null;
  updated_at: number;
  tasks_cancelled?: number;
  controllers_aborted?: number;
  messages_cancelled?: number;
}

const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function normalizeActor(actor: string | null | undefined): string {
  const raw = typeof actor === 'string' && actor.trim() ? actor.trim() : 'dashboard';
  return raw.slice(0, 80);
}

function normalizeReason(reason: string | null | undefined, workspace: string, db: Database.Database): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;
  return redactSecrets(trimmed.slice(0, 500), workspace, db);
}

function buildControlResult(
  workflowId: string,
  action: WorkflowControlAction,
  auditEvent: string,
  row: WorkflowControlRow,
  requestedBy: string,
  reason: string | null,
  extra: Partial<WorkflowControlResult> = {},
): WorkflowControlResult {
  return {
    workflow_id: workflowId,
    action,
    state: row.state,
    daemon_acknowledged: true,
    audit_event: auditEvent,
    requested_by: requestedBy,
    reason,
    updated_at: row.updated_at,
    ...extra,
  };
}

function upsertWorkflowControlState(
  db: Database.Database,
  workflowId: string,
  state: WorkflowControlState,
  requestedBy: string,
  reason: string | null,
  now = Date.now(),
): WorkflowControlRow {
  db.prepare(
    `INSERT INTO workflow_control_state
       (workflow_id, state, requested_by, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
       state = excluded.state,
       requested_by = excluded.requested_by,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).run(workflowId, state, requestedBy, reason, now, now);
  return loadWorkflowControlState(db, workflowId)!;
}

export function loadWorkflowControlState(
  db: Database.Database,
  workflowId: string,
): WorkflowControlRow | null {
  const row = db
    .prepare(
      `SELECT workflow_id, state, requested_by, reason, created_at, updated_at
         FROM workflow_control_state
        WHERE workflow_id = ?`,
    )
    .get(workflowId) as WorkflowControlRow | undefined;
  return row ?? null;
}

export function markWorkflowControlRunning(
  db: Database.Database,
  workflowId: string,
  requestedBy = 'daemon',
  reason: string | null = null,
): WorkflowControlRow {
  return upsertWorkflowControlState(db, workflowId, 'running', normalizeActor(requestedBy), reason);
}

export function requestWorkflowControl(
  db: Database.Database,
  workflowId: string,
  request: WorkflowControlRequest,
): WorkflowControlResult {
  const workflow = loadWorkflowById(db, workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  if (request.action !== 'cancel' && TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    throw new Error(`Workflow ${workflowId} is already terminal (${workflow.status})`);
  }

  const requestedBy = normalizeActor(request.requestedBy);
  const reason = normalizeReason(request.reason, workflow.workspace, db);
  const now = Date.now();

  if (request.action === 'pause') {
    const row = upsertWorkflowControlState(db, workflowId, 'pause_requested', requestedBy, reason, now);
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'workflow_pause_requested',
      payload: { requested_by: requestedBy, reason },
    });
    return buildControlResult(workflowId, 'pause', 'workflow_pause_requested', row, requestedBy, reason);
  }

  if (request.action === 'resume') {
    const row = upsertWorkflowControlState(db, workflowId, 'resume_requested', requestedBy, reason, now);
    db.prepare(
      `UPDATE workflows
          SET status = 'executing', completed_at = NULL
        WHERE id = ? AND status = 'paused'`,
    ).run(workflowId);
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'workflow_resume_requested',
      payload: { requested_by: requestedBy, reason },
    });
    return buildControlResult(workflowId, 'resume', 'workflow_resume_requested', row, requestedBy, reason);
  }

  const requestRow = upsertWorkflowControlState(db, workflowId, 'cancel_requested', requestedBy, reason, now);
  insertEvent(db, {
    workflow_id: workflowId,
    type: 'workflow_cancel_requested',
    payload: { requested_by: requestedBy, reason },
  });

  if (TERMINAL_WORKFLOW_STATUSES.has(workflow.status)) {
    return buildControlResult(workflowId, 'cancel', 'workflow_cancel_requested', requestRow, requestedBy, reason);
  }

  const broadcast = broadcastCancelToWorkflow(db, workflowId, reason);
  const cancelledAt = Date.now();
  db.prepare(`UPDATE workflows SET status = 'cancelled', completed_at = ? WHERE id = ?`)
    .run(cancelledAt, workflowId);
  // Tolerant parse (same contract as workflow-mode.ts / workflow-cli-permission.ts):
  // corrupted metadata must NOT abort the cancel halfway — throwing here would
  // leave status='cancelled' with control state stuck in 'cancel_requested'
  // and no workflow_canceled audit event.
  const existingMeta = safeJsonObject(workflow.metadata);
  setWorkflowMetadata(db, workflowId, JSON.stringify({
    ...existingMeta,
    cancelled_reason: reason,
    cancelled_at: cancelledAt,
    cancel_propagation: broadcast,
    control_requested_by: requestedBy,
  }));
  const row = upsertWorkflowControlState(db, workflowId, 'canceled', requestedBy, reason, cancelledAt);
  insertEvent(db, {
    workflow_id: workflowId,
    type: 'workflow_canceled',
    payload: {
      requested_by: requestedBy,
      reason,
      tasks_cancelled: broadcast.tasks_cancelled,
      controllers_aborted: broadcast.controllers_aborted,
      messages_cancelled: broadcast.messages_cancelled,
    },
  });
  return buildControlResult(workflowId, 'cancel', 'workflow_canceled', row, requestedBy, reason, {
    tasks_cancelled: broadcast.tasks_cancelled,
    controllers_aborted: broadcast.controllers_aborted,
    messages_cancelled: broadcast.messages_cancelled,
  });
}

export interface WorkflowControlCheckpointOptions {
  pollMs?: number;
  sleep: (ms: number) => Promise<void>;
}

export async function waitForWorkflowControlCheckpoint(
  db: Database.Database,
  workflowId: string,
  opts: WorkflowControlCheckpointOptions,
): Promise<void> {
  const pollMs = Math.max(1, opts.pollMs ?? 1_000);
  const initial = loadWorkflowControlState(db, workflowId);
  if (!initial || initial.state === 'running') return;
  if (initial.state === 'resume_requested') {
    markWorkflowControlRunning(db, workflowId, initial.requested_by ?? 'daemon', initial.reason);
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'workflow_resumed',
      payload: { requested_by: initial.requested_by, reason: initial.reason },
    });
    return;
  }
  if (initial.state === 'cancel_requested' || initial.state === 'canceled') {
    throw new Error(`Workflow ${workflowId} canceled by operator`);
  }
  // TS narrowing makes this look unreachable ('pause_requested' | 'paused' are
  // the only states left), but keep it: with mixed-version processes sharing
  // the DB (daemon + HTTP + REPL), a newer schema may hold a state this binary
  // does not know. Returning here beats falling into the poll loop forever.
  if (initial.state !== 'pause_requested' && initial.state !== 'paused') return;

  if (initial.state === 'pause_requested') {
    upsertWorkflowControlState(
      db,
      workflowId,
      'paused',
      initial.requested_by ?? 'daemon',
      initial.reason,
    );
    db.prepare(`UPDATE workflows SET status = 'paused' WHERE id = ?`).run(workflowId);
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'workflow_paused',
      payload: {
        requested_by: initial.requested_by,
        reason: initial.reason,
        semantics: 'paused_before_next_task',
      },
    });
  }

  while (true) {
    await opts.sleep(pollMs);
    const current = loadWorkflowControlState(db, workflowId);
    if (!current) return;
    if (current.state === 'cancel_requested' || current.state === 'canceled') {
      throw new Error(`Workflow ${workflowId} canceled by operator`);
    }
    if (current.state === 'resume_requested' || current.state === 'running') {
      markWorkflowControlRunning(db, workflowId, current.requested_by ?? 'daemon', current.reason);
      db.prepare(`UPDATE workflows SET status = 'executing', completed_at = NULL WHERE id = ?`).run(workflowId);
      insertEvent(db, {
        workflow_id: workflowId,
        type: 'workflow_resumed',
        payload: { requested_by: current.requested_by, reason: current.reason },
      });
      return;
    }
  }
}
