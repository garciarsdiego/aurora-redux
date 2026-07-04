import type { Pattern } from '../types/index.js';
import { callOmniroute } from '../utils/omniroute-call.js';
import { getDecomposerModel } from '../utils/config.js';

export type MatchResult =
  | { action: 'use'; pattern: Pattern }
  | { action: 'new' };

const SYSTEM_PROMPT = `You are Omniforge's pattern matcher. Given a new OBJECTIVE and a list of existing PATTERNS (each with a name and a sample objective it was built for), decide whether one of the patterns is suitable for the new objective or a brand-new DAG should be generated.

Return STRICT JSON only. No prose, no markdown fences. Exactly one of:
  { "decision": "use:<pattern-name>" }
  { "decision": "new" }

Rules:
- Choose "use:<name>" ONLY when the pattern's purpose clearly matches the new objective (same domain, same type of deliverable).
- Choose "new" when no pattern is a strong match, or when you are uncertain.
- Never invent a pattern name that is not in the list.
- Output MUST be parseable JSON with a single "decision" key. Nothing else.`;

function buildUserPrompt(objective: string, patterns: Pattern[]): string {
  const list = patterns
    .map((p) => `- name: "${p.name}" | sample: "${p.objective_sample}"`)
    .join('\n');
  return `OBJECTIVE: ${objective}\n\nPATTERNS:\n${list}`;
}

function parseDecision(raw: string, patterns: Pattern[]): MatchResult {
  const jsonText = raw
    .trim()
    .replace(/^```[a-zA-Z]*\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.warn('[pattern-matcher] LLM returned malformed JSON — fallback: new');
    return { action: 'new' };
  }

  const decision = (parsed as { decision?: unknown }).decision;
  if (typeof decision !== 'string') {
    console.warn('[pattern-matcher] Missing "decision" field — fallback: new');
    return { action: 'new' };
  }

  if (decision === 'new') {
    return { action: 'new' };
  }

  if (decision.startsWith('use:')) {
    const name = decision.slice(4);
    const pattern = patterns.find((p) => p.name === name);
    if (!pattern) {
      console.warn(`[pattern-matcher] Unknown pattern name "${name}" — fallback: new`);
      return { action: 'new' };
    }
    return { action: 'use', pattern };
  }

  console.warn(`[pattern-matcher] Unexpected decision value "${decision}" — fallback: new`);
  return { action: 'new' };
}

export async function matchPattern(
  objective: string,
  patterns: Pattern[],
): Promise<MatchResult> {
  if (patterns.length === 0) {
    return { action: 'new' };
  }

  const raw = await callOmniroute({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(objective, patterns),
    model: getDecomposerModel(),
    temperature: 0,
  });

  return parseDecision(raw, patterns);
}

/** Exposed for unit tests — skips the Omniroute call. */
export { parseDecision as _parseDecision };
