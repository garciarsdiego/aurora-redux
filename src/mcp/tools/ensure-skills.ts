/**
 * FASE 1B Bloco A.3 wire-up — load SKILL.md files from disk once per process
 * so the skill matcher has a corpus to choose from. Shared by run_workflow.ts
 * and plan_workflow.ts (single flag per process). Idempotent.
 */

import { loadSkillsFromDir } from '../../v2/skills/registry.js';

let _skillsLoaded = false;

export function ensureSkillsLoaded(): void {
  if (_skillsLoaded) return;
  const dir = process.env.OMNIFORGE_SKILLS_DIR ?? 'hermes/skills';
  loadSkillsFromDir(dir);
  _skillsLoaded = true;
}
