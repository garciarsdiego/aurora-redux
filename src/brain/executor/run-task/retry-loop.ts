import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import type { FailoverError } from '../../../v2/failover/error.js';
import {
  classifyError,
  classifyErrorWithPersona,
  applyClassifierMutations,
  type MutableTaskContext,
} from '../../../v2/failover/classifier.js';
import { selectBackoffMs, selectFallbackModel, type OmniforgeRole } from '../../../v2/failover/policy.js';
import { computeRecoveryDecision, type RecoveryState } from '../../../v2/failover/recovery-policy.js';
import { BudgetExceededError, GlobalBudgetExceededError } from '../../../v2/budget/control.js';
import { resolveContextEngine } from '../../../v2/context-engine/registry.js';
import {
  insertEvent,
  incrementRetryCount,
} from '../../../db/persist.js';
import type { BridgeResult, BestComboResult } from '../../../v2/omniroute-bridge/index.js';
import { withTimeout, retryDelayMs } from '../internal-utils.js';
import { buildMessagesFromTask } from '../upstream.js';
import { resolveWorkflowCliPermissionMode } from '../../../db/workflow-cli-permission.js';
import { spanContextStorage } from '../../../v2/observability/tracing.js';
import {
  buildTransitionContext,
  dagFromTasks,
  transitionContextStorage,
  type TransitionContext,
} from '../../../v2/agents/transition-context.js';
import { getUsePersonas } from '../../../utils/config.js';
import { safeRecordTaskContextPacket } from '../../../context/workflow-adapter.js';
import { withCliPermissionMode } from '../../../executors/cli.js';
import { safeParseJson } from '../../../utils/safe-parse-json.js';

import { checkAborted, isAbortError } from './cancel.js';
import {
  buildSafeTaskContextPacket,
  contextAttempt,
  parseInputKeys,
  applyLegacyTransitionPrefix,
} from './context-packet.js';
import {
  tryAcquireClaudeCodeRuntimeSession,
  emitOpencodeAcpIntentIfApplicable,
} from './dispatchers/index.js';

const MAX_TIMEOUT_SECONDS = 1800;

export interface RetryLoopResult {
  output: string | undefined;
  lastErr: unknown;
  lastClassified: FailoverError | undefined;
  lastContextAttemptNumber: number;
}

// SAFE-02 — map an executing task to the OmniforgeRole whose fallback chain the
// operator-authored Setup → Fallback pane (or the hardcoded role chain) should
// walk. Best-effort and total: any task lands on a sensible default so the
// operator chain is always consulted before doBestCombo.
//
// We only have task.kind + task.executor_hint + task.model at this layer, so we
// derive the CLI/llm role from those. The returned role is fed to
// selectFallbackModel(role, task.model).
function deriveFallbackRole(task: Task): OmniforgeRole {
  if (task.kind === 'cli_spawn') {
    const hint = (task.executor_hint ?? '').toLowerCase();
    const model = (task.model ?? '').toLowerCase();
    if (hint.includes('codex') || model.startsWith('cx/')) return 'executor-cli-codex';
    if (hint.includes('gemini') || model.startsWith('gemini-cli/')) return 'executor-cli-gemini';
    // claude-code is the default CLI; also covers cli:claude-code / cc/ models.
    return 'executor-cli-claude';
  }
  // llm_call (and any LLM-backed kind) → the default llm-call chain.
  return 'executor-llm-call-default';
}

// SAFE-01 — prepend a persona-supplied prompt-prefix into the task's objective
// so the next attempt sees the hardening banner (e.g. "you READ but did not
// Write — call Write NOW"). Mirrors applyLegacyTransitionPrefix's input_json
// objective merge. Fail-safe: never throws.
function prependObjectivePrefix(
  task: Task,
  prefix: string,
  db: Database.Database,
  wfId: string,
): void {
  if (!prefix) return;
  const parsed = safeParseJson<Record<string, unknown>>(task.input_json, {
    where: 'safe01_prompt_prefix',
    db,
    workflowId: wfId,
    taskId: task.id,
  });
  const ctx = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const existing = typeof ctx['objective'] === 'string' ? ctx['objective'] : '';
  ctx['objective'] = existing ? `${prefix}\n\n${existing}` : prefix;
  task.input_json = JSON.stringify(ctx);
}

