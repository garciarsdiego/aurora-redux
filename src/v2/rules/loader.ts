import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface ProjectRules {
  raw: string;
  hash: string;
  path: string;
  loaded_at: number;
}

interface CacheEntry {
  mtime: number;
  rules: ProjectRules;
}

const cache = new Map<string, CacheEntry>();

export async function loadProjectRules(workspaceRoot: string): Promise<ProjectRules | null> {
  const rulesPath = join(workspaceRoot, 'RULES.md');

  let mtime: number;
  try {
    const s = await stat(rulesPath);
    mtime = s.mtimeMs;
  } catch {
    return null;
  }

  const cacheKey = workspaceRoot;
  const cached = cache.get(cacheKey);
  if (cached && cached.mtime === mtime) {
    return cached.rules;
  }

  const raw = await readFile(rulesPath, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const rules: ProjectRules = { raw, hash, path: rulesPath, loaded_at: Date.now() };
  cache.set(cacheKey, { mtime, rules });
  return rules;
}

export function formatRulesForPrompt(
  rules: ProjectRules | null,
  scope: 'decomposer' | 'reviewer',
): string {
  if (!rules) return '';
  const prefix =
    scope === 'decomposer'
      ? 'PROJECT RULES (binding for DAG decisions):'
      : 'PROJECT RULES (apply as additional acceptance criteria):';
  return `\n\n${prefix}\n${rules.raw}`;
}
