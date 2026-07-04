import { load as yamlLoad } from 'js-yaml';
import type { SkillDefinition } from './types.js';
import { ExecutionModeSchema } from '../../types/schemas.js';
import type { ExecutionMode } from '../../types/index.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return [value];
  return [];
}

export function parseSkillContent(content: string, filePath?: string): SkillDefinition {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error(`No YAML frontmatter found${filePath ? ` in: ${filePath}` : ''}`);
  }

  const raw = yamlLoad(match[1]) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid frontmatter YAML${filePath ? ` in: ${filePath}` : ''}`);
  }

  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  if (!name) {
    throw new Error(`Skill missing required field 'name'${filePath ? ` in: ${filePath}` : ''}`);
  }

  const description = typeof raw['description'] === 'string' ? raw['description'] : '';
  const trigger_when = toStringArray(raw['trigger_when']);
  const examples = toStringArray(raw['examples']);

  let execution_mode: ExecutionMode = 'ephemeral';
  const rawExecMode = raw['execution_mode'];
  if (rawExecMode !== undefined) {
    if (typeof rawExecMode !== 'string') {
      throw new Error(
        `Skill '${name}' execution_mode must be a string, got ${typeof rawExecMode}` +
          `${filePath ? ` in: ${filePath}` : ''}`,
      );
    }
    const parsed = ExecutionModeSchema.safeParse(rawExecMode);
    if (!parsed.success) {
      throw new Error(
        `Skill '${name}' has invalid execution_mode '${rawExecMode}'` +
          ` (must be 'ephemeral' or 'adaptive')${filePath ? ` in: ${filePath}` : ''}`,
      );
    }
    execution_mode = parsed.data;
  }

  return { name, description, trigger_when, examples, execution_mode, ...(filePath !== undefined ? { filePath } : {}) };
}
