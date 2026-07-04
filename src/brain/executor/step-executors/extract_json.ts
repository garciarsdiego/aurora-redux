/**
 * EXTRACT_JSON step executor.
 *
 * Reads a string value from sharedState[task.input_keys[0]], parses all JSON
 * objects/arrays found in it, and writes the result to sharedState[task.output_key].
 *
 * Supported input formats:
 *   - Plain JSON: `{"key":"value"}` or `[1,2,3]`
 *   - Fenced code block: ```json\n{...}\n```
 *   - Multiple top-level objects (returns array of parsed values)
 */

import type { DagTask } from '../../../types/index.js';

/** Extract all JSON-like substrings from raw text. */
function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];

  // Strip fenced ```json ... ``` blocks first
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  const fenceMatches: string[] = [];
  while ((match = fenceRegex.exec(raw)) !== null) {
    fenceMatches.push(match[1].trim());
  }
  if (fenceMatches.length > 0) {
    return fenceMatches;
  }

  // Otherwise look for {...} or [...] spans
  const spanRegex = /([{[][^]*?[}\]])/g;
  while ((match = spanRegex.exec(raw)) !== null) {
    candidates.push(match[1].trim());
  }

  return candidates.length > 0 ? candidates : [raw.trim()];
}

/**
 * Parse JSON from a raw string. Returns a single parsed value or an array of
 * parsed values if multiple JSON objects are found.
 */
function parseJsonFromString(raw: string): unknown {
  const candidates = extractJsonCandidates(raw);

  const parsed: unknown[] = [];
  for (const candidate of candidates) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      // skip unparseable candidates
    }
  }

  if (parsed.length === 0) {
    throw new Error(`extract_json: no valid JSON found in input`);
  }

  return parsed.length === 1 ? parsed[0] : parsed;
}

/**
 * Deterministic EXTRACT_JSON step: reads sharedState[task.input_keys[0]],
 * parses JSON from it, and stores the result at sharedState[task.output_key].
 */
export function executeExtractJson(
  task: DagTask,
  sharedState: Record<string, unknown>,
): void {
  const inputKey = task.input_keys?.[0];
  if (!inputKey) {
    throw new Error('extract_json: input_keys[0] is required');
  }

  const outKey = task.output_key;
  if (!outKey) {
    throw new Error('extract_json: output_key is required');
  }

  const raw = sharedState[inputKey];
  if (raw === undefined || raw === null) {
    throw new Error(`extract_json: sharedState["${inputKey}"] is undefined`);
  }

  const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
  sharedState[outKey] = parseJsonFromString(rawStr);
}
