import type Database from 'better-sqlite3';
import type { Task, ReviewResult } from '../../../types/index.js';
import type { ReviewerRuntimeContext } from '../../../v2/reviewer/outcome.js';
import type { BridgeResult, BestComboResult } from '../../../v2/omniroute-bridge/index.js';
import {
  insertEvent,
  setTaskRunning,
  setTaskFailed,
  setTaskCompleted,
} from '../../../db/persist.js';
import {
  acquireTaskLease,
  completeTaskLease,
  startTaskLeaseHeartbeat,
} from '../../../db/task-leases.js';
import {
  safeRecordTaskHandoff,
  safeRecordTaskThreadEvent,
} from '../../../context/workflow-adapter.js';
import {
  registerAbortController,
  unregisterAbortController,
} from '../../../v2/subagent/control.js';

import { checkAborted } from './cancel.js';
import { consumeVersionedDefinition } from './versioned-definition.js';
import { resolveReviewerWorkspaceDir } from './reviewer-workspace.js';
import { resolveTaskSecrets } from './secrets-resolver.js';
import { contextAttempt } from './context-packet.js';
import { prepareCliSpawnIsolation } from './worktree-prep.js';
import { startTaskTraceSpan, endTaskTraceSpan } from './trace-span.js';
import { preDispatch } from './pre-dispatch.js';
import { runRetryLoop } from './retry-loop.js';
import { finalizeFailure } from './failure-finalize.js';
import { finalizeSuccess } from './success-finalize.js';
import {
  dispatchLlmCallPrep,
  dispatchCliSpawnPrep,
  dispatchAdvisorCallPrep,
} from './dispatchers/index.js';

// Re-export public API so callers importing from the facade continue to work.
export {
  checkAborted,
  consumeVersionedDefinition,
  resolveReviewerWorkspaceDir,
};

