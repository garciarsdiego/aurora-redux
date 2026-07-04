/**
 * Skills preflight pipeline — discovery, validation, and permission resolution.
 *
 * Orchestra steal #4: before a workflow runs, verify every required skill is
 * present, structurally valid, and permitted by the caller's permission map.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSkillDefinition } from './validate.js';
import { parseSkillContent } from './parser.js';

// PermissionAction mirrors src/v2/agents/permissions.ts (created by t5).
// Redefined here so preflight is self-contained and compilable even when
// permissions.ts hasn't landed yet.
export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface SkillDescriptor {
  name: string;
  source?: 'workspace' | 'global';
  path?: string;
  status: 'ok' | 'missing' | 'invalid' | 'deny' | 'ask' | 'disabled';
  permission?: PermissionAction;
  description?: string;
  errors?: string[];
}

export interface SkillPreflightResult {
  ok: boolean;
  skills: SkillDescriptor[];
  errors: string[];
}

export interface SkillsPreflightInput {
  /** Names of skills that must be present for the workflow to proceed. */
  skillsRequired: string[];
  /** Root directory of the workspace (skills live under <workspaceDir>/skills/<name>/SKILL.md). */
  workspaceDir: string;
  /** Optional per-skill permission overrides: skill name → action.  '*' = default for all. */
  permissionMap?: Record<string, PermissionAction>;
  /** When false the preflight result is purely informational (ok always true). Default true. */
  toolEnabled?: boolean;
}

/**
 * Run the full preflight pipeline for the given skill names:
 *  1. Discover each skill on disk (workspace-local first)
 *  2. Validate frontmatter
 *  3. Resolve permission from permissionMap
 *  4. Populate SkillDescriptor per skill
 *
 * Returns ok=false when any skill is missing, invalid, or denied.
 */
export async function runSkillsPreflight(
  input: SkillsPreflightInput,
): Promise<SkillPreflightResult> {
  const { skillsRequired, workspaceDir, permissionMap = {}, toolEnabled = true } = input;

  const descriptors: SkillDescriptor[] = [];
  const errors: string[] = [];

  for (const skillName of skillsRequired) {
    const descriptor = await resolveSkill(skillName, workspaceDir, permissionMap);
    descriptors.push(descriptor);

    if (descriptor.status !== 'ok') {
      errors.push(buildErrorMessage(descriptor));
    }
  }

  const blocking = descriptors.filter(
    (d) => d.status === 'missing' || d.status === 'invalid' || d.status === 'deny',
  );

  const ok = toolEnabled ? blocking.length === 0 : true;

  return { ok, skills: descriptors, errors };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function resolveSkill(
  name: string,
  workspaceDir: string,
  permissionMap: Record<string, PermissionAction>,
): Promise<SkillDescriptor> {
  const permission = resolvePermission(name, permissionMap);

  // Deny short-circuits discovery
  if (permission === 'deny') {
    return { name, status: 'deny', permission, errors: [`Skill '${name}' is denied by permission map`] };
  }

  const found = discoverSkillPath(name, workspaceDir);
  if (!found) {
    return { name, status: 'missing', permission, errors: [`Skill '${name}' not found in workspace`] };
  }

  const { path, source } = found;
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, source, path, status: 'invalid', permission, errors: [`Cannot read skill file: ${msg}`] };
  }

  const validation = validateSkillDefinition(content);
  if (!validation.valid) {
    return { name, source, path, status: 'invalid', permission, errors: validation.errors };
  }

  // Parse to extract description
  let description: string | undefined;
  try {
    const def = parseSkillContent(content, path);
    description = def.description || undefined;
  } catch {
    // Non-fatal — description is optional in the descriptor
  }

  const status = permission === 'ask' ? 'ask' : 'ok';
  return { name, source, path, status, permission, description };
}

/** Look for <workspaceDir>/skills/<name>/SKILL.md */
function discoverSkillPath(
  name: string,
  workspaceDir: string,
): { path: string; source: 'workspace' | 'global' } | null {
  const candidates: Array<{ path: string; source: 'workspace' | 'global' }> = [
    { path: join(workspaceDir, 'skills', name, 'SKILL.md'), source: 'workspace' },
    { path: join(workspaceDir, '..', 'skills', name, 'SKILL.md'), source: 'global' },
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}

function resolvePermission(
  name: string,
  map: Record<string, PermissionAction>,
): PermissionAction {
  if (name in map) return map[name]!;
  if ('*' in map) return map['*']!;
  return 'allow';
}

function buildErrorMessage(d: SkillDescriptor): string {
  const base = `Skill '${d.name}': ${d.status}`;
  if (d.errors && d.errors.length > 0) return `${base} — ${d.errors[0]}`;
  return base;
}
