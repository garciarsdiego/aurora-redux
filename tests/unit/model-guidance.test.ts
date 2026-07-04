import { describe, it, expect } from 'vitest';
import {
  getModelGuidance,
  getCliGuidance,
  resolveFamily,
} from '../../src/v2/model-guidance/registry.js';
import { buildDecomposerSystemPrompt } from '../../src/brain/decomposer.js';

// ---------------------------------------------------------------------------
// getModelGuidance — family resolution + guidance strings
// ---------------------------------------------------------------------------

describe('getModelGuidance — family resolution', () => {
  it('gpt-4o → openai guidance (non-empty)', () => {
    const g = getModelGuidance('gpt-4o');
    expect(g.length).toBeGreaterThan(0);
    expect(g).toMatch(/openai/i);
  });

  it('gemini-1.5-pro → google guidance (non-empty)', () => {
    const g = getModelGuidance('gemini-1.5-pro');
    expect(g.length).toBeGreaterThan(0);
    expect(g).toMatch(/gemini/i);
  });

  it('claude-3-5-sonnet → anthropic guidance (empty string)', () => {
    expect(getModelGuidance('claude-3-5-sonnet')).toBe('');
  });

  it('provider-prefixed claude/claude-sonnet-4-6 → anthropic (empty)', () => {
    expect(getModelGuidance('claude/claude-sonnet-4-6')).toBe('');
  });

  it('deepseek-coder → deepseek guidance (non-empty)', () => {
    const g = getModelGuidance('deepseek-coder');
    expect(g.length).toBeGreaterThan(0);
    expect(g).toMatch(/deepseek/i);
  });

  it('kmc/kimi-k2.5 → kimi guidance (non-empty)', () => {
    const g = getModelGuidance('kmc/kimi-k2.5');
    expect(g.length).toBeGreaterThan(0);
    expect(g).toMatch(/kimi/i);
  });

  it('ollamacloud/kimi-k2-thinking → kimi guidance', () => {
    expect(getModelGuidance('ollamacloud/kimi-k2-thinking').length).toBeGreaterThan(0);
  });

  it('unknown-xyz → returns empty string without throwing', () => {
    expect(() => getModelGuidance('unknown-xyz')).not.toThrow();
    expect(getModelGuidance('unknown-xyz')).toBe('');
  });

  it('resolveFamily returns generic for unrecognised model', () => {
    expect(resolveFamily('mystery-model-v99')).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// getCliGuidance — executor_hint → guidance
// ---------------------------------------------------------------------------

describe('getCliGuidance — hint to guidance', () => {
  // cli:claude-code — dedicated per-CLI guidance block
  it('cli:claude-code → non-empty guidance mentioning Agent tool', () => {
    const g = getCliGuidance('cli:claude-code');
    expect(g.length).toBeGreaterThan(0);
    expect(g).toMatch(/Agent tool/i);
  });

  it('cli:claude-code guidance mentions at least 3 subagent_type values', () => {
    const g = getCliGuidance('cli:claude-code');
    // guidance enumerates: general-purpose, code-reviewer, typescript-pro,
    // frontend-developer, architect, architect-reviewer, security-auditor,
    // refactoring-specialist, debugger, Explore, Plan, test-automator, database-optimizer
    const count = (g.match(/general-purpose|code-reviewer|typescript-pro|frontend-developer|architect|security-auditor|refactoring-specialist|debugger|test-automator|database-optimizer/gi) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(3);
  });

  // cli:codex — dedicated per-CLI guidance block
  it('cli:codex → non-empty guidance', () => {
    const g = getCliGuidance('cli:codex');
    expect(g.length).toBeGreaterThan(0);
  });

  it('cli:codex guidance explicitly says "DO NOT have a generic Agent-style subagent dispatch"', () => {
    const g = getCliGuidance('cli:codex');
    expect(g).toContain('DO NOT have a generic Agent-style subagent dispatch');
  });

  // cli:gemini — dedicated per-CLI guidance block
  it('cli:gemini → non-empty guidance mentioning grounding', () => {
    const g = getCliGuidance('cli:gemini');
    expect(g.length).toBeGreaterThan(0);
    expect(g).toMatch(/grounding/i);
  });

  // cli:kimi — dedicated per-CLI guidance block
  it('cli:kimi → non-empty guidance that does not claim parallel subagents', () => {
    const g = getCliGuidance('cli:kimi');
    expect(g.length).toBeGreaterThan(0);
    // Must NOT claim parallel subagent dispatch capability
    expect(g).not.toMatch(/parallel subagent dispatch(?! is not| is unavail| — )/i);
    // Should explicitly disclaim it
    expect(g).toMatch(/No native parallel subagent/i);
  });

  it('null hint → empty string without throwing', () => {
    expect(() => getCliGuidance(null)).not.toThrow();
    expect(getCliGuidance(null)).toBe('');
  });

  it('undefined hint → empty string without throwing', () => {
    expect(() => getCliGuidance(undefined)).not.toThrow();
    expect(getCliGuidance(undefined)).toBe('');
  });

  it('bare "codex" (no cli: prefix) → non-empty guidance via partial match', () => {
    const g = getCliGuidance('codex');
    expect(g.length).toBeGreaterThan(0);
  });

  it('bare "gemini" (no cli: prefix) → non-empty guidance via partial match', () => {
    const g = getCliGuidance('gemini');
    expect(g.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildDecomposerSystemPrompt — guidance injected when non-anthropic model
// ---------------------------------------------------------------------------

describe('buildDecomposerSystemPrompt — model guidance injection', () => {
  it('openai model → guidance appended to system prompt', () => {
    const prompt = buildDecomposerSystemPrompt('gpt-4o');
    const guidance = getModelGuidance('gpt-4o');
    expect(prompt).toContain(guidance);
    expect(prompt.length).toBeGreaterThan(guidance.length);
  });

  it('anthropic model → system prompt unchanged (no guidance suffix)', () => {
    const promptWithClaude = buildDecomposerSystemPrompt('claude-sonnet-4-6');
    const promptWithUnknown = buildDecomposerSystemPrompt('unknown-model');
    // Both should be the same base prompt since guidance is empty
    expect(promptWithClaude).toBe(promptWithUnknown);
  });

  it('google model → google guidance present in decomposer prompt', () => {
    const prompt = buildDecomposerSystemPrompt('gemini-1.5-flash');
    expect(prompt).toContain('Gemini');
  });
});
