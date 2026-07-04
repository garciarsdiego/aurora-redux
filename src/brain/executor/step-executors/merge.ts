import type { DagTask } from '../../../types/index.js';

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepMerge(left: JsonObject, right: JsonObject): JsonObject {
  const result: JsonObject = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const existing = result[key];
    result[key] = isPlainObject(existing) && isPlainObject(value)
      ? deepMerge(existing, value)
      : value;
  }

  return result;
}

function stringifyForConcat(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Deterministic merge step: combines branch outputs from sharedState and writes
 * the merged value to sharedState[task.output_key].
 */
export function executeMerge(
  task: DagTask,
  sharedState: Record<string, unknown>,
): void {
  const outKey = task.output_key;
  if (!outKey) {
    throw new Error('merge: output_key is required');
  }

  const branchKeys = task.merge_branch_outputs ?? [];
  if (branchKeys.length === 0) {
    throw new Error('merge: merge_branch_outputs must contain at least one key');
  }

  const strategy = task.merge_strategy ?? 'list';
  const values = branchKeys.map((key) => sharedState[key]);

  if (strategy === 'list') {
    sharedState[outKey] = values.flatMap((value) => Array.isArray(value) ? value : [value]);
    return;
  }

  if (strategy === 'concat') {
    sharedState[outKey] = values.map(stringifyForConcat).join('\n\n');
    return;
  }

  if (strategy === 'dict') {
    sharedState[outKey] = values.reduce<JsonObject>((acc, value, index) => {
      if (!isPlainObject(value)) {
        throw new Error(`merge: dict strategy requires plain object at merge_branch_outputs[${index}]`);
      }
      return deepMerge(acc, value);
    }, {});
    return;
  }

  throw new Error(`merge: unsupported merge_strategy "${String(strategy)}"`);
}
