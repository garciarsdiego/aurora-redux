/**
 * PRINT step executor.
 *
 * Renders task.print_template by replacing {state.key} and {state.key.nested}
 * placeholders with values from sharedState, then writes the result to
 * sharedState[task.output_key].
 *
 * Placeholder syntax: {state.<path>} where <path> supports dot-notation.
 * Missing paths are replaced with an empty string.
 */

import type { DagTask } from '../../../types/index.js';

/**
 * F-LIVE-18 — Try to parse a string as JSON when the template needs to
 * descend into it. `llm_call` task outputs are stored in sharedState as
 * raw strings (the model's response). When a print template references
 * `state.tX.field`, we need to parse tX's output to a real object on
 * the fly. Failure returns the original value so plain-string outputs
 * still render verbatim when the template only references `state.tX`.
 */
function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;

  // Direct JSON object/array.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to fence/code-block heuristics
    }
  }

  // Markdown-fenced JSON: ```json\n{...}\n``` or ```\n{...}\n``` — common
  // when llm_call output preserves the model's fence formatting.
  if (trimmed.startsWith('```')) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return value;
      }
    }
  }
  return value;
}

/** Resolve a dot-notation path against an object; returns undefined if not found.
 *  When traversal hits a string at an intermediate node, attempt to parse it
 *  as JSON so {state.tX.field} works even when tX's raw output is a JSON
 *  string from llm_call. */
function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (let i = 0; i < parts.length; i += 1) {
    if (current === null || current === undefined) return undefined;
    // If we still have remaining parts but `current` is a string, try to
    // parse it as JSON — sharedState[taskId] for llm_call outputs is the
    // model's raw text response, not a parsed object.
    if (typeof current === 'string') {
      const parsed = maybeParseJson(current);
      if (parsed === current) return undefined; // not JSON; can't descend
      current = parsed;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[parts[i]!];
  }
  return current;
}

/**
 * Replace all {state.<path>} occurrences in template with resolved values from
 * sharedState. Unknown paths become empty strings.
 */
function renderTemplate(template: string, sharedState: Record<string, unknown>): string {
  return template.replace(/\{state\.([^}]+)\}/g, (_match, path: string) => {
    const value = resolvePath(sharedState, path);
    if (value === undefined || value === null) {
      return '';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/**
 * Deterministic PRINT step: renders task.print_template and stores the result
 * at sharedState[task.output_key].
 */
export function executePrint(
  task: DagTask,
  sharedState: Record<string, unknown>,
): void {
  // F-LIVE-1 — accept fields either at the top level (canonical) or under
  // `args` (the shape the decomposer's LLMs produce most often, mirroring
  // how tool_call args are nested). Validator and EXAMPLE K both document
  // top-level placement, but the executor stays forgiving so we never
  // throw on the args-nested variant either.
  const args = (task as { args?: { print_template?: unknown; output_key?: unknown } }).args ?? {};
  const template =
    typeof task.print_template === 'string'
      ? task.print_template
      : typeof args.print_template === 'string'
        ? args.print_template
        : null;
  if (!template) {
    throw new Error('print: print_template is required (top-level field or under task.args.print_template)');
  }

  const outKey =
    typeof task.output_key === 'string'
      ? task.output_key
      : typeof args.output_key === 'string'
        ? args.output_key
        : null;
  if (!outKey) {
    throw new Error('print: output_key is required (top-level field or under task.args.output_key)');
  }

  sharedState[outKey] = renderTemplate(template, sharedState);
}
