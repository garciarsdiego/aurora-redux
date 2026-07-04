import vm from 'node:vm';

/** Same ceiling used by deterministic transform/if_else-style eval. */
export const VM_EVAL_TIMEOUT_MS = 5000;

/**
 * Deep-clone state for sandbox evaluation so user code cannot mutate live sharedState.
 */
export function cloneStateForEval(state: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(state) as Record<string, unknown>;
  } catch {
    return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  }
}

function baseSandbox(bindings: Record<string, unknown>): Record<string, unknown> {
  const o = Object.create(null) as Record<string, unknown>;
  o.Math = Math;
  o.JSON = JSON;
  o.Array = Array;
  o.Object = Object;
  o.String = String;
  o.Number = Number;
  o.Boolean = Boolean;
  o.abs = Math.abs;
  o.round = Math.round;
  o.max = Math.max;
  o.min = Math.min;
  o.Date = Date;
  o.parseInt = parseInt;
  o.parseFloat = parseFloat;
  o.int = (v: unknown) => parseInt(String(v), 10);
  o.float = (v: unknown) => parseFloat(String(v));
  o.str = String;
  o.bool = Boolean;
  o.list = Array.from;
  o.dict = Object;
  o.any = (arr: unknown) => Array.isArray(arr) && arr.some(Boolean);
  o.all = (arr: unknown) => Array.isArray(arr) && arr.every(Boolean);
  o.len = (v: unknown) => (
    Array.isArray(v) || typeof v === 'string'
      ? v.length
      : v && typeof v === 'object'
        ? Object.keys(v).length
        : null
  );
  o.isNaN = isNaN;
  o.isFinite = isFinite;
  Object.assign(o, bindings);
  return o;
}

function proxyStateValue(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value ?? null;
  }

  return new Proxy(value as Record<string | symbol, unknown>, {
    get(target, prop, receiver) {
      if (prop === Symbol.toStringTag) return Reflect.get(target, prop, receiver);
      const next = Reflect.get(target, prop, receiver);
      return proxyStateValue(next);
    },
  });
}

export function createSafeStateBinding(state: Record<string, unknown>): Record<string, unknown> {
  return proxyStateValue(cloneStateForEval(state)) as Record<string, unknown>;
}

/**
 * Evaluate a JS expression or IIFE-style snippet in a fresh context with only
 * safe builtins + provided bindings. No require/process/globalThis leaks.
 * Used by transform and (planned) if_else condition eval.
 */
export function runExpressionInNewContext(
  expressionSource: string,
  bindings: Record<string, unknown>,
  timeoutMs: number = VM_EVAL_TIMEOUT_MS,
): unknown {
  const sandbox = baseSandbox(bindings);
  return vm.runInNewContext(expressionSource, sandbox, {
    timeout: timeoutMs,
    displayErrors: true,
    contextCodeGeneration: { strings: false, wasm: false },
  });
}

/**
 * DET-06 — soft-fail observability sink. When a ReferenceError / TypeError is
 * swallowed (returning null) the evaluator notifies this callback BEFORE
 * returning so the silent coercion is enumerable. Callers that have a DB /
 * event channel (if_else.ts) pass `onSoftFail` so a `vm_eval_soft_fail` event
 * is recorded; callers without one (switch.ts) simply omit it and keep the
 * legacy fail-safe behaviour. The callback is invoked fail-safe — a throw from
 * it never breaks evaluation.
 */
export interface VmEvalSoftFailInfo {
  expression: string;
  errorName: string;
  error: string;
}

export function evaluateStateExpression(
  expression: string,
  sharedState: Record<string, unknown>,
  timeoutMs: number = VM_EVAL_TIMEOUT_MS,
  onSoftFail?: (info: VmEvalSoftFailInfo) => void,
): unknown {
  const trimmed = expression.trim();
  if (!trimmed) return null;

  try {
    return runExpressionInNewContext(
      `(${trimmed})`,
      { state: createSafeStateBinding(sharedState) },
      timeoutMs,
    );
  } catch (err) {
    const name = typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name: unknown }).name)
      : '';
    if (name === 'ReferenceError' || name === 'TypeError') {
      // DET-06: surface the soft-fail (silent null coercion) before returning.
      if (onSoftFail) {
        try {
          onSoftFail({
            expression: trimmed,
            errorName: name,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch { /* observability sink must not break evaluation */ }
      }
      return null;
    }
    throw err;
  }
}

export function evaluateConditionExpression(
  expression: string,
  sharedState: Record<string, unknown>,
  timeoutMs: number = VM_EVAL_TIMEOUT_MS,
  onSoftFail?: (info: VmEvalSoftFailInfo) => void,
): boolean {
  return Boolean(evaluateStateExpression(expression, sharedState, timeoutMs, onSoftFail));
}
