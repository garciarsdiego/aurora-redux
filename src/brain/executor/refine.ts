import type Database from 'better-sqlite3';
import type { Task, ReviewResult } from '../../types/index.js';
import type { ReviewOutcome, ReviewerRuntimeContext } from '../../v2/reviewer/outcome.js';
import { classifyError } from '../../v2/failover/classifier.js';
import {
  newReviewId,
  insertEvent,
  insertReview,
  setTaskCompleted,
  setTaskFailed,
  setRefineFeedback,
  incrementRefineCount,
} from '../../db/persist.js';
import {
  getReviewerModel,
  getMaxRefineCostUsd,
  getMaxReviewTimeMs,
  shouldReviewTask,
} from '../../utils/config.js';
import { verifyAcceptanceArtifacts } from '../../v2/agents/validators/filesystem.js';
import { withTimeout, composeAbortSignals } from './internal-utils.js';
import { checkAborted } from './run-task/cancel.js';
import { emitBasicReviewOutcome } from './upstream.js';

export function emitRefineSoftFailure(
  db: Database.Database,
  wfId: string,
  taskId: string,
  detail: { feedback: string; caveats?: string[] },
): void {
  const outcome: ReviewOutcome = {
    outcome_type: 'soft_failure',
    confidence: 0,
    feedback: detail.feedback,
    caveats: detail.caveats,
    next_action: 'abort',
  };
  insertEvent(db, {
    workflow_id: wfId,
    task_id: taskId,
    type: 'task_review_outcome',
    payload: outcome,
  });
}

function cleanFilesystemEvidenceForReviewTimeout(
  task: Task,
  reviewContext: ReviewerRuntimeContext,
): { verified: string[] } | null {
  if (task.kind !== 'cli_spawn') return null;
  const workspaceDir = reviewContext.workspaceDir ?? task.workspace;
  if (!workspaceDir) return null;

  const fsCheck = verifyAcceptanceArtifacts(task.acceptance_criteria, workspaceDir);
  const clean =
    fsCheck.summary.files_verified.length > 0 &&
    fsCheck.summary.files_missing.length === 0 &&
    fsCheck.summary.files_too_short.length === 0;

  return clean ? { verified: fsCheck.summary.files_verified } : null;
}

