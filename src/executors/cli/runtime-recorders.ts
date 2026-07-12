// =============================================================================
// runtime-recorders.ts — shared appendRuntime/completeRuntime closures.
//
// runCliTask (cli/index.ts) and runOpencodeViaAcp (opencode-acp.ts) both need
// the same pair of best-effort runtime-store recorders: append a stream event
// to the current turn, and complete the turn with an optional structured
// error. The two copies had already started to drift only in error metadata
// (error.code / suggestedAction / safeContext) — this factory keeps the
// completeRuntimeTurn shape single-sourced so future changes cannot diverge.
//
// The session/turn ids are not known at construction time (they are assigned
// after createRuntimeSession/startRuntimeTurn succeed), so callers pass a
// mutable `ids` holder and stamp `ids.sessionId` / `ids.turnId` once known.
// Until then both recorders are silent no-ops — same as the previous inline
// closures guarding on the null locals.
// =============================================================================

import type { Task } from '../../types/index.js';
import type { SpanContext } from '../../v2/observability/tracing.js';
import type { RuntimeRunEvent } from '../../runtime/events.js';
import { appendRuntimeStreamEvent, completeRuntimeTurn } from '../../runtime/store.js';

export interface RuntimeRecorderIds {
  sessionId: string | null;
  turnId: string | null;
}

export interface RuntimeRecorders {
  appendRuntime: (event: RuntimeRunEvent) => void;
  completeRuntime: (
    status: 'completed' | 'failed' | 'canceled',
    resultSummary?: string | null,
    errorMessage?: string,
  ) => void;
}

export function createRuntimeRecorders(input: {
  spanCtx: SpanContext | undefined;
  task: Task;
  runtimeExecutorId: string;
  ids: RuntimeRecorderIds;
  /** Error code stamped on failed/canceled turns (e.g. 'cli_spawn_failed'). */
  errorCode: string;
  /** Operator-facing next step recorded alongside the error. */
  suggestedAction: string;
  /** Extra safeContext fields merged over { executorId, model }. */
  safeContextExtras?: Record<string, unknown>;
}): RuntimeRecorders {
  const { spanCtx, task, runtimeExecutorId, ids } = input;

  const appendRuntime = (event: RuntimeRunEvent): void => {
    if (!spanCtx || !ids.sessionId || !ids.turnId) return;
    try {
      appendRuntimeStreamEvent(spanCtx.db, {
        sessionId: ids.sessionId,
        turnId: ids.turnId,
        workflowId: task.workflow_id,
        taskId: task.id,
        event: {
          ...event,
          executorId: event.executorId || runtimeExecutorId,
          sessionId: event.sessionId ?? ids.sessionId,
          turnId: event.turnId ?? ids.turnId,
        },
      });
    } catch {
      // Runtime recording is observability only; never break CLI execution.
    }
  };

  const completeRuntime = (
    status: 'completed' | 'failed' | 'canceled',
    resultSummary?: string | null,
    errorMessage?: string,
  ): void => {
    if (!spanCtx || !ids.turnId) return;
    try {
      completeRuntimeTurn(spanCtx.db, ids.turnId, {
        status,
        resultSummary,
        error: errorMessage
          ? {
            code: input.errorCode,
            origin: `task:${task.id}`,
            message: errorMessage,
            suggestedAction: input.suggestedAction,
            safeContext: {
              executorId: runtimeExecutorId,
              model: task.model ?? null,
              ...(input.safeContextExtras ?? {}),
            },
          }
          : null,
      });
    } catch {
      // Runtime recording is best-effort.
    }
  };

  return { appendRuntime, completeRuntime };
}
