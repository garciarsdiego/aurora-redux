import type { SkillDefinition, SkillMatch } from './types.js';

const TOKEN_SPLIT_RE = /[\s,;.!?()[\]{}"'`/\\|<>=+*&^%$#@~\-:]+/;

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(TOKEN_SPLIT_RE)
      .filter((t) => t.length >= 2),
  );
}

function buildSkillTokens(skill: SkillDefinition): Set<string> {
  const corpus = [skill.name, skill.description, ...skill.trigger_when, ...skill.examples].join(' ');
  return tokenize(corpus);
}

export function matchSkills(prompt: string, skills: SkillDefinition[]): SkillMatch[] {
  const promptTokens = tokenize(prompt);
  const results: SkillMatch[] = [];

  for (const skill of skills) {
    const sTokens = buildSkillTokens(skill);
    const matched: string[] = [];
    for (const t of promptTokens) {
      if (sTokens.has(t)) matched.push(t);
    }
    if (matched.length > 0) {
      results.push({ skill, score: matched.length, matchedTokens: matched });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
