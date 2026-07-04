import type { ExecutionMode } from '../../types/index.js';

export interface SkillDefinition {
  name: string;
  description: string;
  trigger_when: string[];
  examples: string[];
  filePath?: string;
  // FASE 1B Bloco A.3 — opt into adaptive execution mode.
  // Defaults to 'ephemeral' when frontmatter omits the key.
  execution_mode: ExecutionMode; // REQUIRED so callers don't need ?? everywhere
}

export interface SkillMatch {
  skill: SkillDefinition;
  score: number;
  matchedTokens: string[];
}
