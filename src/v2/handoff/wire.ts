/**
 * Wire — connects parsed handoff sections from upstream tasks into the carry
 * block consumed by the next task's prompt.
 *
 * Flow:
 *   parent_task.output_json (raw text or JSON) ──┐
 *                                                │  extractHandoffFromOutput()
 *                                                ▼
 *                                          ParsedHandoff (5 sections)
 *                                                │  formatCarryBlock(parent.name, …)
 *                                                ▼
 *                                          "### parent_name\n#### Summary\n…"
 *                                                │  buildCarryFromUpstream()
 *                                                ▼
 *                            single carry text injected as input_json.carry_from_upstream
 *
 * The legacy executor (cli.ts / omniroute.ts) surfaces carry_from_upstream
 * into the worker prompt right after upstream_artifacts. The persona path
 * (runner.ts) sets ctx.carry to the same value so persona prompts can
 * interpolate `${ctx.carry}`.
 *
 * Why this module is thin: the heavy lifting is already in `extract.ts`
 * (parse 5 sections from text) and `carry.ts` (cap + truncate per section).
 * `wire.ts` is the adapter layer between the executor and those primitives.
 */

import { extractHandoffSections } from './extract.js';
import { formatCarryBlock } from './carry.js';
import type { ParsedHandoff } from './types.js';

/** Hard cap for the entire carry block (sum of all parents). */
export const DEFAULT_MAX_CARRY_CHARS = 4000;

/**
 * Cap allocated to a SINGLE parent within a multi-parent join.
 * If 4 parents share the budget, each gets MAX/4 (≈1000 chars).
 */
export const MIN_PER_PARENT_CARRY_CHARS = 600;

/**
 * Try to coerce an upstream task's output_json into a ParsedHandoff.
 *
 * Three shapes supported, in priority order:
 *   1. JSON object with `parsed_handoff: ParsedHandoff` (persona-path workers
 *      emit this — see worker_cli_spawn.ts and worker_llm_call.ts).
 *   2. JSON object that LOOKS LIKE a ParsedHandoff itself (Summary/Actions/
 *      Artifacts/Risks/Next keys).
 *   3. Raw text — fall through to extractHandoffSections() heading scanner.
 *
 * Returns null when the output is empty or has no parseable sections AND no
 * Summary (extractHandoffSections's fallback). Callers should treat null as
 * "no carry from this parent" and skip it.
 */
export function extractHandoffFromOutput(output: string | null): ParsedHandoff | null {
  if (!output || output.trim().length === 0) return null;

  // Try JSON shapes first
  const trimmed = output.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;

      // Shape 1: { parsed_handoff: ParsedHandoff, ... }
      const ph = parsed['parsed_handoff'];
      if (ph && typeof ph === 'object') {
        return normaliseHandoff(ph as Record<string, unknown>);
      }

      // Shape 2: object IS a ParsedHandoff
      if (looksLikeHandoff(parsed)) {
        return normaliseHandoff(parsed);
      }

      // Other JSON shapes — fall through to text extraction on the original
    } catch {
      // not JSON, fall through
    }
  }

  // Shape 3: raw text → scan headings
  const extracted = extractHandoffSections(output);

  // If no headings AND empty Summary, there's nothing to carry
  if (!extracted.sawHeading && extracted.Summary.trim().length === 0) {
    return null;
  }

  return extracted;
}

function looksLikeHandoff(obj: Record<string, unknown>): boolean {
  // Heuristic: has at least 2 of the 5 named section keys
  const keys = ['Summary', 'Actions', 'Artifacts', 'Risks', 'Next'];
  let hits = 0;
  for (const k of keys) {
    if (typeof obj[k] === 'string') hits++;
    if (hits >= 2) return true;
  }
  return false;
}

function normaliseHandoff(obj: Record<string, unknown>): ParsedHandoff {
  const str = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');
  return {
    Summary: str('Summary'),
    Actions: str('Actions'),
    Artifacts: str('Artifacts'),
    Risks: str('Risks'),
    Next: str('Next'),
    sawHeading: true,
  };
}

export interface CarrySource {
  parentTaskId: string;
  parentName: string;
  chars: number;
  truncated: boolean;
  truncatedSections: string[];
}

export interface CarryBuildResult {
  /** The full carry block text ready to inject into a worker prompt. Empty string if no parent had usable handoff. */
  text: string;
  /** Per-parent metadata for observability. Empty array when text is empty. */
  sources: CarrySource[];
  /** Total chars in `text`. */
  totalChars: number;
}

/**
 * Build a carry block from an ordered list of completed parent tasks.
 *
 * The total character budget (`maxChars`) is split across parents that yield
 * non-empty handoffs. Each parent gets at least MIN_PER_PARENT_CARRY_CHARS
 * to avoid sub-meaningful blocks; if the budget can't satisfy the floor, the
 * later parents fall off (LIFO — older parents preserved).
 *
 * Returns `{ text: '', sources: [], totalChars: 0 }` when no parent has
 * carryable content. Callers can short-circuit on empty text.
 */
export function buildCarryFromUpstream(
  parents: ReadonlyArray<{ id: string; name: string; output_json: string | null }>,
  maxChars: number = DEFAULT_MAX_CARRY_CHARS,
): CarryBuildResult {
  if (parents.length === 0 || maxChars <= 0) {
    return { text: '', sources: [], totalChars: 0 };
  }

  // Pre-extract handoffs so we know how many parents actually contribute
  type Candidate = { parent: typeof parents[number]; handoff: ParsedHandoff };
  const candidates: Candidate[] = [];
  for (const p of parents) {
    const h = extractHandoffFromOutput(p.output_json);
    if (h) candidates.push({ parent: p, handoff: h });
  }

  if (candidates.length === 0) {
    return { text: '', sources: [], totalChars: 0 };
  }

  // Allocate per-parent budget. Honour the floor; drop later parents if needed.
  const perParentBudget = Math.floor(maxChars / candidates.length);
  let activeCount = candidates.length;
  if (perParentBudget < MIN_PER_PARENT_CARRY_CHARS) {
    activeCount = Math.max(1, Math.floor(maxChars / MIN_PER_PARENT_CARRY_CHARS));
  }
  const active = candidates.slice(0, activeCount);
  const budget = Math.max(MIN_PER_PARENT_CARRY_CHARS, Math.floor(maxChars / active.length));

  const blocks: string[] = [];
  const sources: CarrySource[] = [];

  for (const { parent, handoff } of active) {
    const formatted = formatCarryBlock(parent.name, handoff, budget);
    blocks.push(formatted.text);
    sources.push({
      parentTaskId: parent.id,
      parentName: parent.name,
      chars: formatted.text.length,
      truncated: formatted.truncated,
      truncatedSections: formatted.truncatedSections,
    });
  }

  const text = blocks.join('\n\n');
  return { text, sources, totalChars: text.length };
}
