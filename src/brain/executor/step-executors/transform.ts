import type { DagTask } from '../../../types/index.js';
import {
  VM_EVAL_TIMEOUT_MS,
  cloneStateForEval,
  runExpressionInNewContext,
} from './safe-vm-eval.js';

const MAX_TRANSFORM_CODE_CHARS = 2000;

/** True if `code` begins with a single arrow-function value (not `x =>` inside a chain). */
function isTopLevelArrowFunction(code: string): boolean {
  return /^\s*(?:\([^)]*\)|[a-zA-Z_$][\w$]*)\s*=>/.test(code);
}

/**
 * Compile + run transform_code against a snapshot of sharedState.
 * Accepts either:
 * - Expression using `state`: `state.items.filter(i => i.active).length`
 * - Arrow function: `state => state.items.filter(i => i.active).length`
 */
export function evalTransformCode(code: string, stateSnapshot: Record<string, unknown>): unknown {
  const trimmed = code.trim();
  const isArrow = isTopLevelArrowFunction(trimmed);
  const expressionSource = isArrow
    ? `(${trimmed})(__state__)`
    : `(function(state){'use strict';return(${trimmed});})(__state__)`;

  return runExpressionInNewContext(
    expressionSource,
    { __state__: stateSnapshot },
    VM_EVAL_TIMEOUT_MS,
  );
}

/**
 * Deterministic transform step: runs sandboxed JS against sharedState and stores the
 * result at sharedState[task.output_key].
 */
export function executeTransform(
  task: DagTask,
  sharedState: Record<string, unknown>,
): void {
  const code = task.transform_code?.trim();
  if (!code) {
    throw new Error('transform: transform_code is required');
  }
  if (code.length > MAX_TRANSFORM_CODE_CHARS) {
    throw new Error(
      `transform: transform_code exceeds ${MAX_TRANSFORM_CODE_CHARS} characters`,
    );
  }
  const outKey = task.output_key;
  if (!outKey) {
    throw new Error('transform: output_key is required');
  }

  const snapshot = cloneStateForEval(sharedState);
  const result = evalTransformCode(code, snapshot);
  sharedState[outKey] = result;
}
