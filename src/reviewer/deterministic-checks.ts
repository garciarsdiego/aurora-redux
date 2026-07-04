/**
 * Deterministic-first reviewer (OPP-R1).
 *
 * Parses common structural assertions out of free-form `acceptance_criteria`
 * and evaluates them in code BEFORE escalating to the LLM judge. This closes
 * the 61% REVIEWER-HARDFAIL rate observed in the 2026-05-23 harness eval where
 * the LLM judge was rejecting outputs that objectively met the criteria.
 *
 * Supported assertion phrasings (one per criteria line):
 *   - Output equals "X"                       → exact string equality
 *   - Output is exactly "X"                   → exact string equality
 *   - Output matches regex /pattern/flags     → RegExp test
 *   - Output is valid JSON                    → JSON.parse succeeds
 *   - Output is valid JSON with keys [a, b]   → JSON.parse + all keys present
 *   - Output has exactly N lines              → line count equality
 *   - Output has N lines                      → line count equality
 *   - Output length between A and B chars     → A ≤ len ≤ B
 *   - Output length is between A and B chars  → A ≤ len ≤ B
 *   - Output word count between A and B       → A ≤ words ≤ B
 *   - Output contains "X"                     → substring presence
 *   - Output contains [exactly] the line: X   → substring presence (unquoted)
 *   - Output does not contain "X"             → substring absence
 *   - Exit code 0                             → presence of "exit code 0" / non-error marker
 *
 * Phrasings are matched case-insensitively. If NO assertion is recognized,
 * `parseAssertions()` returns an empty array and the caller MUST fall back to
 * the LLM judge ("inconclusive" path).
 */

export type AssertionKind =
  | 'equals'
  | 'matches_regex'
  | 'is_json'
  | 'json_has_keys'
  | 'line_count'
  | 'length_between'
  | 'word_count_between'
  | 'contains'
  | 'not_contains'
  | 'exit_code_zero';

export interface Assertion {
  kind: AssertionKind;
  /** Original criteria line — useful for failure feedback. */
  source: string;
  value?: string;
  regex?: RegExp;
  keys?: string[];
  count?: number;
  min?: number;
  max?: number;
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail: string;
}

