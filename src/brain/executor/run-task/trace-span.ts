import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import { insertEvent } from '../../../db/persist.js';
import { startTraceSpan, endTraceSpan } from '../../../v2/observability/tracing.js';

export function startTaskTraceSpan(
  db: Database.Database,
  task: Task,
  wfId: string,
  maxAttempts: number,
  parentSpanId?: string,
): string | undefined {
  try {
    const span = startTraceSpan(db, {
      workflowId: wfId,
      taskId: task.id,
      parentSpanId: parentSpanId ?? null,
      name: task.name,
      kind: 'task',
      attributes: {
        kind: task.kind,
        executor_hint: task.executor_hint ?? null,
        model: task.model ?? null,
        timeout_seconds: task.timeout_seconds,
        max_attempts: maxAttempts,
      },
    });
    return span.id;
  } catch (err) {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_trace_start_error',
      payload: { error: (err as Error).message },
    });
    return undefined;
  }
}

export function endTaskTraceSpan(
  db: Database.Database,
  spanId: string | undefined,
  wfId: string,
  taskId: string,
  status: 'ok' | 'error',
  attributes: Record<string, unknown>,
): void {
  if (!spanId) return;
  try {
    endTraceSpan(db, spanId, { status, attributes });
  } catch (err) {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: taskId,
      type: 'task_trace_end_error',
      payload: { error: (err as Error).message, status },
    });
  }
}