// Executes a single task with its retry policy. Mutates task in-place.
// Emits task_started, task_retrying, task_completed/task_failed.
// Throws on final failure (caller handles workflow-level failure).
export async function executeTaskWithRetry(
  db: Database.Database,
  task: Task,
  wfId: string,
  workspace: string,
  objective: string,
  doExecute: (task: Task, signal?: AbortSignal) => Promise<string>,
  doSleep: (ms: number) => Promise<void>,
  doReview: (task: Task, output: string, ctx?: ReviewerRuntimeContext) => Promise<ReviewResult>,
  refineCostPerCallUsd: number,
  refineTimeoutMs: number,
  doHitl: (info: import('../../../hitl/cli.js').HitlPromptInfo) => Promise<'approve' | 'reject'>,
  autoApprove: boolean,
  doBestCombo: (taskKind: string, complexity: string) => Promise<BridgeResult<BestComboResult>>,
  allTasks?: Task[],
  workflowSpanId?: string,
  forceHitlPrompt = false,
): Promise<void> {
  // Pin/freeze (Aurora-parity Wave 2) — a pinned task that already has a stored
  // output reuses it instead of re-executing: zero model spend, no dispatch, no
  // lease. Runs BEFORE any setup so a re-run/resume/fork of a pinned upstream is
  // free. Skipping the lease is safe: only `pending` tasks reach here (the
  // scheduler dispatches pending-only) and we return fulfilled, so the
  // orchestrator advances completedIds and emits the streamed
  // task_started/task_completed around this call. Reuse is reachable ONLY for a
  // task whose output_json was written by a prior SUCCESSFUL completion
  // (setTaskFailed never writes output_json; setTaskPending preserves it on
  // rewind) — so the stored output is a trusted prior result. Only
  // short-circuits when there is a prior output to reuse — a pinned task with no
  // output_json falls through and executes normally.
  if (task.output_pinned === true && task.output_json != null && task.output_json !== '') {
    setTaskCompleted(db, task.id, task.output_json);
    task.status = 'completed';
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_output_pinned_reused',
      payload: { reused_chars: task.output_json.length, hitl: task.hitl === true },
    });
    // SECURITY (review): the reuse path skips preDispatch — including the HITL
    // gate. That's the intended "frozen, trusted output" semantic, but a
    // bypassed human checkpoint must be auditable. Emit a dedicated, filterable
    // event so an operator can review/alert on pin-bypassed approvals (and the
    // future pin-toggle route can warn before pinning an hitl task).
    if (task.hitl === true) {
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_hitl_bypassed_by_pin',
        payload: { gate: 'hitl', reason: 'output_pinned_reuse' },
      });
    }
    return;
  }

  // Tier 0 Wave 3 (ITEM 0.2) — register a task-scoped AbortController so
  // broadcastCancelToWorkflow can interrupt this loop. The signal is wired
  // through doExecute via withTimeout's own AbortController for executors that
  // accept it (cli.ts spawn-with-signal, omniroute fetch). Outer JS loops use
  // checkAborted() between awaits.
  const cancelController = new AbortController();
  registerAbortController(task.id, cancelController);
  const taskCancelSignal = cancelController.signal;

  // Pre-dispatch phase — HITL, upstream artifacts, carry, tool-policy approval,
  // budget assertion, injection scan, cost-cap enforcement. Mutates
  // task.input_json in-place and throws on injection-block / budget-block.
  await preDispatch({
    db,
    task,
    workflowId: wfId,
    workspace,
    objective,
    autoApprove,
    doHitl,
    allTasks,
    forceHitlPrompt,
    taskCancelSignal,
  });

  const maxAttempts = task.retry_policy === 'none' ? 1 : task.max_retries + 1;

  setTaskRunning(db, task.id);
  task.status = 'running';
  const leaseTtlMs = Math.max(task.timeout_seconds * 1000, 60_000);
  const lease = acquireTaskLease(db, {
    workflowId: wfId,
    taskId: task.id,
    owner: process.env.OMNIFORGE_WORKER_ID?.trim() || `pid:${process.pid}`,
    ttlMs: leaseTtlMs,
  });
  insertEvent(db, { workflow_id: wfId, task_id: task.id, type: 'task_started' });
  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: 'task_lease_acquired',
    payload: {
      attempt: lease.attempt,
      owner: lease.lease_owner,
      idempotency_key: lease.idempotency_key,
      expires_at: lease.expires_at,
    },
  });
  safeRecordTaskThreadEvent(db, {
    workspace,
    runId: wfId,
    taskId: task.id,
    taskName: task.name,
    eventType: 'task_started',
    body: `Task started: ${task.name}`,
    metadata: {
      kind: task.kind,
      model: task.model ?? null,
      executor_hint: task.executor_hint ?? null,
      lease_attempt: lease.attempt,
      lease_owner: lease.lease_owner,
      idempotency_key: lease.idempotency_key,
      expires_at: lease.expires_at,
    },
  });
  const taskTraceSpanId = startTaskTraceSpan(db, task, wfId, maxAttempts, workflowSpanId);
  const leaseHeartbeat = startTaskLeaseHeartbeat(db, {
    taskId: task.id,
    ttlMs: leaseTtlMs,
    onError: (err) => {
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_lease_heartbeat_error',
        payload: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
    },
  });

  try {
    // Worktree prep — surfaces a setup failure as an immediate task_failed
    // before the retry loop is even entered. Lease is released in the catch
    // here (rather than the outer finally) so callers see a clean failure.
    try {
      prepareCliSpawnIsolation(db, task, wfId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      safeRecordTaskHandoff(db, {
        workspace,
        runId: wfId,
        taskId: task.id,
        taskName: task.name,
        attempt: contextAttempt(lease.attempt, 0),
        kind: 'error',
        title: `${task.name} worktree setup failed`,
        body: message,
        safeContext: {
          phase: 'worktree_setup',
          kind: task.kind,
          executor_hint: task.executor_hint ?? null,
        },
      });
      setTaskFailed(db, task.id);
      completeTaskLease(db, task.id, 'failed');
      endTaskTraceSpan(db, taskTraceSpanId, wfId, task.id, 'error', {
        error: message,
        classified_reason: 'worktree_setup_failed',
        retry_count: task.retry_count,
        model: task.model ?? null,
        model_used: task.model_used ?? null,
      });
      task.status = 'failed';
      throw err;
    }

    // Sprint Onda-1-E: resolve {{secret:KEY}} placeholders before execution.
    resolveTaskSecrets(task, workspace, db, wfId);

    // Tier 0 Wave 3 (ITEM 0.7) — versioned-definitions consumption for
    // advisor / persona tasks. Per-kind preprocessing is dispatched through
    // the dispatchers/ barrel. The reviewer pin is consumed unconditionally
    // because it is observed at the moment the reviewer runs, not at
    // decomposition time. Decomposer pin is consumed inside decomposer.ts.
    if (task.kind === 'pal_call') {
      dispatchAdvisorCallPrep({ db, task, workspace, workflowId: wfId });
    }
    if (task.kind === 'llm_call') {
      dispatchLlmCallPrep({ db, task, workspace, workflowId: wfId });
    }
    if (task.kind === 'cli_spawn') {
      dispatchCliSpawnPrep({ db, task, workspace, workflowId: wfId });
    }
    consumeVersionedDefinition(db, {
      workspace,
      kind: 'agent',
      name: 'persona.reviewer',
      workflowId: wfId,
      taskId: task.id,
      role: 'reviewer',
    });

    // Retry loop — owns per-attempt cancel checkpoints, dynamic timeout
    // escalation, recovery policy, transition-context, runtime-session pool
    // acquisition, executor dispatch, and classifier-driven failover.
    const {
      output,
      lastErr,
      lastClassified,
      lastContextAttemptNumber,
    } = await runRetryLoop({
      db,
      task,
      workflowId: wfId,
      workspace,
      doExecute,
      doSleep,
      doBestCombo,
      allTasks,
      maxAttempts,
      leaseAttempt: lease.attempt,
      taskCancelSignal,
      taskTraceSpanId,
    });

    if (lastErr !== undefined) {
      finalizeFailure({
        db,
        task,
        workflowId: wfId,
        workspace,
        lastErr,
        lastClassified,
        lastContextAttemptNumber,
        taskCancelSignal,
        taskTraceSpanId,
      });
    }

    // Success path — runRetryLoop only returns lastErr === undefined on a
    // successful executor result. Output is guaranteed non-null here.
    checkAborted(taskCancelSignal, 'before_finalize_success');
    await finalizeSuccess({
      db,
      task,
      workflowId: wfId,
      workspace,
      output: output!,
      doExecute,
      doReview,
      refineCostPerCallUsd,
      refineTimeoutMs,
      taskCancelSignal,
      taskTraceSpanId,
      lastContextAttemptNumber,
    });
  } finally {
    leaseHeartbeat.stop();
    unregisterAbortController(task.id);
  }
}
