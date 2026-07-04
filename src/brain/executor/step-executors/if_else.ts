/**
 * IF_ELSE step executor.
 *
 * Evaluates task.if_condition against sharedState using Node's `vm` module
 * with a restricted sandbox — no eval(), no Function(), no access to globals.
 * Dot-notation paths in the expression (e.g. state.user.age) resolve via a
 * simple recursive getter so authors don't need to import lodash.
 *
 * Returns the id of the next step to run and which branch was taken.
 * Also emits an { type: 'if_decision' } event for observability.
 */

import type { Task } from '../../../types/index.js';
import { evaluateConditionExpression } from './safe-vm-eval.js';

export interface IfElseCtx {
  workflowId: string;
  emitEvent?: (payload: Record<string, unknown>) => void;
}

export interface IfElseResult {
  next_step_id: string | null;
  decision: 'true' | 'false';
}

export async function executeIfElse(
  task: Task & {
    if_condition?: string;
    if_true_step_id?: string;
    if_false_step_id?: string;
  },
  sharedState: Record<string, unknown>,
  ctx: IfElseCtx,
): Promise<IfElseResult> {
  const condition = task.if_condition ?? 'false';

  let rawDecision: boolean;
  try {
    rawDecision = evaluateConditionExpression(condition, sharedState, undefined, (info) => {
      // DET-06: a ReferenceError/TypeError was swallowed to null inside the
      // sandbox (e.g. condition references an undefined state key). Surface it
      // so the false-routing is not silent. Fail-safe.
      try {
        ctx.emitEvent?.({
          type: 'vm_eval_soft_fail',
          task_id: task.id,
          condition: info.expression,
          error_name: info.errorName,
          error: info.error,
        });
      } catch { /* observability failure must not break routing */ }
    });
  } catch (err) {
    // Treat eval errors as falsy rather than crashing the workflow — but emit
    // an observability event BEFORE defaulting so a malformed/unsafe condition
    // is enumerable instead of silently routing the false branch (BRAIN-05).
    // The event itself must never break routing, so it is wrapped fail-safe.
    try {
      ctx.emitEvent?.({
        type: 'if_condition_eval_error',
        task_id: task.id,
        condition,
        error: err instanceof Error ? err.message : String(err),
        defaulted_decision: 'false',
      });
    } catch { /* observability failure must not break routing */ }
    rawDecision = false;
  }

  const decision: 'true' | 'false' = rawDecision ? 'true' : 'false';
  const target_step_id = decision === 'true'
    ? (task.if_true_step_id ?? null)
    : (task.if_false_step_id ?? null);

  ctx.emitEvent?.({
    type: 'if_decision',
    task_id: task.id,
    decision,
    target_step_id,
  });

  return { next_step_id: target_step_id, decision };
}