// SAFE-01 — run the persona failover classifier on the failure and apply its
// self-healing mutations (model swap, prompt-prefix hardening, workspace-clean)
// to the live task before the loop iterates. Returns the strategy that fired
// (for observability) or null when nothing actionable was applied.
//
// Fully fail-safe: a persona failure, a parse failure, or a mutation error must
// never inject a new error type into the retry loop — we swallow and let the
// legacy classifyError decision tree (already computed by the caller) drive
// control flow.
async function applyPersonaRemediation(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  workspace: string;
  err: unknown;
  attempt: number;
}): Promise<string | null> {
  const { db, task, workflowId: wfId, workspace, err, attempt } = params;
  try {
    const output = await classifyErrorWithPersona(err, {
      taskId: task.id,
      workflowId: wfId,
      retryCount: task.retry_count,
      workspaceDir: task.workspace ?? workspace,
    });

    const taskCtx: MutableTaskContext = {
      model: task.model ?? undefined,
      workspaceDir: task.workspace ?? workspace,
      retryCount: task.retry_count,
    };
    await applyClassifierMutations(output, taskCtx);

    // Apply the mutated fields back onto the live task.
    if (taskCtx.model && taskCtx.model !== task.model) {
      const previousModel = task.model;
      task.model = taskCtx.model;
      task.model_used = taskCtx.model;
      try {
        db.prepare('UPDATE tasks SET model = ?, model_used = ? WHERE id = ?').run(
          taskCtx.model,
          taskCtx.model,
          task.id,
        );
      } catch {
        try {
          db.prepare('UPDATE tasks SET model = ? WHERE id = ?').run(taskCtx.model, task.id);
        } catch { /* ignore legacy schemas */ }
      }
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_persona_model_swapped',
        payload: { previous_model: previousModel, new_model: taskCtx.model, attempt },
      });
    }
    if (taskCtx.promptPrefix) {
      prependObjectivePrefix(task, taskCtx.promptPrefix, db, wfId);
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_persona_prompt_hardened',
        payload: { attempt },
      });
    }

    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_persona_remediation',
      payload: {
        strategy: output.strategy,
        mutation_count: output.mutations.length,
        shortcut_id: output.shortcut_id ?? null,
        attempt,
      },
    });
    return output.strategy;
  } catch (personaErr) {
    // Self-healing must be best-effort. Record the miss, keep legacy flow.
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_persona_remediation_failed',
      payload: {
        error: personaErr instanceof Error ? personaErr.message : String(personaErr),
        attempt,
      },
    });
    return null;
  }
}

