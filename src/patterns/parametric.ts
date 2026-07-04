// Week 3 / Task 2.4 — parametric slot detection v0.
//
// Given two or more objective strings that all share the same
// `objectiveShape`, find positions where the surface text differs and
// emit a single template with named `{slotN}` placeholders.
//
// v0 strategy (no NLP, no embeddings — string-token alignment only):
//   1. Pick the first objective as the reference. Tokenize on whitespace.
//   2. For each token position, compare across all objectives.
//   3. Positions where every objective agrees → literal in the template.
//   4. Positions where they differ → emit `{slotN}` and remember the
//      sample values.
//   5. Heuristic slot names: if the preceding literal is `for`/`to`/etc.,
//      reuse it (`{for}` → renamed `{client}` after a final pass when the
//      semantics are obvious). Default falls back to `{param1}`, `{param2}`…
//
// The output is consumed by `auto-capture.ts` when minting a new pattern
// and by `patternMatcher.ts` to bind values at decompose time.

export interface SlotDetectionResult {
  /** Template with placeholders, e.g. `"Audit Google Ads account for {client}, {param2}-day window"`. */
  template: string;
  /** Names of the slots in left-to-right order. */
  slots: string[];
  /** Sample values per slot (parallel arrays, one per input objective). */
  samples: Record<string, string[]>;
}

const PARAM_INTRODUCER_NAMES: Record<string, string> = {
  for: 'client',
  to: 'target',
  from: 'source',
  by: 'author',
  at: 'location',
  on: 'date',
};

function tokenize(input: string): string[] {
  // Split into word tokens and whitespace tokens; keep both so the template
  // can faithfully reassemble the surface text (spaces, commas preserved).
  return input.split(/(\s+)/).filter((s) => s.length > 0);
}

function isWhitespaceToken(t: string): boolean {
  return /^\s+$/.test(t);
}

function stripTrailingPunct(token: string): string {
  return token.replace(/[,;:.!?]+$/, '');
}

function namedSlot(introducer: string | undefined, sampleA: string, sampleB: string, taken: Set<string>): string {
  // 1. Try the introducer-based name (for→client, on→date, …).
  if (introducer) {
    const cleaned = introducer.toLowerCase().replace(/[^a-z]/g, '');
    const named = PARAM_INTRODUCER_NAMES[cleaned];
    if (named && !taken.has(named)) return named;
  }
  // 2. If both samples look like dates, name it 'date'.
  if (/^\d{4}-\d{2}-\d{2}$/.test(sampleA) && /^\d{4}-\d{2}-\d{2}$/.test(sampleB) && !taken.has('date')) {
    return 'date';
  }
  // 3. If both samples are pure digits, name it 'count'.
  if (/^\d+$/.test(stripTrailingPunct(sampleA)) && /^\d+$/.test(stripTrailingPunct(sampleB)) && !taken.has('count')) {
    return 'count';
  }
  return '';
}

/**
 * Detect slots across an array of objectives that share a normalized shape.
 *
 * Returns null when the inputs don't all share the same token count after
 * whitespace tokenization — surface alignment requires same-length token
 * arrays. Future work (Phase 4) could relax this with a Levenshtein-style
 * alignment.
 */
export function detectSlots(objectives: ReadonlyArray<string>): SlotDetectionResult | null {
  if (objectives.length < 2) return null;
  const tokenized = objectives.map(tokenize);
  const refLen = tokenized[0]!.length;
  if (!tokenized.every((t) => t.length === refLen)) return null;

  const template: string[] = [];
  const slotNames: string[] = [];
  const samples: Record<string, string[]> = {};
  const takenNames = new Set<string>();
  let paramCounter = 1;

  for (let pos = 0; pos < refLen; pos += 1) {
    const tokensAtPos = tokenized.map((t) => t[pos]!);
    const allSame = tokensAtPos.every((tok) => tok === tokensAtPos[0]);

    if (allSame) {
      template.push(tokensAtPos[0]!);
      continue;
    }

    // Whitespace tokens that differ across inputs (different amount of
    // spacing) shouldn't become slots — collapse to a single space.
    if (tokensAtPos.every(isWhitespaceToken)) {
      template.push(' ');
      continue;
    }

    // Find a name for this slot. Look back through the template for the
    // closest non-whitespace token to use as the introducer signal.
    let introducer: string | undefined;
    for (let look = template.length - 1; look >= 0; look -= 1) {
      const t = template[look]!;
      if (!isWhitespaceToken(t)) {
        introducer = stripTrailingPunct(t);
        break;
      }
    }
    const name =
      namedSlot(introducer, tokensAtPos[0]!, tokensAtPos[1]!, takenNames) ||
      `param${paramCounter++}`;
    takenNames.add(name);
    slotNames.push(name);
    samples[name] = tokensAtPos.map((tok) => stripTrailingPunct(tok));
    template.push(`{${name}}`);
  }

  return {
    template: template.join(''),
    slots: slotNames,
    samples,
  };
}

/**
 * Substitute placeholder values back into a template. Unknown slot names
 * are left intact so the caller can detect missing bindings.
 */
export function bindSlots(template: string, bindings: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name) => {
    return name in bindings ? bindings[name]! : `{${name}}`;
  });
}
