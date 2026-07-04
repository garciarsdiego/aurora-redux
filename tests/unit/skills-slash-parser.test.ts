import { describe, it, expect } from 'vitest';
import {
  normalizeSlug,
  parseSlashCommand,
  matchSkill,
} from '../../src/v2/skills/slash-parser.js';

describe('normalizeSlug', () => {
  it('strips leading slash and lowercases', () => {
    expect(normalizeSlug('/Debug')).toBe('debug');
  });

  it('replaces spaces and special chars with hyphens', () => {
    expect(normalizeSlug('code review')).toBe('code-review');
  });

  it('strips diacritics', () => {
    expect(normalizeSlug('análise')).toBe('analise');
  });

  it('handles empty string gracefully', () => {
    expect(normalizeSlug('')).toBe('');
  });
});

describe('parseSlashCommand', () => {
  it('detects a slash command and extracts slug + rest', () => {
    const result = parseSlashCommand('/debug some issue here');
    expect(result.found).toBe(true);
    expect(result.slug).toBe('debug');
    expect(result.message).toBe('some issue here');
    expect(result.normalize).toBe('debug');
  });

  it('returns found=false for plain text', () => {
    const result = parseSlashCommand('hello world');
    expect(result.found).toBe(false);
    expect(result.slug).toBe('');
    expect(result.message).toBe('hello world');
  });

  it('handles command with no trailing text', () => {
    const result = parseSlashCommand('/codereview');
    expect(result.found).toBe(true);
    expect(result.slug).toBe('codereview');
    expect(result.message).toBe('');
  });

  it('normalizes slug in the normalize field', () => {
    const result = parseSlashCommand('/Code-Review');
    expect(result.found).toBe(true);
    expect(result.normalize).toBe('code-review');
  });
});

describe('matchSkill', () => {
  const skills = [
    { name: 'debug', slashCommand: '/debug', enabled: true },
    { name: 'Code Review', slashCommand: '/codereview', enabled: true },
    { name: 'disabled-skill', enabled: false },
  ];

  it('matches by normalized slashCommand', () => {
    const match = matchSkill('debug', skills);
    expect(match).not.toBeNull();
    expect(match?.skill.name).toBe('debug');
  });

  it('matches by normalized skill name when slashCommand absent', () => {
    const skillsNoSlash = [{ name: 'analyze', enabled: true }];
    const match = matchSkill('analyze', skillsNoSlash);
    expect(match).not.toBeNull();
  });

  it('returns null for unknown slug', () => {
    expect(matchSkill('unknown-cmd', skills)).toBeNull();
  });

  it('does not match disabled skills', () => {
    expect(matchSkill('disabled-skill', skills)).toBeNull();
  });
});