// The main retry loop — pulls the `doExecute` callback for the actual
// task-kind dispatch (cli_spawn / llm_call / tool_call / pal_call wiring
// lives behind that callback in the executor). This module owns:
//   * per-attempt cancel checkpoints
//   * dynamic timeout escalation on timeout-classified retries
//   * recovery-policy state for non-timeout retryable errors
//   * transition-context computation + legacy prefix injection
//   * runtime-session pool acquisition for cli:claude-code
//   * opencode ACP intent breadcrumb
//   * timeout-signal + cancel-signal composition for the executor call
//   * context overflow → compact-and-retry path
//   * credential-rotation, fallback-model, non-retryable terminal paths
export async function runRetryLoop(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  workspace: string;
  doExecute: (task: Task, signal?: AbortSignal) => Promise<string>;
  doSleep: (ms: number) => Promise<void>;
  doBestCombo: (taskKind: string, complexity: string) => Promise<BridgeResult<BestComboResult>>;
  allTasks?: Task[];
  maxAttempts: number;
  leaseAttempt: number;
  taskCancelSignal: AbortSignal;
  taskTraceSpanId: string | undefined;
}): Promise<RetryLoopResult> {
  const {
    db,
    task,
    workflowId: wfId,
    workspace,
    doExecute,
    doSleep,
    doBestCombo,
    allTasks,
    maxAttempts,
    leaseAttempt,
    taskCancelSignal,
    taskTraceSpanId,
  } = params;
  // `workspace` is consumed by SAFE-01 persona remediation (applyPersonaRemediation).

  let output: string | undefined;
  let lastErr: unknown;
  let lastClassified: FailoverError | undefined;

  // Dynamic timeout escalation on timeout-classified retries. Each timeout
  // retry gets 50% more wall-clock than the previous attempt, capped at
  // MAX_TIMEOUT_SECONDS (1800s). Non-timeout retries use the original value.
  // effectiveTimeoutSec is NOT persisted — escalation resets on workflow resume
  // to prevent cascading growth across sessions (see brief §HC5).
  let effectiveTimeoutSec = task.timeout_seconds;
  let lastContextAttemptNumber = contextAttempt(leaseAttempt, 1);

  // Fusion T1.1 — Recovery-policy state for transient non-timeout errors.
  // Tracked in-memory (not persisted to a DB column) for the same reason
  // effectiveTimeoutSec is not persisted: resets on resume are intentional
  // to avoid compounding recovery counts across engine restarts.
  let recoveryState: RecoveryState = {};

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Tier 0 Wave 3 (ITEM 0.2) — yield to cancel at the top of every retry
    // iteration so a workflow cancel observed mid-backoff or mid-loop does
    // not wait for the next natural await boundary.
    checkAborted(taskCancelSignal, `retry_loop_top_attempt_${attempt}`);
    if (attempt > 1) {
      const explicitFixedPolicy = task.retry_policy.startsWith('fixed:');
      // Aurora-parity Wave-1.5 #1 — pass the classifier-captured server
      // Retry-After window so a 429/503 backoff honours the provider's own
      // reset window instead of the hardcoded 10s / blind-exponential default.
      const baseDelayMs = !explicitFixedPolicy && lastClassified
        ? selectBackoffMs(lastClassified.reason, attempt - 1, lastClassified.retryAfterMs)
        : retryDelayMs(task.retry_policy, attempt - 1);
      await doSleep(baseDelayMs);
      checkAborted(taskCancelSignal, `retry_loop_after_backoff_attempt_${attempt}`);
      incrementRetryCount(db, task.id);
      task.retry_count += 1;
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_retrying',
        payload: {
          attempt,
          backoff_ms: baseDelayMs,
          reason: lastClassified?.reason,
          retry_after_ms: lastClassified?.retryAfterMs ?? null,
        },
      });

      // Escalate effective timeout when the previous attempt was classified as
      // a timeout. Each escalation multiplies by 1.5×, capped at 1800s.
      // R-HIGH (Opus review 2026-04-23): when already at the cap, further retries
      // are a no-op — same deadline, same failure, 30min wasted per attempt.
      // Short-circuit to a terminal timeout outcome instead of running pointless
      // retries (3 retries × 1800s = 90 minutes of idle waste).
      if (lastClassified?.reason === 'timeout') {
        if (effectiveTimeoutSec >= MAX_TIMEOUT_SECONDS) {
          insertEvent(db, {
            workflow_id: wfId,
            task_id: task.id,
            type: 'task_timeout_cap_reached',
            payload: { timeout_s: effectiveTimeoutSec, attempt },
          });
          break; // abort retry loop — further attempts use identical deadline
        }
        const previous = effectiveTimeoutSec;
        effectiveTimeoutSec = Math.min(
          Math.round(effectiveTimeoutSec * 1.5),
          MAX_TIMEOUT_SECONDS,
        );
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_timeout_extended',
          payload: { previous_s: previous, new_s: effectiveTimeoutSec, attempt },
        });
      }

      // Fusion T1.1 — Recovery policy for transient non-timeout errors.
      // The timeout block above handles 'timeout' reason exclusively; this block
      // handles all other isRetryable reasons (rate_limit, overloaded, server_error,
      // unknown, etc.) and caps the total retry budget at MAX_RECOVERY_RETRIES=3.
      // Note: the computed delayMs and nextRecoveryAt in RecoveryState are emitted
      // to the event log for observability; the actual inter-retry sleep is provided
      // by selectBackoffMs / doSleep above — no additional sleep is added here.
      if (lastClassified?.isRetryable && lastClassified.reason !== 'timeout') {
        const decision = computeRecoveryDecision(recoveryState);
        if (decision.exhausted) {
          insertEvent(db, {
            workflow_id: wfId,
            task_id: task.id,
            type: 'task_recovery_exhausted',
            payload: { reason: lastClassified.reason, attempt },
          });
          break;
        }
        // Carry the updated count forward to the next iteration.
        recoveryState = decision.nextState;
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_recovery_scheduled',
          payload: {
            reason: lastClassified.reason,
            delay_ms: decision.delayMs,
            attempt,
            retry_count: decision.nextState.recoveryRetryCount,
          },
        });
      }
    }
    let activeTransition: TransitionContext | undefined;
    if (allTasks && allTasks.length > 0) {
      const dag = dagFromTasks(allTasks);
      activeTransition = buildTransitionContext(task, allTasks, dag, db, wfId);
      if (attempt === 1) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'transition_context',
          payload: {
            task_id: task.id,
            origin_type: activeTransition.origin_type,
            execution_number: activeTransition.execution_number,
          },
        });
      }
      if (!getUsePersonas() && attempt === 1) {
        applyLegacyTransitionPrefix(task, activeTransition, db, wfId);
      }
    }
    const contextAttemptNumber = contextAttempt(leaseAttempt, attempt);
    lastContextAttemptNumber = contextAttemptNumber;
    safeRecordTaskContextPacket(db, {
      workspace,
      runId: wfId,
      taskId: task.id,
      taskName: task.name,
      attempt: contextAttemptNumber,
      dependsOn: task.depends_on,
      packet: buildSafeTaskContextPacket(
        task,
        wfId,
        attempt,
        leaseAttempt,
        effectiveTimeoutSec,
        activeTransition,
      ),
      renderedPrompt: [
        `task=${task.id}`,
        `name=${task.name}`,
        `kind=${task.kind}`,
        `model=${task.model ?? 'unset'}`,
        `executor=${task.executor_hint ?? 'unset'}`,
        `input_keys=${parseInputKeys(task.input_json).join(',')}`,
      ].join('\n'),
    });

    // Wave 2.2 (F2-4): persistent runtime session gate.
    // SCOPED: emits observability events only; live spawn / --resume / cancellation
    // tie-in deferred to next session after F2-5 live probe validates the protocol.
    // The handle is captured for symmetry with the future Wave 2.3 thread-through
    // into runCliTask but is intentionally unused at this layer for now.
    const runtimeHandle = await tryAcquireClaudeCodeRuntimeSession({
      db,
      task,
      workflowId: wfId,
      attempt,
    });
    // Note: runtimeHandle is captured but not yet passed into the executor.
    // Wave 2.3 will thread it through to runCliTask + add --resume injection.
    void runtimeHandle;

    // Wave D — observability breadcrumb when opencode ACP is the target.
    // The actual pool acquire happens inside runCliTask -> runOpencodeViaAcp;
    // this event lets the dashboard distinguish "we intend to take ACP path"
    // from "spawn fallback" without parsing the cli executor's runtime row.
    emitOpencodeAcpIntentIfApplicable({ db, task, workflowId: wfId, attempt });

    // Tier 0 Wave 3 (ITEM 0.2) — yield to cancel before dispatching the
    // task-kind executor. Without this checkpoint, a cancel arriving during
    // upstream-artifact assembly above would not surface until withTimeout's
    // own factory ran — which still calls doExecute on a cancelled task.
    checkAborted(taskCancelSignal, `before_dispatch_kind_${task.kind}`);
    try {
      output = await withTimeout(
        (timeoutSignal) => {
          // Bridge the timeout signal with the task-scoped cancel signal so
          // doExecute sees a single aborting signal regardless of which one
          // fired first. CLI children spawned with this signal are killed by
          // Node's child_process.spawn({ signal }) wiring.
          const composed = new AbortController();
          const onTimeoutAbort = (): void => composed.abort(timeoutSignal.reason);
          const onCancelAbort = (): void => composed.abort(taskCancelSignal.reason);
          if (timeoutSignal.aborted) composed.abort(timeoutSignal.reason);
          else timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true });
          if (taskCancelSignal.aborted) composed.abort(taskCancelSignal.reason);
          else taskCancelSignal.addEventListener('abort', onCancelAbort, { once: true });
          // Wave 5A #2: { once: true } only auto-removes when the event fires.
          // On the happy path (no cancel, multiple retry iterations), listeners
          // accumulate on taskCancelSignal → MaxListenersExceededWarning. Remove
          // both listeners once this iteration's composed controller settles.
          const cleanupListeners = (): void => {
            timeoutSignal.removeEventListener('abort', onTimeoutAbort);
            taskCancelSignal.removeEventListener('abort', onCancelAbort);
          };
          composed.signal.addEventListener('abort', cleanupListeners, { once: true });
          const signal = composed.signal;
          const runInner = (): Promise<string> =>
            spanContextStorage.run(
              { db, parentSpanId: taskTraceSpanId ?? null, workflowId: wfId },
              () => doExecute(task, signal),
            );
          const runWithTransition = (): Promise<string> => {
            if (activeTransition !== undefined) {
              return transitionContextStorage.run(activeTransition, runInner);
            }
            return runInner();
          };
          const persistedCliMode = task.kind === 'cli_spawn'
            ? resolveWorkflowCliPermissionMode(db, wfId)
            : undefined;
          if (persistedCliMode) {
            if (attempt === 1) {
              insertEvent(db, {
                workflow_id: wfId,
                task_id: task.id,
                type: 'task_cli_permission_mode_applied',
                payload: { mode: persistedCliMode },
              });
            }
            return withCliPermissionMode(persistedCliMode, runWithTransition);
          }
          return runWithTransition();
        },
        effectiveTimeoutSec * 1000,
        task.name,
      );
      lastErr = undefined;
      checkAborted(taskCancelSignal, 'after_executor_result');
      break;
    } catch (err) {
      // Tier 0 Wave 3 (ITEM 0.2) — cancel signal aborts must not be classified
      // as retryable failures. Surface them as AbortError so the outer handler
      // marks the task cancelled and exits the retry loop immediately.
      if (isAbortError(err) || taskCancelSignal.aborted) {
        lastErr = err;
        break;
      }
      lastErr = err;
      // Aurora-parity Wave 2 — budget gates are TERMINAL: never retry them.
      // A BudgetExceededError / GlobalBudgetExceededError (from the pre-dispatch
      // guards or the opt-in cost-router enforce path) means "no headroom" —
      // retrying re-issues the same over-budget call and burns the recovery
      // budget. Classified naively it would land in `unknown` (retryable), so we
      // short-circuit to a terminal outcome before classifyError.
      if (err instanceof BudgetExceededError || err instanceof GlobalBudgetExceededError) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_budget_terminal',
          payload: {
            error: err.message,
            scope: err instanceof GlobalBudgetExceededError ? err.scope : 'workflow',
            attempt,
          },
        });
        break;
      }
      const classified = classifyError(err);
      lastClassified = classified;

      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_failover_classified',
        payload: {
          reason: classified.reason,
          retryable: classified.isRetryable,
          status: classified.status,
          attempt,
          model: task.model,
        },
      });

      // SAFE-01 — when personas are on (OMNIFORGE_USE_PERSONAS, default true),
      // run the persona failover classifier and apply its self-healing
      // mutations (model swap / prompt-prefix hardening / workspace-clean) to
      // the live task before the loop iterates. The legacy classifyError tree
      // above still drives control flow (compaction / rotation / fallback /
      // retryable vs terminal); the persona layers remediation on top. When
      // personas are off, the bare legacy path runs (no extra work).
      // Skip remediation for TRANSIENT infra failures (rate_limit / overloaded /
      // server_error / timeout / auth): the legacy path retries them as-is and
      // they gain nothing from a model swap / prompt-hardening / workspace clean.
      // Critically, running the persona classifier (an LLM call) on a TIMEOUT
      // would blow the time budget — a timed-out task must fail fast.
      const transientRetryReason =
        classified.reason === 'rate_limit' ||
        classified.reason === 'overloaded' ||
        classified.reason === 'server_error' ||
        classified.reason === 'timeout' ||
        classified.reason === 'auth';
      if (getUsePersonas() && !transientRetryReason) {
        await applyPersonaRemediation({ db, task, workflowId: wfId, workspace, err, attempt });
      }

      // Context overflow → compact and retry once (Bloco 1.1).
      if (classified.shouldCompress) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_needs_compaction',
          payload: { reason: classified.reason, model: task.model },
        });

        const engine = resolveContextEngine();
        const messages = buildMessagesFromTask(task);
        let compactResult;
        try {
          compactResult = await engine.compact({
            messages,
            force: true,
            model: task.model ?? undefined,
          });
        } catch {
          compactResult = { ok: false as const, compacted: false as const };
        }

        if (compactResult.ok && compactResult.compacted && compactResult.result) {
          insertEvent(db, {
            workflow_id: wfId,
            task_id: task.id,
            type: 'context_compacted',
            payload: {
              firstKeptEntryId: compactResult.result.firstKeptEntryId,
              tokensBefore: compactResult.result.tokensBefore,
              tokensAfter: compactResult.result.tokensAfter,
            },
          });
          const existingCtx = safeParseJson<Record<string, unknown>>(task.input_json, {
            db,
            workflowId: wfId,
            taskId: task.id,
            where: 'context_compaction_merge',
          }) ?? {};
          task.input_json = JSON.stringify({
            ...existingCtx,
            compacted_messages: compactResult.result.summary,
          });
          continue;
        }

        // Compaction failed — preserve original abort behavior
        break;
      }

      // Credential dead (auth_permanent, billing). Bloco 3 will wire
      // Omniroute credential-rotation; Tier 0 records the need.
      if (classified.shouldRotateCredential) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_credential_rotation_needed',
          payload: { reason: classified.reason, model: task.model },
        });
        break;
      }

      // Model absent on provider (model_not_found). Select a fallback model and
      // continue the retry loop with the new model when we still have attempts.
      if (classified.shouldFallback) {
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_fallback_model_needed',
          payload: { reason: classified.reason, model: task.model },
        });

        // Applies a resolved fallback model to the task + DB, emits the
        // selection event, and signals whether the loop should continue.
        const applyFallback = (
          fallbackModel: string,
          source: 'operator_chain' | 'best_combo',
          providerError: string | null,
        ): 'continue' | 'break' => {
          const previousModel = task.model;
          if (fallbackModel === previousModel) return 'break';
          task.model = fallbackModel;
          task.model_used = fallbackModel;
          try {
            db.prepare('UPDATE tasks SET model = ?, model_used = ? WHERE id = ?').run(
              fallbackModel,
              fallbackModel,
              task.id,
            );
          } catch {
            try {
              db.prepare('UPDATE tasks SET model = ? WHERE id = ?').run(fallbackModel, task.id);
            } catch { /* ignore legacy schemas */ }
          }
          insertEvent(db, {
            workflow_id: wfId,
            task_id: task.id,
            type: 'task_fallback_model_selected',
            payload: {
              previous_model: previousModel,
              fallback_model: fallbackModel,
              source,
              provider_error: providerError,
            },
          });
          return attempt < maxAttempts ? 'continue' : 'break';
        };

        // SAFE-02 — consult the operator-authored Setup → Fallback chain (or the
        // hardcoded per-role chain) BEFORE asking Omniroute for a best-combo.
        // A 1.0 operator who pins "Opus then Gemini" must see that honoured;
        // best-combo is only the last resort when the chain is exhausted/empty.
        // Fail-safe: any error here degrades to the doBestCombo path below.
        let operatorModel: string | undefined;
        try {
          const role = deriveFallbackRole(task);
          const next = selectFallbackModel(role, task.model ?? '');
          if (next && next !== task.model) operatorModel = next;
        } catch {
          // selectFallbackModel reads setup-config; on any failure fall through
          // to doBestCombo. (loadSetupFallbackChain already degrades internally.)
          operatorModel = undefined;
        }
        if (operatorModel) {
          if (applyFallback(operatorModel, 'operator_chain', null) === 'continue') continue;
          break;
        }

        // Chain exhausted/empty → fall back to Omniroute best-combo for the kind.
        const combo = await doBestCombo(task.kind, 'standard');
        if (combo.data?.model) {
          if (applyFallback(combo.data.model, 'best_combo', combo.error ?? null) === 'continue') {
            continue;
          }
        }
        break;
      }

      if (!classified.isRetryable) {
        break; // Fatal (format, other terminal reasons).
      }
      // else: retryable — loop iterates with classifier-driven backoff.
    }
  }

  return { output, lastErr, lastClassified, lastContextAttemptNumber };
}
