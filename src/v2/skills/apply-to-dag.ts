import type { Dag } from '../../types/index.js';
import type { SkillDefinition } from './types.js';
import { listSkills } from './registry.js';
import { matchSkills } from './matcher.js';

/**
 * When patternMatcher selects a skill, propagate that skill's execution_mode
 * to every task in the resulting DAG. Tasks that already declare an explicit
 * execution_mode (e.g. decomposer override) win over the skill default.
 *
 * Returns a NEW Dag — does not mutate input (immutability per coding-style).
 */
export function applySkillExecutionMode(dag: Dag, skill: SkillDefinition): Dag {
  return {
    ...dag,
    tasks: dag.tasks.map((t) => ({
      ...t,
      execution_mode: t.execution_mode ?? skill.execution_mode,
    })),
  };
}

export interface BestMatchResult {
  dag: Dag;
  matchedSkill?: SkillDefinition;
  matchScore?: number;
}

/**
 * Wire-up helper for FASE 1B Bloco A.3 (R-HIGH-2 from Opus review): given a
 * DAG and an objective, find the highest-scoring registered skill (above
 * `minScore`) and apply its `execution_mode` to every task that doesn't
 * already declare one. Returns the original DAG unchanged when no skills
 * are registered or none score above the threshold.
 *
 * `minScore` defaults to 3 — three matched tokens between objective and
 * skill (name + description + trigger_when + examples). Conservative; tune
 * once dogfood reveals false positives or misses.
 */
export function applyBestSkillExecutionMode(
  dag: Dag,
  objective: string,
  options?: { minScore?: number },
): BestMatchResult {
  const minScore = options?.minScore ?? 3;
  const skills = listSkills();
  if (skills.length === 0) return { dag };

  const matches = matchSkills(objective, skills);
  if (matches.length === 0) return { dag };
  const best = matches[0]!;
  if (best.score < minScore) return { dag };

  return {
    dag: applySkillExecutionMode(dag, best.skill),
    matchedSkill: best.skill,
    matchScore: best.score,
  };
}
