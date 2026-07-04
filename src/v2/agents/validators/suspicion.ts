/**
 * Suspicion-pattern scoring for the Reviewer agent's pre-LLM short-circuit.
 *
 * The Reviewer's expensive LLM call is skipped when (a) suspicion patterns add
 * up past a threshold AND (b) the worker did not call any write tool. The
 * regression we are guarding against is "described without writing": the
 * worker's response lists files that "already exist" without any Write/Edit
 * trace. We catch it cheap before paying for a critic round-trip.
 */

export interface SuspicionPattern {
  /** Pretty id used in evidence output and metrics labels. */
  id: string;
  /** Regex applied to the worker's narrative output. */
  regex: RegExp;
  /**
   * Weight added to the suspicion score when the regex matches. Sums above 1.0
   * (combined with absent write-tool trace) trigger an automatic fail.
   */
  weight: number;
  /** Operator-friendly explanation included in reviewer feedback. */
  reason: string;
}

/**
 * Patterns extracted from real failed runs in the 2026-05-04 sessions.
 * Tune carefully — false positives cause `reviewer.over_strict` and slow the
 * cluster; false negatives let the loop-without-progress bug recur.
 */
export const SUSPICION_PATTERNS: readonly SuspicionPattern[] = [
  {
    id: 'both_files_exist',
    regex: /\bboth files (?:already )?exist\b/i,
    weight: 0.7,
    reason: 'Worker claims files exist without listing line counts or specific exports.',
  },
  {
    id: 'no_changes_needed',
    regex: /\bno (?:further )?changes? (?:are )?needed\b/i,
    weight: 0.6,
    reason: 'Worker claims nothing to do without proving acceptance is met.',
  },
  {
    id: 'satisfy_all_acceptance',
    regex: /\bsatisf(?:y|ies|ying) all acceptance criteria\b/i,
    weight: 0.5,
    reason: 'Worker asserts complete satisfaction without per-criterion evidence.',
  },
  {
    id: 'looks_correct',
    regex: /\b(?:looks?|appears?) correct\b/i,
    weight: 0.4,
    reason: 'Hand-wavy assessment — needs verifiable evidence.',
  },
  {
    id: 'implementation_appears',
    regex: /\bimplementation (?:appears|seems)\b/i,
    weight: 0.5,
    reason: 'Soft-language self-assessment substitutes for hard verification.',
  },
  {
    id: 'already_implemented',
    regex: /\b(?:is|was|already) (?:fully )?implemented\b/i,
    weight: 0.5,
    reason: 'Claim of completion without trace of implementation.',
  },
  {
    id: 'no_action_required',
    regex: /\bno (?:action|further work|implementation) (?:required|necessary)\b/i,
    weight: 0.6,
    reason: 'Worker concludes early — usually a sign of described-not-written failure mode.',
  },
];

export interface SuspicionScore {
  total: number;
  matches: { id: string; reason: string; weight: number }[];
}

/** Compute suspicion score for a worker's narrative output. */
export function calculateSuspicion(text: string, patterns: readonly SuspicionPattern[] = SUSPICION_PATTERNS): SuspicionScore {
  const matches: SuspicionScore['matches'] = [];
  let total = 0;
  for (const p of patterns) {
    if (p.regex.test(text)) {
      matches.push({ id: p.id, reason: p.reason, weight: p.weight });
      total += p.weight;
    }
  }
  return { total, matches };
}

/** Default threshold above which suspicion + missing-write triggers auto-fail. */
export const SUSPICION_AUTO_FAIL_THRESHOLD = 1.0;
