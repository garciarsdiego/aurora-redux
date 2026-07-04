/**
 * System-prompt rendering for AgentPersona.
 *
 * Personas declare a `systemPromptTemplate` (a string with `${PLACEHOLDER}`
 * tokens) plus immutable identity/mission/rules. This module renders the final
 * prompt by composing those pieces with the per-invocation input.
 *
 * Token interpolation rules:
 *   - `${IDENTITY_VERBATIM}` → persona.identity
 *   - `${MISSION_VERBATIM}`  → persona.mission
 *   - `${HARD_RULES_NUMBERED}` → numbered list of persona.hardRules + universal
 *   - `${FORBIDDEN_NUMBERED}`  → numbered list of persona.forbidden
 *   - `${AMBIGUITY_TABLE}`     → markdown table of ambiguity protocol
 *   - `${INPUT.field}`         → JSON-stringify of input.field (deep)
 *   - `${INPUT.field|join,}`   → input.field joined by `,` (for arrays of strings)
 *   - `${INPUT.field|json}`    → JSON-stringify with 2-space indent (default)
 *   - Any unmatched `${...}`   → left as-is and logged via console.warn (test
 *                                 assertions will fail loud — easier to debug).
 *
 * Why a tiny custom renderer instead of Handlebars?
 *   - We render exactly one template per persona. No partials, no helpers.
 *   - Zero runtime deps keeps the agents tree pure.
 *   - The placeholder grammar is bounded and easy to audit during code review.
 */

import { UNIVERSAL_HARD_RULES, type AgentPersona, type UniversalRuleId } from '../types.js';

const TOKEN_RE = /\$\{([A-Z_]+(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\|[a-z]+(?:,.*)?)?)\}/g;

export function renderSystemPrompt<I, O>(
  persona: AgentPersona<I, O>,
  input: I,
): string {
  const ctx = buildContext(persona, input);
  return persona.systemPromptTemplate.replace(TOKEN_RE, (match, token: string) => {
    const value = resolveToken(token, ctx);
    if (value === undefined) {
      // Optional INPUT.x fields gracefully render as `(none)` instead of leaking
      // the literal `${INPUT.x}` into the prompt — the LLM does not need to see
      // our template syntax. Non-INPUT unresolved tokens are still warnings,
      // since they imply the persona's template references a missing constant.
      if (token.startsWith('INPUT.')) return '(none)';
      // eslint-disable-next-line no-console
      console.warn(`[agent-prompt] Unresolved token in ${persona.id} template: ${match}`);
      return match;
    }
    return value;
  });
}

interface RenderContext<I> {
  IDENTITY_VERBATIM: string;
  MISSION_VERBATIM: string;
  HARD_RULES_NUMBERED: string;
  FORBIDDEN_NUMBERED: string;
  AMBIGUITY_TABLE: string;
  INPUT: I;
}

function buildContext<I, O>(persona: AgentPersona<I, O>, input: I): RenderContext<I> {
  const optOut = new Set<UniversalRuleId>(persona.optOutUniversalRules ?? []);
  const universal = UNIVERSAL_HARD_RULES.filter((rule) => !optOut.has(rule.id)).map((r) => r.text);
  const allHard = [...universal, ...persona.hardRules];
  return {
    IDENTITY_VERBATIM: persona.identity,
    MISSION_VERBATIM: persona.mission,
    HARD_RULES_NUMBERED: numbered(allHard),
    FORBIDDEN_NUMBERED: numbered(persona.forbidden as readonly string[]),
    AMBIGUITY_TABLE: renderAmbiguity(persona.ambiguityProtocol),
    INPUT: input,
  };
}

function numbered(items: readonly string[]): string {
  if (items.length === 0) return '(none)';
  return items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
}

function renderAmbiguity(rules: AgentPersona<unknown, unknown>['ambiguityProtocol']): string {
  if (rules.length === 0) return '(no specific cases)';
  const header = '| Condition | Resolution | Escalate? |\n|---|---|---|';
  const rows = rules.map(
    (r) => `| ${escapeCell(r.condition)} | ${escapeCell(r.resolution)} | ${r.escalate ? '**Yes**' : 'No'} |`,
  );
  return [header, ...rows].join('\n');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function resolveToken<I>(token: string, ctx: RenderContext<I>): string | undefined {
  // Strip optional formatter suffix.
  const [path, formatter] = token.split('|', 2) as [string, string | undefined];
  const segments = path.split('.');

  // Top-level constants.
  if (segments.length === 1) {
    const v = (ctx as unknown as Record<string, unknown>)[segments[0]];
    return v === undefined ? undefined : applyFormatter(v, formatter);
  }

  // INPUT.something.nested
  if (segments[0] === 'INPUT') {
    let cur: unknown = ctx.INPUT;
    for (const seg of segments.slice(1)) {
      if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return undefined;
      }
    }
    return applyFormatter(cur, formatter);
  }

  return undefined;
}

function applyFormatter(value: unknown, formatter: string | undefined): string {
  if (formatter === undefined) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }

  if (formatter.startsWith('join')) {
    // Everything after the literal "join" is treated as the separator. Examples:
    //   join     → ","
    //   join,    → ","   (trailing comma is the separator)
    //   join, .  → ", "  (comma + space is the separator)
    //   join | . → " | " (pipes/spaces fine)
    const rest = formatter.slice(4);
    const sep = rest.length > 0 ? rest : ',';
    if (Array.isArray(value)) return value.join(sep);
    return String(value);
  }

  if (formatter === 'json') return JSON.stringify(value, null, 2);
  if (formatter === 'jsonline') return JSON.stringify(value);
  if (formatter === 'string') return typeof value === 'string' ? value : String(value);

  return String(value);
}
