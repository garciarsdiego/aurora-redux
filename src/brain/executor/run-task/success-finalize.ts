import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { Task, ReviewResult } from '../../../types/index.js';
import type { ReviewerRuntimeContext } from '../../../v2/reviewer/outcome.js';
import {
  insertEvent,
  setTaskCompleted,
  setTaskFailed,
} from '../../../db/persist.js';
import { saveArtifact } from '../../../artifacts/store.js';
import { recordModelCall, providerFromModel } from '../../../v2/llm-ledger/store.js';
import { completeTaskLease } from '../../../db/task-leases.js';
import {
  safeRecordTaskHandoff,
  safeRecordTaskThreadEvent,
} from '../../../context/workflow-adapter.js';
import { reviewAndRefine } from '../refine.js';
import { runPrecommitGate } from '../../validation/precommit-gate.js';
import { getBenchmarkStore } from '../../../benchmark/index.js';

// CORREÇÃO L4-002: Importar função para extrair tool calls do output
import { extractToolCallsFromCliEnvelope } from '../../../v2/reviewer/outcome.js';

import { checkAborted, isAbortError } from './cancel.js';
import { releaseCostReservation } from '../cost-cap.js';
import { resolveReviewerWorkspaceDir } from './reviewer-workspace.js';
import { runStateSchemaCheck, loadReviewerStateSchemaViolations } from './state-schema-check.js';
import { runQualityGate } from './quality-gate.js';
import { endTaskTraceSpan } from './trace-span.js';

// llm_call ledger — persists token counts / model_used onto the task row,
// records the call in the llm-ledger and registers the benchmark run.
// Extracted from finalizeSuccess (pure move). Fail-safe: any error is folded
// into a model_call_record_error / benchmark_record_error audit event.
async function recordLlmCallLedger(
  db: Database.Database,
  task: Task,
  wfId: string,
  output: string,
): Promise<void> {
  if (
    task.kind !== 'llm_call' ||
    !(task.model_used || task.input_tokens !== undefined || task.output_tokens !== undefined || task.llm_call_cost_usd !== undefined)
  ) {
    return;
  }
  const model = task.model_used ?? task.model ?? 'unknown';
  try {
    db.prepare(
      `UPDATE tasks
          SET input_tokens = COALESCE(?, input_tokens),
              output_tokens = COALESCE(?, output_tokens),
              model_used = COALESCE(?, model_used)
        WHERE id = ?`,
    ).run(
      task.input_tokens ?? null,
      task.output_tokens ?? null,
      task.model_used ?? null,
      task.id,
    );
    recordModelCall(db, {
      workflowId: wfId,
      taskId: task.id,
      model,
      provider: providerFromModel(model) ?? undefined,
      inputTokens: task.input_tokens ?? undefined,
      outputTokens: task.output_tokens ?? undefined,
      costUsd: task.llm_call_cost_usd ?? undefined,
      latencyMs: task.llm_call_latency_ms ?? undefined,
      source: 'executor',
      // W5-backend: surfaced on the synthetic cost_delta SSE event so
      // the dashboard can attribute cost movement back to llm_call
      // tasks (separates from cli_spawn / pal_call / tool_call buckets).
      kind: 'llm_call',
    });
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'model_call_recorded',
      payload: {
        model,
        input_tokens: task.input_tokens ?? null,
        output_tokens: task.output_tokens ?? null,
        cost_usd: task.llm_call_cost_usd ?? null,
      },
    });

    // Orchestration integration: record benchmark for llm_call tasks
    if (task.model_used && task.llm_call_cost_usd !== undefined) {
      try {
        const benchmarkStore = getBenchmarkStore();
        const provider = providerFromModel(model) ?? 'omniroute';
        const useCase = task.acceptance_criteria ? 'code' : 'general'; // Simple heuristic

        await benchmarkStore.recordRun({
          id: `run-${wfId}-${task.id}-${Date.now()}`,
          provider,
          model: task.model_used,
          use_case: useCase,
          input: task.input_json || '',
          output: output,
          quality_score: 0.8, // Default quality, could be improved with reviewer score
          cost_usd: Number(task.llm_call_cost_usd || 0),
          latency_ms: Number(task.llm_call_latency_ms || 0),
          success: true,
          timestamp: Date.now()
        });
      } catch (benchmarkErr) {
        // Don't fail the task if benchmark recording fails
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'benchmark_record_error',
          payload: { error: (benchmarkErr as Error).message },
        });
      }
    }
  } catch (err) {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'model_call_record_error',
      payload: { error: (err as Error).message },
    });
  }
}

type ArchitectureContract = import('../../../workflow-modes/existing-code-feature.js').ArchitectureContract;

