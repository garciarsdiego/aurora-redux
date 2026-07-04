/**
 * dashboard-data-audit.ts
 *
 * Audit queries for dashboard data layer.
 * Handles event queries, subagent messaging, pending gates, and alert dismissals.
 *
 * Split from dashboard-data.ts (1054 LOC → ~350 LOC)
 */

import type Database from 'better-sqlite3';
import type { DashboardTaskCard, DashboardMailboxEntry } from './dashboard-data-tasks.js';
import type { DashboardWorkflowCard } from './dashboard-data-workflows.js';

export interface DashboardTimelineEvent {
  id: number;
  workflow_id: string;
  task_id: string | null;
  type: string;
  timestamp: number;
  payload_preview: string | null;
}

export interface DashboardPendingGate {
  id: string;
  workflow_id: string;
  task_id: string | null;
  gate_type: string;
  status: string;
  channel: string | null;
  created_at: number;
}

interface EventDetailRow {
  id: number;
  workflow_id: string;
  task_id: string | null;
  type: string;
  payload_json: string | null;
  timestamp: number;
}

interface SubagentMessageDetailRow {
  id: string;
  workflow_id: string;
  from_task_id: string;
  to_task_id: string | null;
  message_type: string;
  payload_json: string;
  status: string;
  created_at: number;
  delivered_at: number | null;
}

interface SubagentMessageDeliveryRow {
  message_id: string;
  task_id: string;
  delivered_at: number;
}

function payloadObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function previewValue(raw: string | null, max = 1_000): string | null {
  if (!raw) return null;
  let text = raw;
  try {
    text = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    text = raw;
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function inferTaskIdFromPayload(raw: string | null): string | null {
  const payload = payloadObject(raw);
  const candidates = [
    payload['task_id'],
    payload['source_task_id'],
    payload['error'],
    payload['message'],
    payload['reason'],
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const bracketMatch = candidate.match(/\[(tk_[^\]\s]+)\]/);
    if (bracketMatch?.[1]) return bracketMatch[1];
    const plainMatch = candidate.match(/\b(tk_[A-Za-z0-9_-]+)\b/);
    if (plainMatch?.[1]) return plainMatch[1];
  }
  return null;
}

function taskMapKey(workflowId: string, taskId: string | null): string | null {
  return taskId ? `${workflowId}::${taskId}` : null;
}

function workflowErrorFromEvent(row: EventDetailRow): DashboardWorkflowCard['latest_error'] | null {
  const payload = payloadObject(row.payload_json);
  if (row.type === 'workflow_quota_blocked') {
    const remaining = typeof payload['remaining_pct'] === 'number' ? payload['remaining_pct'] : 0;
    return {
      event_id: row.id,
      type: row.type,
      message: `Quota not allowed (${remaining}% remaining)`,
      payload_preview: previewValue(row.payload_json, 700),
      timestamp: row.timestamp,
    };
  }
  if (row.type.includes('error') || row.type.includes('failed')) {
    const msg = typeof payload['error'] === 'string'
      ? payload['error']
      : typeof payload['message'] === 'string'
        ? payload['message']
        : row.type;
    return {
      event_id: row.id,
      type: row.type,
      message: msg,
      payload_preview: previewValue(row.payload_json, 700),
      timestamp: row.timestamp,
    };
  }
  return null;
}

function mailboxPayloadPreview(raw: string | null, max = 700): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return previewValue(raw, max);
    }
    const payload = parsed as Record<string, unknown>;
    const envelope = payload['raw'];
    if (envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      const value = envelope as Record<string, unknown>;
      const summary =
        typeof value['summary'] === 'string' ? value['summary']
        : typeof value['question'] === 'string' ? value['question']
        : typeof value['instruction'] === 'string' ? value['instruction']
        : typeof value['result_text'] === 'string' ? value['result_text']
        : typeof value['error_msg'] === 'string' ? value['error_msg']
        : null;
      if (summary) return summary.length > max ? `${summary.slice(0, max)}...` : summary;
      return previewValue(JSON.stringify(value), max);
    }
  } catch {
    return previewValue(raw, max);
  }
  return previewValue(raw, max);
}

