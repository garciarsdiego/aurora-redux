import type Database from 'better-sqlite3';

import type { RuntimeProtocolTier, RuntimeStreamFormat } from './capabilities.js';
import { runtimeError, type RuntimeRunEvent } from './events.js';
import {
  appendRuntimeStreamEvent,
  completeRuntimeTurn,
  createRuntimeSession,
  startRuntimeTurn,
  type RuntimeSessionRow,
  type RuntimeTurnRow,
} from './store.js';

export interface RuntimeTurnRequest {
  workflowId?: string | null;
  taskId?: string | null;
  executorId: string;
  protocolTier: RuntimeProtocolTier;
  streamFormat: RuntimeStreamFormat;
  runtimeMode?: 'oneshot' | 'persistent' | 'auto';
  nativeSessionId?: string | null;
  workspacePath?: string | null;
  fallbackReason?: string | null;
  attempt?: number;
  promptSummary?: string | null;
  runMode?: 'dry-run' | 'approved-run';
  approvalStatus?: 'not_required' | 'pending' | 'approved' | 'denied';
  auditStatus?: 'not_required' | 'pending' | 'recorded' | 'failed';
  metadata?: Record<string, unknown>;
}

export interface RuntimeTurnContext {
  session: RuntimeSessionRow;
  turn: RuntimeTurnRow;
  emit: (event: RuntimeRunEvent) => void;
}

export class RuntimeManager {
  constructor(private readonly db: Database.Database) {}

  async runTurn(
    request: RuntimeTurnRequest,
    adapter: (context: RuntimeTurnContext) => Promise<string>,
  ): Promise<string> {
    const runtimeMode = request.runtimeMode ?? 'oneshot';
    const session = createRuntimeSession(this.db, {
      workflowId: request.workflowId,
      taskId: request.taskId,
      executorId: request.executorId,
      protocolTier: request.protocolTier,
      streamFormat: request.streamFormat,
      nativeSessionId: request.nativeSessionId,
      runtimeMode,
      workspacePath: request.workspacePath,
      fallbackReason: request.fallbackReason,
      approvalStatus: request.approvalStatus,
      auditStatus: request.auditStatus,
      runMode: request.runMode ?? 'dry-run',
      metadata: request.metadata,
    });
    const turn = startRuntimeTurn(this.db, {
      sessionId: session.id,
      workflowId: request.workflowId,
      taskId: request.taskId,
      attempt: request.attempt,
      promptSummary: request.promptSummary,
      metadata: request.metadata,
    });
    const emit = (event: RuntimeRunEvent): void => {
      appendRuntimeStreamEvent(this.db, {
        sessionId: session.id,
        turnId: turn.id,
        workflowId: request.workflowId,
        taskId: request.taskId,
        event,
      });
    };

    emit({
      type: 'runtime.turn.started',
      ts: Date.now(),
      executorId: request.executorId,
      sessionId: session.id,
      turnId: turn.id,
      raw: {
        protocolTier: request.protocolTier,
        streamFormat: request.streamFormat,
        runtimeMode,
        fallbackReason: request.fallbackReason ?? null,
      },
    });

    try {
      const result = await adapter({ session, turn, emit });
      const resultSummary = result.slice(0, 500);
      emit({
        type: 'runtime.result',
        ts: Date.now(),
        executorId: request.executorId,
        sessionId: session.id,
        turnId: turn.id,
        text: resultSummary,
        result: { chars: result.length },
      });
      completeRuntimeTurn(this.db, turn.id, {
        status: 'completed',
        resultSummary,
      });
      return result;
    } catch (err) {
      const errorEvent = runtimeError(
        request.executorId,
        'runtime_turn_failed',
        err instanceof Error ? err.message : String(err),
        'Inspect runtime stream events and fall back to oneshot if the adapter failed.',
        { workflowId: request.workflowId, taskId: request.taskId },
      );
      emit({ ...errorEvent, sessionId: session.id, turnId: turn.id });
      completeRuntimeTurn(this.db, turn.id, {
        status: 'failed',
        error: errorEvent.error ?? null,
      });
      throw err;
    }
  }
}
