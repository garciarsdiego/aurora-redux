import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { insertEvent } from '../db/persist.js';

const WorkflowStatePatchSchema = z.object({
  display_name: z.string().trim().max(160).nullable().optional(),
  archived: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

const WorkflowAlertAcknowledgeSchema = z.object({
  event_id: z.number().int().positive().optional(),
  reason: z.string().trim().max(500).optional(),
});

export interface DashboardWorkflowOverride {
  workflow_id: string;
  display_name: string | null;
  archived_at: number | null;
  deleted_at: number | null;
}

interface WorkflowOverrideRow {
  workflow_id: string;
  display_name: string | null;
  archived_at: number | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

interface WorkflowExistsRow {
  id: string;
  objective: string;
}

interface EventRow {
  id: number;
  type: string;
  timestamp: number;
}

function id(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function loadWorkflow(db: Database.Database, workflowId: string): WorkflowExistsRow {
  const row = db.prepare(
    `SELECT id, objective
       FROM workflows
      WHERE id = ?`,
  ).get(workflowId) as WorkflowExistsRow | undefined;
  if (!row) throw new Error(`Workflow not found: ${workflowId}`);
  return row;
}

function loadOverride(db: Database.Database, workflowId: string): WorkflowOverrideRow | null {
  return db.prepare(
    `SELECT workflow_id, display_name, archived_at, deleted_at, created_at, updated_at
       FROM dashboard_workflow_overrides
      WHERE workflow_id = ?`,
  ).get(workflowId) as WorkflowOverrideRow | undefined ?? null;
}

function latestWorkflowErrorEvent(db: Database.Database, workflowId: string): EventRow | null {
  return db.prepare(
    `SELECT id, type, timestamp
       FROM events
      WHERE workflow_id = ?
        AND (
          type = 'workflow_quota_blocked'
          OR lower(type) LIKE '%error%'
          OR lower(type) LIKE '%failed%'
        )
      ORDER BY id DESC
      LIMIT 1`,
  ).get(workflowId) as EventRow | undefined ?? null;
}

function loadWorkflowEvent(db: Database.Database, workflowId: string, eventId: number): EventRow {
  const row = db.prepare(
    `SELECT id, type, timestamp
       FROM events
      WHERE workflow_id = ? AND id = ?`,
  ).get(workflowId, eventId) as EventRow | undefined;
  if (!row) throw new Error(`Event not found for workflow: ${eventId}`);
  return row;
}

export function patchDashboardWorkflowState(
  db: Database.Database,
  workflowId: string,
  raw: unknown,
): { workflow: DashboardWorkflowOverride } {
  const input = WorkflowStatePatchSchema.parse(raw ?? {});
  loadWorkflow(db, workflowId);
  const existing = loadOverride(db, workflowId);
  const now = Date.now();
  const hasDisplayName = Object.prototype.hasOwnProperty.call(input, 'display_name');
  const displayName = hasDisplayName
    ? (input.display_name && input.display_name.trim().length > 0 ? input.display_name.trim() : null)
    : existing?.display_name ?? null;
  const archivedAt = input.archived === undefined
    ? existing?.archived_at ?? null
    : input.archived
      ? existing?.archived_at ?? now
      : null;
  const deletedAt = input.deleted === undefined
    ? existing?.deleted_at ?? null
    : input.deleted
      ? existing?.deleted_at ?? now
      : null;
  const createdAt = existing?.created_at ?? now;

  db.prepare(
    `INSERT INTO dashboard_workflow_overrides
       (workflow_id, display_name, archived_at, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workflow_id) DO UPDATE SET
       display_name = excluded.display_name,
       archived_at = excluded.archived_at,
       deleted_at = excluded.deleted_at,
       updated_at = excluded.updated_at`,
  ).run(workflowId, displayName, archivedAt, deletedAt, createdAt, now);

  if (hasDisplayName && displayName !== existing?.display_name) {
    insertEvent(db, {
      workflow_id: workflowId,
      type: 'dashboard_workflow_renamed',
      payload: { display_name: displayName },
    });
  }
  if (input.archived !== undefined && archivedAt !== existing?.archived_at) {
    insertEvent(db, {
      workflow_id: workflowId,
      type: archivedAt ? 'dashboard_workflow_archived' : 'dashboard_workflow_restored',
      payload: { archived_at: archivedAt },
    });
  }
  if (input.deleted !== undefined && deletedAt !== existing?.deleted_at) {
    insertEvent(db, {
      workflow_id: workflowId,
      type: deletedAt ? 'dashboard_workflow_deleted' : 'dashboard_workflow_restored',
      payload: { deleted_at: deletedAt },
    });
  }

  return {
    workflow: {
      workflow_id: workflowId,
      display_name: displayName,
      archived_at: archivedAt,
      deleted_at: deletedAt,
    },
  };
}

export function acknowledgeDashboardWorkflowAlert(
  db: Database.Database,
  workflowId: string,
  raw: unknown,
): { workflow_id: string; event_id: number; acknowledged_at: number } {
  const input = WorkflowAlertAcknowledgeSchema.parse(raw ?? {});
  loadWorkflow(db, workflowId);
  const event = input.event_id
    ? loadWorkflowEvent(db, workflowId, input.event_id)
    : latestWorkflowErrorEvent(db, workflowId);
  if (!event) throw new Error(`No workflow alert to acknowledge: ${workflowId}`);
  const now = Date.now();
  db.prepare(
    `INSERT INTO dashboard_alert_dismissals
       (id, workflow_id, alert_key, event_id, reason, created_at)
     VALUES (?, ?, 'workflow_error', ?, ?, ?)`,
  ).run(id('alert'), workflowId, event.id, input.reason ?? null, now);

  insertEvent(db, {
    workflow_id: workflowId,
    type: 'dashboard_alert_acknowledged',
    payload: {
      alert_key: 'workflow_error',
      event_id: event.id,
      event_type: event.type,
      reason: input.reason ?? null,
    },
  });

  return { workflow_id: workflowId, event_id: event.id, acknowledged_at: now };
}