// Wave 1.1 (F1-2) + Wave 1.4 follow-up (F1-15 H1 / sec H-1): pull the
// architecture contract recorded by the architecture-scout task (if any)
// so the reviewer can apply the existing-code judgment overlay. Dynamic
// import avoids a circular edge between brain/executor and quality/.
//
// Defensive guards:
//   * If the dynamic import OR the DB query throws, we MUST NOT let the
//     exception bubble — the outer post-completion try/catch would flip
//     the task to failed even though the worker succeeded. Always emit an
//     event on failure so silent failures show up in the audit log.
//   * Redact any secrets the contract might carry before forwarding it to
//     the reviewer prompt — the contract is operator-derived but may
//     include paths or tokens that flow into LLM context.
async function loadArchitectureContractSafely(
  db: Database.Database,
  task: Task,
  wfId: string,
): Promise<ArchitectureContract | null> {
  try {
    const { loadArchitectureContractForWorkflow } = await import('../../../quality/final-evidence.js');
    const raw = loadArchitectureContractForWorkflow(db, wfId);
    if (raw) {
      const { redactContextJson } = await import('../../../context/redaction.js');
      return redactContextJson(raw) as ArchitectureContract;
    }
  } catch (err) {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'architecture_contract_load_error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  return null;
}

// Success-finalize phase — invoked after the retry loop produced a non-null
// `output` AND no terminal error. Persists the completion, runs the
// state-schema check, records the model call, dispatches review-and-refine,
// runs the quality gate, records handoffs/thread events, persists the
// artifact, and emits the closing trace span. Any error thrown here is
// re-raised so the outer finally block in index.ts releases the lease.
export async function finalizeSuccess(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  workspace: string;
  output: string;
  doExecute: (task: Task, signal?: AbortSignal) => Promise<string>;
  doReview: (task: Task, output: string, ctx?: ReviewerRuntimeContext) => Promise<ReviewResult>;
  refineCostPerCallUsd: number;
  refineTimeoutMs: number;
  taskCancelSignal: AbortSignal;
  taskTraceSpanId: string | undefined;
  lastContextAttemptNumber: number;
}): Promise<void> {
  const {
    db,
    task,
    workflowId: wfId,
    workspace,
    output,
    doExecute,
    doReview,
    refineCostPerCallUsd,
    refineTimeoutMs,
    taskCancelSignal,
    taskTraceSpanId,
    lastContextAttemptNumber,
  } = params;

  try {
    setTaskCompleted(db, task.id, output);
    completeTaskLease(db, task.id, 'completed');
    task.status = 'completed';
    task.output_json = output;

    // B9.2 — state_schema runtime validation (extracted helper).
    const stateSchemaViolations = await runStateSchemaCheck(db, task, wfId, output);

    // llm_call ledger + benchmark (extracted helper; no-op for other kinds).
    await recordLlmCallLedger(db, task, wfId, output);

    // Wave 2.C — fold any prior-cycle violations into the reviewer context
    // (extracted helper handles fresh + persisted merge).
    const reviewerStateSchemaViolations = await loadReviewerStateSchemaViolations(
      db,
      task,
      stateSchemaViolations,
    );

    const reviewerWorkspaceDir = resolveReviewerWorkspaceDir(task, workspace, output, db, wfId);

    // Architecture contract for the reviewer's existing-code judgment overlay
    // (extracted helper; fail-safe, emits architecture_contract_load_error).
    const architectureContract = await loadArchitectureContractSafely(db, task, wfId);
    const workflowMode = architectureContract ? 'existing_code_feature' as const : 'standard' as const;

    // Aurora-parity Wave 1 (WS2) — deterministic precommit self-review: scan the
    // files this cli_spawn coding task changed for committed secrets before it is
    // handed back. Fail-safe: a gate error must never flip a successful task to
    // failed (it runs before the throw-sensitive review path), so swallow + audit.
    try {
      runPrecommitGate(db, task, wfId);
    } catch (err) {
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_precommit_scan',
        payload: { error: err instanceof Error ? err.message : String(err), files_scanned: 0, secret_findings: 0 },
      });
    }

    // Tier 0 Wave 3 (ITEM 0.2) — yield to cancel before review and refine
    // dispatch. The refine loop may run multiple LLM round-trips; without
    // this checkpoint a mid-cycle cancel would only surface after the next
    // executor call returned.
    checkAborted(taskCancelSignal, 'before_review_and_refine');

    // CORREÇÃO L4-002: Extrair tool calls do output para passar ao reviewer
    // Isso permite que o reviewer valide se as operações foram realmente executadas
    const toolCallsTrace = extractToolCallsFromCliEnvelope(output);

    await reviewAndRefine(
      db,
      task,
      wfId,
      output,
      doExecute,
      doReview,
      refineCostPerCallUsd,
      refineTimeoutMs,
      {
        workflowId: wfId,
        taskId: task.id,
        workspaceDir: reviewerWorkspaceDir,
        ...(reviewerStateSchemaViolations
          ? { stateSchemaViolations: reviewerStateSchemaViolations }
          : {}),
        // CORREÇÃO L4-002: Passar toolCallsTrace para o reviewer via contexto
        ...(toolCallsTrace && toolCallsTrace.length > 0
          ? { toolCallsTrace }
          : {}),
        workflowMode,
        architectureContract,
      },
      taskCancelSignal,
    );
    checkAborted(taskCancelSignal, 'after_review_and_refine');

    await runQualityGate(db, task, wfId);
    safeRecordTaskHandoff(db, {
      workspace,
      runId: wfId,
      taskId: task.id,
      taskName: task.name,
      attempt: lastContextAttemptNumber,
      kind: 'summary',
      title: `${task.name} completed`,
      body: task.output_json ?? output,
      safeContext: {
        reviewed: true,
        retry_count: task.retry_count,
        refine_count: task.refine_count,
        model: task.model ?? null,
        model_used: task.model_used ?? null,
      },
    });
    safeRecordTaskThreadEvent(db, {
      workspace,
      runId: wfId,
      taskId: task.id,
      taskName: task.name,
      eventType: 'task_completed',
      body: `Task completed: ${task.name}`,
      metadata: {
        retry_count: task.retry_count,
        refine_count: task.refine_count,
        output_chars: task.output_json?.length ?? output.length,
      },
    });
    insertEvent(db, { workflow_id: wfId, task_id: task.id, type: 'task_completed' });

    // Persist the final output (post-refine) as an artifact. Non-fatal.
    if (workspace && task.output_json) {
      try {
        await saveArtifact(db, {
          workflow_id: wfId,
          task_id: task.id,
          workspace,
          content: task.output_json,
          basePath: resolve('workspaces', workspace, 'runs', wfId),
        });
      } catch (err) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'artifact_save_error',
          payload: { error: (err as Error).message },
        });
      }
    }

    endTaskTraceSpan(db, taskTraceSpanId, wfId, task.id, 'ok', {
      output_size: task.output_json?.length ?? 0,
      retry_count: task.retry_count,
      refine_count: task.refine_count,
      model: task.model ?? null,
      model_used: task.model_used ?? null,
      input_tokens: task.input_tokens ?? null,
      output_tokens: task.output_tokens ?? null,
      cost_usd: task.llm_call_cost_usd ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // BRAIN-07 — the worker output succeeded, but a post-review/finalize phase
    // threw (review-and-refine, quality gate, handoff, or artifact persist).
    // The task was optimistically flipped to `completed` at the top of this
    // function; leaving it there would let a workflow consume an output that
    // never passed review. Flip it back to `failed` BEFORE re-throwing so the
    // orchestrator's batch-failure path marks the workflow failed and the
    // operator-visible state reflects the unreviewed/untrusted result. Wrapped
    // fail-safe so the status flip never masks the original error. An aborted
    // (operator-cancel) finalize is left as-is — cancel is handled upstream and
    // must not be downgraded to a hard failure.
    const isAbort = isAbortError(err);
    if (!isAbort) {
      try {
        setTaskFailed(db, task.id);
        task.status = 'failed';
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_post_review_failed',
          payload: {
            phase: 'post_execution_review_or_artifact',
            error: message,
            previously_marked: 'completed',
          },
        });
      } catch (flipErr) {
        // Status-flip / event failure must not swallow the original cause.
        process.stderr.write(
          `[success-finalize] failed to flip task ${task.id} to failed after ` +
          `post-review throw: ${flipErr instanceof Error ? flipErr.message : String(flipErr)}\n`,
        );
      }
    }

    safeRecordTaskHandoff(db, {
      workspace,
      runId: wfId,
      taskId: task.id,
      taskName: task.name,
      attempt: lastContextAttemptNumber,
      kind: 'error',
      title: `${task.name} review or artifact phase failed`,
      body: message,
      safeContext: {
        phase: 'post_execution_review_or_artifact',
        retry_count: task.retry_count,
        refine_count: task.refine_count,
        model: task.model ?? null,
        model_used: task.model_used ?? null,
      },
    });
    endTaskTraceSpan(db, taskTraceSpanId, wfId, task.id, 'error', {
      error: message,
      retry_count: task.retry_count,
      refine_count: task.refine_count,
      model: task.model ?? null,
      model_used: task.model_used ?? null,
    });
    throw err;
  } finally {
    // BRAIN-04 — this task reached a terminal finalize (completed or
    // post-review failure). Release its estimate reservation so the per-DAG
    // cost cap counts only the real spend (now in the ledger) going forward.
    // Idempotent + fail-safe; never affects the success/error result.
    releaseCostReservation(wfId, task.id);
  }
}