// Reviews output and, if the review fails, re-executes with feedback injected until
// task.max_refine is exhausted. On exhaustion emits task_refine_exhausted but keeps
// the task completed. Reviewer errors are non-fatal (task_review_error emitted, loop stops).
export async function reviewAndRefine(
  db: Database.Database,
  task: Task,
  wfId: string,
  initialOutput: string,
  doExecute: (task: Task, signal?: AbortSignal) => Promise<string>,
  doReview: (task: Task, output: string, ctx?: ReviewerRuntimeContext) => Promise<ReviewResult>,
  refineCostPerCallUsd: number,
  refineTimeoutMs: number,
  reviewContext: ReviewerRuntimeContext = {},
  cancelSignal?: AbortSignal,
): Promise<void> {
  if (!task.acceptance_criteria) {
    emitBasicReviewOutcome(db, wfId, task, initialOutput);
    return;
  }

  let currentOutput = initialOutput;
  let accumulatedCostUsd = 0;
  const refineStartTime = Date.now();
  // D34.5 Bug A — without this cap a hung reviewer blocks the workflow forever.
  // Per-task scaling (Example smoke test 2026-04-30): the floor (default
  // 240s) catches simple llm_call reviews. For heavier tasks with explicit
  // longer timeout_seconds (e.g. cli_spawn writing a Klondike engine at
  // 900s), the review allowance scales to half the task's own time budget
  // since the reviewer needs to read substantial generated output. Capped
  // at 600s (10 min) so a runaway reviewer can't stall the workflow
  // indefinitely.
  const baseReviewMs = getMaxReviewTimeMs();
  const taskTimeoutMs = (task.timeout_seconds ?? 300) * 1000;
  const maxReviewTimeMs = process.env['MAX_REVIEW_TIME_MS'] != null
    ? baseReviewMs
    : Math.min(
        Math.max(baseReviewMs, Math.round(taskTimeoutMs * 0.5)),
        600_000,
      );

  // OTIMIZAÇÃO 4: Review seletivo por complexidade
  // Se a task não precisar de review, aprovar automaticamente
  // Inferir complexidade baseado em timeout e tipo
  const inferredComplexity = task.timeout_seconds < 60 ? 'low' : task.timeout_seconds < 300 ? 'medium' : 'high';
  const inferredRequiresWrite = task.kind === 'tool_call' || (task.acceptance_criteria ? task.acceptance_criteria.toLowerCase().includes('file') : false);

  if (!shouldReviewTask({
    kind: task.kind,
    complexity: inferredComplexity,
    requires_write: inferredRequiresWrite,
    acceptance_criteria: task.acceptance_criteria,
    timeout_seconds: task.timeout_seconds,
    max_refine: task.max_refine,
  })) {
    // Auto-aprovar tasks simples sem chamar o reviewer
    const autoReview: ReviewResult = {
      score: 1.0,
      feedback: 'Auto-approved: task complexity low, review skipped per policy',
      passed: true,
    };
    
    insertReview(db, {
      id: newReviewId(),
      task_id: task.id,
      workflow_id: wfId,
      reviewer_model: 'auto-policy',
      criteria: task.acceptance_criteria,
      score: 1.0,
      feedback: autoReview.feedback,
      passed: 1,
      created_at: Date.now(),
    });
    
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_reviewed',
      payload: {
        score: 1.0,
        passed: true,
        caveat: 'auto_approved_low_complexity',
      },
    });

    // Auto-aprovação: marcar task como completada e sair da função
    setTaskCompleted(db, task.id, currentOutput);
    return;
  }

  while (true) {
    // Tier 0 Wave 3 (ITEM 0.2) — yield to cancel at the top of each refine
    // iteration so a workflow cancel mid-refine surfaces immediately.
    checkAborted(cancelSignal, 'refine_iteration_top');
    let review: ReviewResult;
    try {
      review = await withTimeout(
        (timeoutSignal) => {
          // Bridge timeout + cancel (Wave 5A #2 — composeAbortSignals owns the
          // listener cleanup). NOTE: doReview does not consume a signal yet;
          // the composition is kept for listener-bookkeeping parity with the
          // re-execute site below.
          composeAbortSignals(timeoutSignal, cancelSignal);
          return doReview(task, currentOutput, reviewContext);
        },
        maxReviewTimeMs,
        `review_${task.name}`,
      );
      checkAborted(cancelSignal, 'refine_after_review');
    } catch (err) {
      // Cancel surfaces as AbortError; bubble up so the caller marks the
      // task cancelled instead of failing it through the reviewer path.
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const classified = classifyError(err);
      const msg = classified.message;
      const isTimeout = classified.reason === 'timeout';
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: isTimeout ? 'task_review_timeout' : 'task_review_error',
        payload: {
          error: msg,
          reason: classified.reason,
          status: classified.status,
          timeout_ms: isTimeout ? maxReviewTimeMs : undefined,
        },
      });
      const cleanFsEvidence = isTimeout
        ? cleanFilesystemEvidenceForReviewTimeout(task, reviewContext)
        : null;
      if (cleanFsEvidence) {
        const feedback = [
          `Reviewer timed out after ${maxReviewTimeMs}ms.`,
          `Filesystem precheck verified ${cleanFsEvidence.verified.join(', ')} with no missing or too-short required files.`,
          'Treating this as reviewer_timeout_filesystem_verified so the worker output is not failed by reviewer infrastructure.',
        ].join(' ');
        insertReview(db, {
          id: newReviewId(),
          task_id: task.id,
          workflow_id: wfId,
          reviewer_model: getReviewerModel(),
          criteria: task.acceptance_criteria,
          score: 0.8,
          feedback,
          passed: 1,
          created_at: Date.now(),
        });
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_reviewed',
          payload: {
            score: 0.8,
            passed: true,
            caveat: 'reviewer_timeout_filesystem_verified',
          },
        });
        const outcome: ReviewOutcome = {
          outcome_type: 'soft_success',
          confidence: 0.8,
          feedback,
          caveats: ['reviewer_timeout_filesystem_verified'],
          next_action: 'escalate_human',
        };
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_review_outcome',
          payload: outcome,
        });
        return;
      }
      // AUDIT F-D1-2: reviewer failure must not leave task in `completed`
      // with a stale output. Emit typed outcome and surface as hard_failure
      // before re-throwing so the runner marks the task failed.
      const outcome: ReviewOutcome = {
        outcome_type: 'hard_failure',
        confidence: 0,
        feedback: `Reviewer failed (${classified.reason}): ${msg}`,
        next_action: 'abort',
      };
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_review_outcome',
        payload: outcome,
      });
      setTaskFailed(db, task.id);
      throw err;
    }

    insertReview(db, {
      id: newReviewId(),
      task_id: task.id,
      workflow_id: wfId,
      reviewer_model: getReviewerModel(),
      criteria: task.acceptance_criteria,
      score: review.score,
      feedback: review.feedback,
      passed: review.passed ? 1 : 0,
      created_at: Date.now(),
    });

    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: review.passed ? 'task_reviewed' : 'task_review_failed',
      payload: { score: review.score, passed: review.passed },
    });

    if (review.passed) {
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_review_outcome',
        payload: { outcome_type: 'hard_success', confidence: review.score, feedback: review.feedback } satisfies ReviewOutcome,
      });
      return;
    }

    if (task.refine_count >= task.max_refine) {
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_refine_exhausted',
        payload: { refine_count: task.refine_count, last_score: review.score },
      });
      emitRefineSoftFailure(db, wfId, task.id, {
        feedback: `Refine exhausted after ${task.refine_count} attempts (last score ${review.score}).`,
        caveats: ['refine_exhausted'],
      });
      return;
    }

    const maxRefineCostUsd = getMaxRefineCostUsd();
    if (accumulatedCostUsd + refineCostPerCallUsd > maxRefineCostUsd) {
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_refine_budget_exceeded',
        payload: { cost_usd: accumulatedCostUsd, max_cost_usd: maxRefineCostUsd },
      });
      emitRefineSoftFailure(db, wfId, task.id, {
        feedback: `Refine budget exceeded (spent $${accumulatedCostUsd.toFixed(4)} of $${maxRefineCostUsd}).`,
        caveats: ['refine_budget_exceeded'],
      });
      return;
    }

    if (refineTimeoutMs > 0) {
      const elapsedMs = Date.now() - refineStartTime;
      if (elapsedMs > refineTimeoutMs) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_refine_timeout',
          payload: { elapsed_ms: elapsedMs, max_ms: refineTimeoutMs },
        });
        emitRefineSoftFailure(db, wfId, task.id, {
          feedback: `Refine timed out after ${Math.round(elapsedMs / 1000)}s (cap ${Math.round(refineTimeoutMs / 1000)}s).`,
          caveats: ['refine_timeout'],
        });
        return;
      }
    }

    accumulatedCostUsd += refineCostPerCallUsd;
    setRefineFeedback(db, task.id, review.feedback);
    task.refine_feedback = review.feedback;
    incrementRefineCount(db, task.id);
    task.refine_count += 1;

    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_refining',
      payload: { refine_count: task.refine_count, feedback: review.feedback },
    });

    checkAborted(cancelSignal, 'refine_before_reexecute');
    try {
      currentOutput = await withTimeout(
        // Bridge timeout signal with workflow cancel signal so the worker
        // is interrupted by either path (Wave 5A #2 — composeAbortSignals
        // owns the listener cleanup).
        (timeoutSignal) => doExecute(task, composeAbortSignals(timeoutSignal, cancelSignal)),
        task.timeout_seconds * 1000,
        task.name,
      );
      checkAborted(cancelSignal, 'refine_after_reexecute');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      const classified = classifyError(err);
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_refine_error',
        payload: {
          error: classified.message,
          reason: classified.reason,
          status: classified.status,
        },
      });
      emitRefineSoftFailure(db, wfId, task.id, {
        feedback: `Refine execution failed (${classified.reason}): ${classified.message}. Task retains prior output.`,
        caveats: ['refine_error', classified.reason],
      });
      return;
    }

    setTaskCompleted(db, task.id, currentOutput);
    task.output_json = currentOutput;
  }
}
