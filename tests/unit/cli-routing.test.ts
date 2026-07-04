import { describe, expect, it } from 'vitest';
import {
  cliHintForModel,
  isDefaultishCliHint,
  normalizeCliExecutorHintForModel,
} from '../../src/utils/cli-routing.js';

describe('CLI routing helpers', () => {
  it('maps model provider prefixes to the matching local CLI executor', () => {
    expect(cliHintForModel('cx/gpt-5.4')).toBe('cli:codex');
    expect(cliHintForModel('codex/gpt-5-codex')).toBe('cli:codex');
    expect(cliHintForModel('cc/claude-sonnet-4-6')).toBe('cli:claude-code');
    expect(cliHintForModel('claude/sonnet')).toBe('cli:claude-code');
    expect(cliHintForModel('gemini-cli/gemini-3.1-pro-preview')).toBe('cli:gemini');
    expect(cliHintForModel('kimi/k2.5')).toBe('cli:kimi');
    expect(cliHintForModel('kmc/kimi-k2.5-thinking')).toBe('cli:kimi');
    expect(cliHintForModel('unknown/model')).toBeNull();
  });

  it('treats legacy/default Claude hints as default-ish so model prefixes can repair them', () => {
    expect(isDefaultishCliHint(null)).toBe(true);
    expect(isDefaultishCliHint('')).toBe(true);
    expect(isDefaultishCliHint('cli:auto')).toBe(true);
    expect(isDefaultishCliHint('cli:default')).toBe(true);
    expect(isDefaultishCliHint('cli:claude-code')).toBe(true);
    expect(isDefaultishCliHint('cli:codex')).toBe(false);
    expect(isDefaultishCliHint('cli:gemini')).toBe(false);
  });

  it('repairs the observed cx/gpt-5.4 plus cli:claude-code mismatch for cli_spawn tasks', () => {
    expect(
      normalizeCliExecutorHintForModel('cli_spawn', 'cli:claude-code', 'cx/gpt-5.4'),
    ).toBe('cli:codex');
  });

  it('does not rewrite non-CLI tasks', () => {
    expect(
      normalizeCliExecutorHintForModel('llm_call', 'cli:claude-code', 'cx/gpt-5.4'),
    ).toBe('cli:claude-code');
  });

  it('repairs explicit executor choices that contradict the selected CLI-model provider', () => {
    expect(
      normalizeCliExecutorHintForModel('cli_spawn', 'cli:gemini', 'cx/gpt-5.4'),
    ).toBe('cli:codex');
  });
});