function attachMailboxEntry(
  taskMap: Map<string, DashboardTaskCard>,
  workflowId: string,
  taskId: string,
  entry: DashboardMailboxEntry,
): void {
  const task = taskMap.get(`${workflowId}::${taskId}`);
  if (!task) return;
  task.mailbox.push(entry);
}

/**
 * Query events and build timeline
 */
export function queryEventsAndBuildTimeline(
  db: Database.Database,
  workflowIds: string[],
  tasksById: Map<string, DashboardTaskCard>,
): {
  timelines: Map<string, DashboardTimelineEvent[]>;
  latestErrors: Map<string, DashboardWorkflowCard['latest_error']>;
} {
  const timelines = new Map<string, DashboardTimelineEvent[]>();
  const latestErrors = new Map<string, DashboardWorkflowCard['latest_error']>();

  if (workflowIds.length === 0) return { timelines, latestErrors };

  const placeholders = workflowIds.map(() => '?').join(',');

  // Query dismissed workflow errors
  const dismissalRows = db.prepare(
    `SELECT workflow_id, MAX(event_id) AS event_id
       FROM dashboard_alert_dismissals
      WHERE alert_key = 'workflow_error'
        AND event_id IS NOT NULL
        AND workflow_id IN (${placeholders})
      GROUP BY workflow_id`,
  ).all(...workflowIds) as Array<{ workflow_id: string; event_id: number }>;
  const dismissedWorkflowErrors = new Map<string, number>();
  for (const row of dismissalRows) {
    dismissedWorkflowErrors.set(row.workflow_id, row.event_id);
  }

  // Query event details
  const detailEventRows = db.prepare(
    `SELECT id, workflow_id, task_id, type, payload_json, timestamp
     FROM (
       SELECT id, workflow_id, task_id, type, payload_json, timestamp
       FROM events
       WHERE workflow_id IN (${placeholders})
       ORDER BY timestamp DESC, id DESC
       LIMIT 500
     )
     ORDER BY timestamp ASC, id ASC`,
  ).all(...workflowIds) as EventDetailRow[];

  for (const row of detailEventRows) {
    const effectiveTaskId = row.task_id ?? inferTaskIdFromPayload(row.payload_json);
    const event = {
      id: row.id,
      workflow_id: row.workflow_id,
      task_id: effectiveTaskId,
      type: row.type,
      timestamp: row.timestamp,
      payload_preview: previewValue(row.payload_json, 700),
    };
    const wfTimeline = timelines.get(row.workflow_id) ?? [];
    wfTimeline.push(event);
    timelines.set(row.workflow_id, wfTimeline.slice(-80));
    const workflowError = workflowErrorFromEvent(row);
    const dismissedUntil = dismissedWorkflowErrors.get(row.workflow_id) ?? 0;
    if (workflowError && row.id > dismissedUntil) latestErrors.set(row.workflow_id, workflowError);
    if (effectiveTaskId) {
      const key = taskMapKey(row.workflow_id, effectiveTaskId);
      if (!key) continue;
      const task = tasksById.get(key);
      if (task) {
        task.events.push({
          id: row.id,
          type: row.type,
          timestamp: row.timestamp,
          payload_preview: event.payload_preview,
        });
        task.events = task.events.slice(-8);
      }
    }
  }

  return { timelines, latestErrors };
}

/**
 * Query subagent messages and build mailbox entries
 */
