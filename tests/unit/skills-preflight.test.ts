/**
 * Skills preflight pipeline tests — t6 criteria: >=4 cases covering:
 *  1. All skills present and valid → ok=true
 *  2. One skill missing → ok=false, status='missing'
 *  3. Invalid frontmatter → ok=false, status='invalid'
 *  4. Permission='deny' → ok=false, status='deny'
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach } from 'vitest';

import { runSkillsPreflight } from '../../src/v2/skills/preflight.js';
import { validateSkillDefinition } from '../../src/v2/skills/validate.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'preflight-test-'));
}

function createSkill(workspaceDir: string, name: string, content: string): void {
  const skillDir = join(workspaceDir, 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content, 'utf-8');
}

const VALID_SKILL_CONTENT = `---
name: my-skill
description: A test skill for unit tests
trigger_when:
  - test
examples: []
---

# My Skill

This is the body of the skill.
`;

const INVALID_FRONTMATTER_CONTENT = `---
trigger_when:
  - test
---

Missing name and description.
`;

// ─── validateSkillDefinition ─────────────────────────────────────────────────

describe('validateSkillDefinition', () => {
  it('accepts valid frontmatter with name and description', () => {
    const result = validateSkillDefinition(VALID_SKILL_CONTENT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects content missing name field', () => {
    const content = `---\ndescription: no name here\n---\nbody`;
    const result = validateSkillDefinition(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('rejects content missing description field', () => {
    const content = `---\nname: my-skill\n---\nbody`;
    const result = validateSkillDefinition(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('rejects content with script tags', () => {
    const content = `---\nname: evil\ndescription: bad\n---\n<script>alert(1)</script>`;
    const result = validateSkillDefinition(content);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('script'))).toBe(true);
  });

  it('rejects content with no frontmatter at all', () => {
    const result = validateSkillDefinition('just plain text, no yaml');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('frontmatter'))).toBe(true);
  });
});

// ─── runSkillsPreflight ───────────────────────────────────────────────────────

describe('runSkillsPreflight', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = makeWorkspace();
  });

  it('case 1: all skills present and valid → ok=true', async () => {
    createSkill(workspaceDir, 'skill-a', VALID_SKILL_CONTENT);
    createSkill(workspaceDir, 'skill-b', VALID_SKILL_CONTENT.replace('my-skill', 'skill-b'));

    const result = await runSkillsPreflight({
      skillsRequired: ['skill-a', 'skill-b'],
      workspaceDir,
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(2);
    expect(result.skills.every((s) => s.status === 'ok')).toBe(true);
  });

  it('case 2: one skill missing → ok=false, status=missing', async () => {
    createSkill(workspaceDir, 'skill-a', VALID_SKILL_CONTENT);
    // skill-b intentionally NOT created

    const result = await runSkillsPreflight({
      skillsRequired: ['skill-a', 'skill-b'],
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    const missing = result.skills.find((s) => s.name === 'skill-b');
    expect(missing?.status).toBe('missing');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('case 3: skill has invalid frontmatter → ok=false, status=invalid', async () => {
    createSkill(workspaceDir, 'bad-skill', INVALID_FRONTMATTER_CONTENT);

    const result = await runSkillsPreflight({
      skillsRequired: ['bad-skill'],
      workspaceDir,
    });

    expect(result.ok).toBe(false);
    const descriptor = result.skills.find((s) => s.name === 'bad-skill');
    expect(descriptor?.status).toBe('invalid');
    expect(descriptor?.errors?.length).toBeGreaterThan(0);
  });

  it('case 4: permission=deny → ok=false, status=deny', async () => {
    createSkill(workspaceDir, 'restricted-skill', VALID_SKILL_CONTENT.replace('my-skill', 'restricted-skill'));

    const result = await runSkillsPreflight({
      skillsRequired: ['restricted-skill'],
      workspaceDir,
      permissionMap: { 'restricted-skill': 'deny' },
    });

    expect(result.ok).toBe(false);
    const descriptor = result.skills.find((s) => s.name === 'restricted-skill');
    expect(descriptor?.status).toBe('deny');
    expect(descriptor?.permission).toBe('deny');
  });

  it('permission=ask → status=ask, ok=true (non-blocking)', async () => {
    createSkill(workspaceDir, 'ask-skill', VALID_SKILL_CONTENT.replace('my-skill', 'ask-skill'));

    const result = await runSkillsPreflight({
      skillsRequired: ['ask-skill'],
      workspaceDir,
      permissionMap: { 'ask-skill': 'ask' },
    });

    expect(result.ok).toBe(true);
    const descriptor = result.skills.find((s) => s.name === 'ask-skill');
    expect(descriptor?.status).toBe('ask');
  });

  it('toolEnabled=false makes preflight informational only (ok always true)', async () => {
    // Missing skill but toolEnabled=false → ok still true
    const result = await runSkillsPreflight({
      skillsRequired: ['nonexistent'],
      workspaceDir,
      toolEnabled: false,
    });

    expect(result.ok).toBe(true);
    expect(result.skills[0]?.status).toBe('missing');
  });

  it('wildcard permission map * applies to unspecified skills', async () => {
    createSkill(workspaceDir, 'any-skill', VALID_SKILL_CONTENT.replace('my-skill', 'any-skill'));

    const result = await runSkillsPreflight({
      skillsRequired: ['any-skill'],
      workspaceDir,
      permissionMap: { '*': 'deny' },
    });

    expect(result.ok).toBe(false);
    expect(result.skills[0]?.status).toBe('deny');
  });
});
