import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import { insertEvent } from '../../../db/persist.js';
import { safeParseJson } from '../../../utils/safe-parse-json.js';
import {
  formatTransitionPrefix,
  type TransitionContext,
} from '../../../v2/agents/transition-context.js';
import type { MaybeCompactResult } from '../../../v2/context-engine/compaction.js';

export function emitContextCompactionEvent(
  db: Database.Database,
  wfId: string,
  taskId: string,
  sourceStage: string,
  result: MaybeCompactResult,
): void {
  if (result.compactStats.stage === 'none') return;
  insertEvent(db, {
    workflow_id: wfId,
    task_id: taskId,
    type: 'context_compaction',
    payload: {
      workflow_id: wfId,
      task_id: taskId,
      stage: result.compactStats.stage,
      source_stage: sourceStage,
      chars_before: result.compactStats.charsBefore,
      chars_after: result.compactStats.charsAfter,
      archive_path: result.archivePath ?? null,
    },
  });
}

export function parseInputKeys(
  inputJson: string | null | undefined,
  db?: Database.Database,
  workflowId?: string,
  taskId?: string,
): string[] {
  const parsed = safeParseJson<unknown>(inputJson, {
    where: 'parse_input_keys',
    ...(taskId ? { taskId } : {}),
    ...(db ? { db } : {}),
    ...(workflowId ? { workflowId } : {}),
  });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.keys(parsed as Record<string, unknown>).sort();
}

export function contextAttempt(leaseAttempt: number, localAttempt: number): number {
  return leaseAttempt * 100 + localAttempt;
}

export function buildSafeTaskContextPacket(
  task: Task,
  wfId: string,
  attempt: number,
  leaseAttempt: number,
  effectiveTimeoutSec: number,
  transition?: TransitionContext,
): Record<string, unknown> {
  return {
    workflow_id: wfId,
    task: {
      id: task.id,
      name: task.name,
      kind: task.kind,
      model: task.model ?? null,
      model_used: task.model_used ?? null,
      model_route: task.model_route ?? null,
      executor_hint: task.executor_hint ?? null,
      tool_name: task.tool_name ?? null,
      retry_count: task.retry_count,
      timeout_seconds: task.timeout_seconds,
      effective_timeout_seconds: effectiveTimeoutSec,
      depends_on: task.depends_on,
    },
    attempt: {
      context_attempt: contextAttempt(leaseAttempt, attempt),
      lease_attempt: leaseAttempt,
      local_attempt: attempt,
    },
    input: {
      chars: task.input_json?.length ?? 0,
      keys: parseInputKeys(task.input_json),
    },
    transition: transition
      ? {
        origin_type: transition.origin_type,
        execution_number: transition.execution_number,
      }
      : null,
  };
}

export function applyLegacyTransitionPrefix(
  task: Task,
  transition: TransitionContext,
  db?: Database.Database,
  workflowId?: string,
): void {
  const prefix = formatTransitionPrefix(transition);
  const parseCtx = {
    where: 'apply_legacy_transition_prefix',
    taskId: task.id,
    ...(db ? { db } : {}),
    ...(workflowId ? { workflowId } : {}),
  };
  const ctx = safeParseJson<Record<string, unknown>>(task.input_json, parseCtx);
  if (ctx === null) {
    task.input_json = JSON.stringify({ objective: prefix });
    return;
  }
  const obj = typeof ctx['objective'] === 'string' ? ctx['objective'] : '';
  ctx['objective'] = obj ? `${prefix}\n${obj}` : prefix;
  task.input_json = JSON.stringify(ctx);
}
