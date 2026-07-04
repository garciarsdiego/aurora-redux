/**
 * Slash-command parsing and slug normalization.
 * Ported from editorial-console `src/lib/skills.js` (`normalizeSlashCommand`, `parseSkillSlashCommand`),
 * split into `normalizeSlug`, `parseSlashCommand`, and `matchSkill` (pure, no I/O, no module state).
 */

/** Minimal skill shape for slash routing (name / optional slashCommand / enabled). */
export interface SlashCommandSkill {
  name: string;
  slashCommand?: string;
  enabled?: boolean;
}

export interface SlashCommandResult {
  /** Raw command token from the message (no leading `/`). Empty when not a slash command. */
  slug: string;
  /** Text after the command; full trimmed input when not a slash command. */
  message: string;
  /** `normalizeSlug(slug)` when `found`; otherwise `""`. */
  normalize: string;
  /** True when input matches `/command` with optional trailing text (regex-shaped slash message). */
  found: boolean;
}

/**
 * Skill resolved from a slash token via `matchSkill`.
 * Use this name when importing next to fuzzy matching types from `./types.ts`.
 */
export interface SlashSkillMatch {
  skill: SlashCommandSkill;
}

/**
 * Slash-resolution match payload. Distinct from fuzzy `SkillMatch` in `./types.ts` (score / matchedTokens).
 */
export type SkillMatch = SlashSkillMatch;

export function normalizeSlug(value = ''): string {
  return String(value ?? '')
    .trim()
    .replace(/^\/+/u, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseSlashCommand(message: string): SlashCommandResult {
  const trimmed = String(message ?? '').trim();
  const m = trimmed.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/u);
  if (!m) {
    return { slug: '', message: trimmed, normalize: '', found: false };
  }
  const slug = m[1] ?? '';
  const rest = String(m[2] ?? '').trim();
  return {
    slug,
    message: rest,
    normalize: normalizeSlug(slug),
    found: true,
  };
}

export function matchSkill(slug: string, skills: ReadonlyArray<SlashCommandSkill>): SlashSkillMatch | null {
  const command = normalizeSlug(slug);
  const skill = skills.find((item) => {
    if (item == null || item.enabled === false) return false;
    const bySlash = normalizeSlug(item.slashCommand ?? item.name);
    const byName = normalizeSlug(item.name);
    return bySlash === command || byName === command;
  });
  return skill != null ? { skill } : null;
}