export function querySubagentMessages(
  db: Database.Database,
  workflowIds: string[],
  tasksById: Map<string, DashboardTaskCard>,
): void {
  if (workflowIds.length === 0) return;

  const placeholders = workflowIds.map(() => '?').join(',');
  const subagentMessageRows = db.prepare(
    `SELECT id, workflow_id, from_task_id, to_task_id, message_type, payload_json,
            status, created_at, delivered_at
     FROM subagent_messages
     WHERE workflow_id IN (${placeholders})
     ORDER BY created_at ASC`,
  ).all(...workflowIds) as SubagentMessageDetailRow[];

  if (subagentMessageRows.length === 0) return;

  const messageIds = subagentMessageRows.map((row) => row.id);
  const deliveryPlaceholders = messageIds.map(() => '?').join(',');
  const deliveryRows = db.prepare(
    `SELECT message_id, task_id, delivered_at
     FROM subagent_message_deliveries
     WHERE message_id IN (${deliveryPlaceholders})
     ORDER BY delivered_at ASC`,
  ).all(...messageIds) as SubagentMessageDeliveryRow[];
  const deliveriesByMessage = new Map<string, SubagentMessageDeliveryRow[]>();
  for (const row of deliveryRows) {
    const list = deliveriesByMessage.get(row.message_id) ?? [];
    list.push(row);
    deliveriesByMessage.set(row.message_id, list);
  }

  const tasksByWorkflow = new Map<string, DashboardTaskCard[]>();
  for (const task of tasksById.values()) {
    const list = tasksByWorkflow.get(task.workflow_id) ?? [];
    list.push(task);
    tasksByWorkflow.set(task.workflow_id, list);
  }

  for (const row of subagentMessageRows) {
    const scope = row.to_task_id ? 'direct' : 'broadcast';
    const payloadPreview = mailboxPayloadPreview(row.payload_json);
    const deliveries = deliveriesByMessage.get(row.id) ?? [];

    attachMailboxEntry(tasksById, row.workflow_id, row.from_task_id, {
      id: row.id,
      direction: 'outbox',
      message_type: row.message_type,
      scope,
      status: row.status,
      counterpart_task_id: row.to_task_id,
      delivery_count: deliveries.length,
      created_at: row.created_at,
      delivered_at: row.delivered_at,
      payload_preview: payloadPreview,
    });

    if (row.to_task_id) {
      attachMailboxEntry(tasksById, row.workflow_id, row.to_task_id, {
        id: row.id,
        direction: 'inbox',
        message_type: row.message_type,
        scope,
        status: row.status,
        counterpart_task_id: row.from_task_id,
        delivery_count: deliveries.length,
        created_at: row.created_at,
        delivered_at: row.delivered_at ?? deliveries[0]?.delivered_at ?? null,
        payload_preview: payloadPreview,
      });
      continue;
    }

    if (deliveries.length > 0) {
      for (const delivery of deliveries) {
        if (delivery.task_id === row.from_task_id) continue;
        attachMailboxEntry(tasksById, row.workflow_id, delivery.task_id, {
          id: row.id,
          direction: 'inbox',
          message_type: row.message_type,
          scope,
          status: row.status,
          counterpart_task_id: row.from_task_id,
          delivery_count: deliveries.length,
          created_at: row.created_at,
          delivered_at: delivery.delivered_at,
          payload_preview: payloadPreview,
        });
      }
      continue;
    }

    if (row.status === 'pending') {
      for (const task of tasksByWorkflow.get(row.workflow_id) ?? []) {
        if (task.id === row.from_task_id) continue;
        task.mailbox.push({
          id: row.id,
          direction: 'inbox',
          message_type: row.message_type,
          scope,
          status: row.status,
          counterpart_task_id: row.from_task_id,
          delivery_count: 0,
          created_at: row.created_at,
          delivered_at: null,
          payload_preview: payloadPreview,
        });
      }
    }
  }
}

/**
 * Query pending HITL gates
 */
export function queryPendingGates(
  db: Database.Database,
  workflowIds: string[],
): DashboardPendingGate[] {
  if (workflowIds.length === 0) return [];
  const placeholders = workflowIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT id, workflow_id, task_id, gate_type, status, channel, created_at
     FROM hitl_gates
     WHERE status = 'pending' AND workflow_id IN (${placeholders})
     ORDER BY created_at ASC
     LIMIT 50`,
  ).all(...workflowIds) as DashboardPendingGate[];
}