export interface DeterministicReviewResult {
  /** 'all_pass' | 'any_fail' | 'inconclusive' (no parseable assertions found). */
  verdict: 'all_pass' | 'any_fail' | 'inconclusive';
  assertions: Assertion[];
  results: AssertionResult[];
  /** Human-readable summary suitable for feedback. */
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────────────────────────────────────

const RE_EQUALS = /\boutput\s+(?:is\s+exactly|equals|is)\s+["“”'`](.+?)["“”'`]/i;
const RE_REGEX = /\boutput\s+matches\s+(?:regex\s+)?\/(.+?)\/([gimsuy]*)/i;
const RE_JSON_KEYS = /\boutput\s+is\s+valid\s+json\s+with\s+keys?\s+\[([^\]]+)\]/i;
const RE_JSON = /\boutput\s+is\s+(?:a\s+)?valid\s+json\b/i;
const RE_LINES_EXACT = /\boutput\s+has\s+(?:exactly\s+)?(\d+)\s+lines?\b/i;
const RE_LEN_BETWEEN = /\boutput\s+length\s+(?:is\s+)?between\s+(\d+)\s+and\s+(\d+)\s+(?:chars?|characters?)/i;
const RE_WORD_BETWEEN = /\boutput\s+word\s+count\s+(?:is\s+)?between\s+(\d+)\s+and\s+(\d+)\b/i;
const RE_NOT_CONTAINS = /\boutput\s+(?:does\s+not|doesn['’]t|must\s+not)\s+contain\s+["“”'`](.+?)["“”'`]/i;
const RE_CONTAINS = /\boutput\s+(?:must\s+)?contains?\s+["“”'`](.+?)["“”'`]/i;
// Opt 4 — unquoted "contains [exactly] the line: <text>" / "contains the
// text: <text>" / "contains the string: <text>" phrasing. Everything after
// the colon is treated as a substring (NOT whole-string-equals). The capture
// is trimmed before evaluation so trailing whitespace in the criteria line
// does not break the match.
const RE_CONTAINS_LINE = /\boutput\s+(?:must\s+)?contains?\s+(?:exactly\s+)?the\s+(?:line|text|string|phrase|substring|value)\s*:\s*(.+)$/i;
const RE_EXIT_ZERO = /\bexit\s+code\s+(?:is\s+|=\s*)?0\b/i;

function splitCriteria(criteria: string): string[] {
  // Split on newlines, semicolons, "and", or bullet markers. Each fragment is
  // probed independently. Short fragments (<8 chars) are dropped — they cannot
  // contain a structural assertion.
  return criteria
    .split(/\r?\n|;|^[\s-*•]+|(?<=\.)\s+(?=Output\b)/im)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

export function parseAssertions(criteria: string | null | undefined): Assertion[] {
  if (!criteria || typeof criteria !== 'string') return [];
  const fragments = splitCriteria(criteria);
  const out: Assertion[] = [];

  for (const frag of fragments) {
    let m: RegExpExecArray | null;

    if ((m = RE_EQUALS.exec(frag))) {
      out.push({ kind: 'equals', source: frag, value: m[1] });
      continue;
    }
    if ((m = RE_REGEX.exec(frag))) {
      try {
        out.push({ kind: 'matches_regex', source: frag, regex: new RegExp(m[1], m[2]) });
      } catch {
        // Invalid regex → treat as inconclusive (skip this assertion).
      }
      continue;
    }
    if ((m = RE_JSON_KEYS.exec(frag))) {
      const keys = m[1]
        .split(',')
        .map((k) => k.trim().replace(/^["“”'`]|["“”'`]$/g, ''))
        .filter((k) => k.length > 0);
      out.push({ kind: 'json_has_keys', source: frag, keys });
      continue;
    }
    if (RE_JSON.test(frag)) {
      out.push({ kind: 'is_json', source: frag });
      continue;
    }
    if ((m = RE_LINES_EXACT.exec(frag))) {
      out.push({ kind: 'line_count', source: frag, count: Number(m[1]) });
      continue;
    }
    if ((m = RE_LEN_BETWEEN.exec(frag))) {
      out.push({ kind: 'length_between', source: frag, min: Number(m[1]), max: Number(m[2]) });
      continue;
    }
    if ((m = RE_WORD_BETWEEN.exec(frag))) {
      out.push({ kind: 'word_count_between', source: frag, min: Number(m[1]), max: Number(m[2]) });
      continue;
    }
    if ((m = RE_NOT_CONTAINS.exec(frag))) {
      out.push({ kind: 'not_contains', source: frag, value: m[1] });
      continue;
    }
    // Opt 4 — unquoted "contains [exactly] the line: <text>" → substring check.
    // Strip optional surrounding quotes on the captured text so both quoted and
    // bare phrasings collapse to the same substring value.
    if ((m = RE_CONTAINS_LINE.exec(frag))) {
      const text = m[1].trim().replace(/^["“”'`]|["“”'`]$/g, '');
      if (text.length > 0) {
        out.push({ kind: 'contains', source: frag, value: text });
        continue;
      }
    }
    if ((m = RE_CONTAINS.exec(frag))) {
      out.push({ kind: 'contains', source: frag, value: m[1] });
      continue;
    }
    if (RE_EXIT_ZERO.test(frag)) {
      out.push({ kind: 'exit_code_zero', source: frag });
      continue;
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim();
  // Tolerate ```json fences.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function evaluateOne(assertion: Assertion, output: string): AssertionResult {
  switch (assertion.kind) {
    case 'equals': {
      const passed = output.trim() === (assertion.value ?? '').trim();
      return {
        assertion,
        passed,
        detail: passed
          ? `Output equals expected value.`
          : `Output (len=${output.trim().length}) does not equal expected "${assertion.value}".`,
      };
    }
    case 'matches_regex': {
      const passed = assertion.regex ? assertion.regex.test(output) : false;
      return {
        assertion,
        passed,
        detail: passed
          ? `Output matches /${assertion.regex?.source}/.`
          : `Output does not match /${assertion.regex?.source}/.`,
      };
    }
    case 'is_json': {
      const parsed = tryParseJson(output);
      const passed = parsed !== undefined;
      return {
        assertion,
        passed,
        detail: passed ? `Output parses as JSON.` : `Output is not valid JSON.`,
      };
    }
    case 'json_has_keys': {
      const parsed = tryParseJson(output);
      if (parsed === undefined || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { assertion, passed: false, detail: `Output is not a JSON object.` };
      }
      const keys = assertion.keys ?? [];
      const missing = keys.filter((k) => !(k in (parsed as Record<string, unknown>)));
      const passed = missing.length === 0;
      return {
        assertion,
        passed,
        detail: passed
          ? `Output JSON has all required keys [${keys.join(', ')}].`
          : `Output JSON missing keys: [${missing.join(', ')}].`,
      };
    }
    case 'line_count': {
      const lines = output.split(/\r?\n/).filter((l) => l.length > 0).length;
      const passed = lines === assertion.count;
      return {
        assertion,
        passed,
        detail: passed
          ? `Output has ${lines} lines (expected ${assertion.count}).`
          : `Output has ${lines} lines, expected ${assertion.count}.`,
      };
    }
    case 'length_between': {
      const len = output.length;
      const passed = len >= (assertion.min ?? 0) && len <= (assertion.max ?? Infinity);
      return {
        assertion,
        passed,
        detail: passed
          ? `Output length ${len} ∈ [${assertion.min}, ${assertion.max}].`
          : `Output length ${len} not in [${assertion.min}, ${assertion.max}].`,
      };
    }
    case 'word_count_between': {
      const words = output.trim().split(/\s+/).filter(Boolean).length;
      const passed = words >= (assertion.min ?? 0) && words <= (assertion.max ?? Infinity);
      return {
        assertion,
        passed,
        detail: passed
          ? `Output word count ${words} ∈ [${assertion.min}, ${assertion.max}].`
          : `Output word count ${words} not in [${assertion.min}, ${assertion.max}].`,
      };
    }
    case 'contains': {
      const passed = output.includes(assertion.value ?? '');
      return {
        assertion,
        passed,
        detail: passed
          ? `Output contains "${assertion.value}".`
          : `Output missing required substring "${assertion.value}".`,
      };
    }
    case 'not_contains': {
      const passed = !output.includes(assertion.value ?? '');
      return {
        assertion,
        passed,
        detail: passed
          ? `Output does not contain forbidden "${assertion.value}".`
          : `Output unexpectedly contains "${assertion.value}".`,
      };
    }
    case 'exit_code_zero': {
      // Heuristic: pass if output contains "exit code 0" or "exit 0", or if
      // the output is non-empty and does NOT contain obvious error markers.
      const lower = output.toLowerCase();
      const explicit = /\bexit\s+(?:code\s+)?0\b/.test(lower);
      const errMarkers = /\b(error|exception|traceback|exit\s+(?:code\s+)?[1-9])\b/.test(lower);
      const passed = explicit || (output.trim().length > 0 && !errMarkers);
      return {
        assertion,
        passed,
        detail: passed ? `No non-zero exit indicators detected.` : `Output contains error/non-zero exit markers.`,
      };
    }
  }
}

export function evaluateDeterministic(
  criteria: string | null | undefined,
  output: string,
): DeterministicReviewResult {
  const assertions = parseAssertions(criteria);
  if (assertions.length === 0) {
    return {
      verdict: 'inconclusive',
      assertions: [],
      results: [],
      summary: 'No deterministic assertions parsed from acceptance_criteria — escalating to LLM judge.',
    };
  }

  const results = assertions.map((a) => evaluateOne(a, output));
  const allPass = results.every((r) => r.passed);
  const summary = results
    .map((r) => `[${r.passed ? 'PASS' : 'FAIL'}] ${r.detail}`)
    .join('\n');

  return {
    verdict: allPass ? 'all_pass' : 'any_fail',
    assertions,
    results,
    summary,
  };
}
