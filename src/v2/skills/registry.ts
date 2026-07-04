import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillDefinition } from './types.js';
import { parseSkillContent } from './parser.js';

export const CAPTURE_THRESHOLD = 3;

const skills = new Map<string, SkillDefinition>();
const winCounts = new Map<string, number>();

export function registerSkill(skill: SkillDefinition): void {
  skills.set(skill.name, skill);
}

export function resolveSkill(name: string): SkillDefinition | undefined {
  return skills.get(name);
}

export function listSkills(): SkillDefinition[] {
  return [...skills.values()];
}

export function recordWin(name: string): void {
  winCounts.set(name, (winCounts.get(name) ?? 0) + 1);
}

export function getWinCount(name: string): number {
  return winCounts.get(name) ?? 0;
}

export function isCaptured(name: string): boolean {
  return getWinCount(name) >= CAPTURE_THRESHOLD;
}

export function listCapturedSkills(): SkillDefinition[] {
  return [...skills.values()].filter((s) => isCaptured(s.name));
}

export function _resetRegistry(): void {
  skills.clear();
  winCounts.clear();
}

/**
 * Scan `dir` for `<dir>/<name>/SKILL.md` files and register each as a
 * SkillDefinition. Idempotent — re-running overwrites existing entries
 * with the latest disk version. Silently skips when `dir` does not exist
 * (e.g., fresh checkout without hermes/skills/).
 *
 * Wire-up of FASE 1B Bloco A.3 — without this loader the parser and
 * apply-to-dag helper had no consumer (R-HIGH-2 from Opus review of A.2/A.3).
 */
export function loadSkillsFromDir(dir: string): SkillDefinition[] {
  if (!existsSync(dir)) return [];

  const loaded: SkillDefinition[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    if (!statSync(skillPath).isFile()) continue;

    try {
      const content = readFileSync(skillPath, 'utf-8');
      const def = parseSkillContent(content, skillPath);
      registerSkill(def);
      loaded.push(def);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Loud failure — bad SKILL.md is operator error, not a runtime branch
      // we should silently swallow.
      process.stderr.write(
        `[skills/registry] failed to load ${skillPath}: ${message}\n`,
      );
    }
  }

  return loaded;
}
