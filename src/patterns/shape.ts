// Week 3 / Task 2.3 — objective shape normalizer.
//
// Reduces an objective string to a stable "shape" key used to recognize
// the same workflow request across superficially different runs (different
// client name, date, count). The shape is intentionally crude — a token
// hash of lowercased verbs + nouns with dates, numbers, URLs, and quoted
// proper nouns stripped. Anything more sophisticated (POS tagging,
// embeddings) is Phase 4 / OQ-4 territory.
//
// Examples:
//   "Audit Google Ads account for Acme, 30-day window"      → audit google ads account window
//   "Audit Google Ads account for Initech, 7-day window"  → audit google ads account window
//   "Refactor src/audio/ for low latency"                   → refactor src audio for latency

const PUNCT_RE = /[^\p{L}\p{N}\s]+/gu;
const NUMBER_RE = /\b\d+\b/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const URL_RE = /\bhttps?:\/\/\S+/g;
const QUOTED_RE = /["'`][^"'`]+["'`]/g;
const STOPWORDS = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'he', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'with', 'will',
  'this', 'these', 'those', 'i', 'we', 'they', 'them', 'their', 'our', 'my',
  'me', 'us', 'you', 'your', 'yours', 'do', 'does', 'did', 'into', 'over',
  'about', 'across', 'after', 'before', 'during', 'such', 'than', 'then',
  'today', 'tomorrow', 'yesterday', 'last', 'next', 'past', 'recent', 'last',
]);

// Param-introducer tokens: when the previous (case-preserved) word is one
// of these AND the current word starts with a capital, treat the current
// word as a parameter value (client name, project name) and drop it.
// Multi-capital sequences like "Google Ads" stay intact because they're
// not preceded by an introducer in the canonical examples.
const PARAM_INTRODUCERS = new Set<string>(['for', 'to', 'from', 'by', 'at', 'on']);

function dropParamValues(rawTokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawTokens.length; i += 1) {
    const token = rawTokens[i]!;
    const prevRaw = i > 0 ? rawTokens[i - 1]! : '';
    const prev = prevRaw.toLowerCase().replace(/[^a-z]/g, '');
    const startsCapital = /^[A-Z]/.test(token);
    if (startsCapital && PARAM_INTRODUCERS.has(prev) && token.length > 1) {
      // Drop the param value AND any immediately-following capitalized
      // tokens that form a multi-word entity ("Foo Corp", "Acme Inc").
      while (
        i + 1 < rawTokens.length &&
        /^[A-Z]/.test(rawTokens[i + 1]!) &&
        rawTokens[i + 1]!.length > 1
      ) {
        i += 1;
      }
      continue;
    }
    out.push(token);
  }
  return out;
}

/**
 * Returns a normalized objective shape (lowercased, stopword-stripped,
 * stable across superficial parameter variations). Returns the empty
 * string if normalization wipes out every token (avoid generating a
 * useless "*" key).
 */
export function objectiveShape(objective: string): string {
  if (!objective) return '';

  let work = objective
    .replace(URL_RE, '')
    .replace(DATE_RE, '')
    .replace(QUOTED_RE, '')
    .replace(NUMBER_RE, '');

  // Detect param values (capitalized words after "for"/"to"/"from"/…) BEFORE
  // we lowercase so the case signal is still available.
  const rawTokens = work.split(/\s+/).filter((t) => t.length > 0);
  const filteredRaw = dropParamValues(rawTokens);

  work = filteredRaw.join(' ').toLowerCase().replace(PUNCT_RE, ' ');
  const tokens = work
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  // De-dup while preserving order so the shape stays stable.
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    ordered.push(t);
  }
  return ordered.join(' ');
}
