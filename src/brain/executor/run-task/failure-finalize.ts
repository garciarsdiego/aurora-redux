import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import type { FailoverError } from '../../../v2/failover/error.js';
import {
  insertEvent,
  setTaskFailed,
} from '../../../db/persist.js';
import { completeTaskLease } from '../../../db/task-leases.js';
import {
  safeRecordTaskHandoff,
  safeRecordTaskThreadEvent,
} from '../../../context/workflow-adapter.js';

import { isAbortError } from './cancel.js';
import { releaseCostReservation } from '../cost-cap.js';
import { endTaskTraceSpan } from './trace-span.js';

// Failure-finalize phase — invoked when the retry loop exited with a
// non-recovered error. Distinguishes operator-cancelled aborts (which keep
// the `cancelled` row status set by broadcastCancelToWorkflow) from regular
// failures (which set the row to `failed`). Records handoff + thread events,
// closes the trace span, mutates `task.status`, and re-throws so the outer
// finally block in index.ts releases the lease.
export function finalizeFailure(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  workspace: string;
  lastErr: unknown;
  lastClassified: FailoverError | undefined;
  lastContextAttemptNumber: number;
  taskCancelSignal: AbortSignal;
  taskTraceSpanId: string | undefined;
}): never {
  const {
    db,
    task,
    workflowId: wfId,
    workspace,
    lastErr,
    lastClassified,
    lastContextAttemptNumber,
    taskCancelSignal,
    taskTraceSpanId,
  } = params;

  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  // Tier 0 Wave 3 (ITEM 0.2) — cancel-driven aborts emit a typed
  // task_aborted event and leave the row's 'cancelled' status (set by
  // broadcastCancelToWorkflow) intact. Do NOT call setTaskFailed which
  // would overwrite the operator-visible cancellation state.
  const wasCancelled = isAbortError(lastErr) || taskCancelSignal.aborted;
  if (wasCancelled) {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_aborted',
      payload: {
        reason: message,
        retry_count: task.retry_count,
        model: task.model ?? null,
        model_used: task.model_used ?? null,
      },
    });
    // BRAIN-04: free this task's cost-cap reservation so a cancelled task does
    // not consume mid-workflow headroom (idempotent — no-op if never reserved).
    releaseCostReservation(wfId, task.id);
    completeTaskLease(db, task.id, 'failed');
    endTaskTraceSpan(db, taskTraceSpanId, wfId, task.id, 'error', {
      error: message,
      classified_reason: 'aborted',
      retry_count: task.retry_count,
      model: task.model ?? null,
      model_used: task.model_used ?? null,
    });
    task.status = 'cancelled';
    throw lastErr;
  }
  safeRecordTaskHandoff(db, {
    workspace,
    runId: wfId,
    taskId: task.id,
    taskName: task.name,
    attempt: lastContextAttemptNumber,
    kind: 'error',
    title: `${task.name} failed`,
    body: message,
    safeContext: {
      classified_reason: lastClassified?.reason ?? null,
      retryable: lastClassified?.isRetryable ?? null,
      retry_count: task.retry_count,
      model: task.model ?? null,
      model_used: task.model_used ?? null,
    },
  });
  safeRecordTaskThreadEvent(db, {
    workspace,
    runId: wfId,
    taskId: task.id,
    taskName: task.name,
    eventType: 'task_failed',
    body: message,
    metadata: {
      classified_reason: lastClassified?.reason ?? null,
      retry_count: task.retry_count,
    },
  });
  setTaskFailed(db, task.id);
  // BRAIN-04: release the failed task's cost-cap reservation (idempotent).
  releaseCostReservation(wfId, task.id);
  completeTaskLease(db, task.id, 'failed');
  endTaskTraceSpan(db, taskTraceSpanId, wfId, task.id, 'error', {
    error: message,
    classified_reason: lastClassified?.reason ?? null,
    retry_count: task.retry_count,
    model: task.model ?? null,
    model_used: task.model_used ?? null,
  });
  task.status = 'failed';
  throw lastErr;
}
