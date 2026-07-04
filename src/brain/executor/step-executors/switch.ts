import type { DagTask } from '../../../types/index.js';
import { evaluateStateExpression } from './safe-vm-eval.js';

export interface SwitchCtx {
  emitEvent?: (payload: SwitchDecisionEvent) => void | Promise<void>;
}

export interface SwitchDecisionEvent {
  type: 'switch_decision';
  task_id: string;
  matched_case: string | null;
  target_step_id: string | null;
}

export interface SwitchResult {
  next_step_id: string | null;
  matched_case: string | null;
}

export async function executeSwitch(
  task: DagTask,
  sharedState: Record<string, unknown>,
  ctx: SwitchCtx = {},
): Promise<SwitchResult> {
  const expression = task.switch_expression;
  if (!expression) {
    throw new Error('switch: switch_expression is required');
  }

  const cases = task.switch_cases ?? {};
  const rawValue = evaluateStateExpression(expression, sharedState);
  const caseKey = String(rawValue);
  const matched_case = Object.prototype.hasOwnProperty.call(cases, caseKey)
    ? caseKey
    : null;
  const target_step_id = matched_case === null
    ? (task.switch_default_step_id ?? null)
    : (cases[matched_case] ?? null);

  await ctx.emitEvent?.({
    type: 'switch_decision',
    task_id: task.id,
    matched_case,
    target_step_id,
  });

  return { next_step_id: target_step_id, matched_case };
}
