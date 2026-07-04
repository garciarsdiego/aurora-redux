// M1 Wave 2 (2026-05-12, gap B3): wire Setup → Fallback chain into the
// executor's failover policy. Before this change, the chain saved by
// `/api/setup/fallback` was silently ignored — the executor walked a
// hardcoded per-role chain regardless of what the operator authored.
//
// This suite locks in the new precedence:
//   1. setup-config has `fallback.enabled: true` + non-empty chain → use it.
//   2. setup-config `fallback.enabled: false` → fall back to role chain.
//   3. setup-config chain empty → fall back to role chain.
//   4. setup-config file missing/malformed → fall back to role chain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getEffectiveFallbackChain,
  getFallbackChain,
  selectFallbackModel,
} from '../../src/v2/failover/policy.js';
import { setFallbackConfig } from '../../src/utils/setup-config.js';

let tmpDir: string;
let configPath: string;
const ENV_BACKUP: Record<string, string | undefined> = {};

function captureEnv(...keys: string[]) {
  for (const key of keys) ENV_BACKUP[key] = process.env[key];
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-fallback-chain-'));
  configPath = join(tmpDir, 'setup-config.json');
  captureEnv('OMNIFORGE_SETUP_CONFIG_PATH');
  process.env.OMNIFORGE_SETUP_CONFIG_PATH = configPath;
});

afterEach(() => {
  restoreEnv();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('getEffectiveFallbackChain precedence', () => {
  it('falls back to the hardcoded role chain when setup-config is missing', () => {
    const effective = getEffectiveFallbackChain('decomposer-complex');
    const hardcoded = getFallbackChain('decomposer-complex');
    expect(effective).toEqual(hardcoded);
  });

  it('uses operator-authored chain when enabled and non-empty', () => {
    setFallbackConfig({
      enabled: true,
      chain: [
        { provider: 'cc', model: 'cc/claude-opus-4-7' },
        { provider: 'cx', model: 'cx/gpt-5.4' },
        { provider: 'gemini-cli', model: 'gemini-cli/gemini-3.1-pro-preview' },
      ],
    });
    const effective = getEffectiveFallbackChain('decomposer-complex');
    expect(effective).toEqual([
      'cc/claude-opus-4-7',
      'cx/gpt-5.4',
      'gemini-cli/gemini-3.1-pro-preview',
    ]);
  });

  it('falls back to role chain when fallback is explicitly disabled', () => {
    setFallbackConfig({
      enabled: false,
      chain: [{ provider: 'cc', model: 'cc/claude-opus-4-7' }],
    });
    const effective = getEffectiveFallbackChain('reviewer-primary');
    const hardcoded = getFallbackChain('reviewer-primary');
    expect(effective).toEqual(hardcoded);
  });

  it('falls back to role chain when operator chain is empty even if enabled', () => {
    setFallbackConfig({ enabled: true, chain: [] });
    const effective = getEffectiveFallbackChain('validator');
    const hardcoded = getFallbackChain('validator');
    expect(effective).toEqual(hardcoded);
  });

  it('falls back to role chain when setup-config JSON is malformed', () => {
    writeFileSync(configPath, '{ this is not valid json', 'utf8');
    const effective = getEffectiveFallbackChain('consolidator');
    const hardcoded = getFallbackChain('consolidator');
    expect(effective).toEqual(hardcoded);
  });

  it('ignores chain entries that lack a model id', () => {
    // setup-config normalisation drops malformed rows before we ever see them
    // here, but the second filter inside `loadSetupFallbackChain` is the
    // belt-and-braces defence — exercise it via a direct file write.
    writeFileSync(
      configPath,
      JSON.stringify({
        fallback: {
          enabled: true,
          chain: [
            { provider: 'cc', model: 'cc/claude-opus-4-7' },
            { provider: 'unknown', model: '   ' }, // whitespace-only → drop
            { provider: 'cx', model: 'cx/gpt-5.4' },
          ],
        },
      }),
      'utf8',
    );
    const effective = getEffectiveFallbackChain('decomposer-complex');
    expect(effective).toEqual(['cc/claude-opus-4-7', 'cx/gpt-5.4']);
  });
});

describe('selectFallbackModel', () => {
  it('walks the operator-authored chain in order', () => {
    setFallbackConfig({
      enabled: true,
      chain: [
        { provider: 'a', model: 'a/m1' },
        { provider: 'b', model: 'b/m2' },
        { provider: 'c', model: 'c/m3' },
      ],
    });
    expect(selectFallbackModel('decomposer-complex', 'a/m1')).toBe('b/m2');
    expect(selectFallbackModel('decomposer-complex', 'b/m2')).toBe('c/m3');
    expect(selectFallbackModel('decomposer-complex', 'c/m3')).toBeUndefined();
  });

  it('returns first model in operator chain when current model is off-chain', () => {
    setFallbackConfig({
      enabled: true,
      chain: [{ provider: 'a', model: 'a/m1' }, { provider: 'b', model: 'b/m2' }],
    });
    expect(selectFallbackModel('validator', 'unknown/model')).toBe('a/m1');
  });

  it('walks the role chain when operator chain is disabled', () => {
    setFallbackConfig({ enabled: false, chain: [] });
    const roleChain = getFallbackChain('decomposer-complex');
    expect(roleChain.length).toBeGreaterThan(1);
    expect(selectFallbackModel('decomposer-complex', roleChain[0]!)).toBe(roleChain[1]);
  });

  it('returns undefined when both setup chain (disabled) and role chain are exhausted', () => {
    setFallbackConfig({ enabled: false, chain: [] });
    const roleChain = getFallbackChain('decomposer-complex');
    const tail = roleChain[roleChain.length - 1]!;
    expect(selectFallbackModel('decomposer-complex', tail)).toBeUndefined();
  });
});
