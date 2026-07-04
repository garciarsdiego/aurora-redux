import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getDisabledProviders,
  getMaxSequentialTasks,
  loadSetupConfig,
  saveSetupConfig,
  setFallbackConfig,
  setLimitsConfig,
  setProviderDisabled,
  setRoleModels,
} from '../../src/utils/setup-config.js';

// Each test gets a fresh isolated tmp dir so the on-disk state never leaks.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-setup-'));
  configPath = join(tmpDir, 'setup-config.json');
  captureEnv('OMNIFORGE_SETUP_CONFIG_PATH', 'OMNIFORGE_MAX_SEQUENTIAL_TASKS');
  process.env['OMNIFORGE_SETUP_CONFIG_PATH'] = configPath;
});

afterEach(() => {
  restoreEnv();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadSetupConfig', () => {
  it('returns defaults when file does not exist', () => {
    const cfg = loadSetupConfig();
    expect(cfg.disabled_providers).toEqual([]);
    expect(cfg.role_models).toEqual({});
    expect(cfg.fallback.enabled).toBe(true);
    expect(cfg.fallback.chain).toEqual([]);
    expect(cfg.limits).toEqual({});
  });

  it('returns defaults on malformed JSON without crashing', () => {
    writeFileSync(configPath, '{ this is not valid json', 'utf8');
    const cfg = loadSetupConfig();
    expect(cfg.disabled_providers).toEqual([]);
  });

  it('round-trips a saved config', () => {
    saveSetupConfig({
      disabled_providers: ['minimax', 'mistral'],
      role_models: { decomposer: 'cc/claude-opus-4-7' },
      fallback: {
        enabled: false,
        chain: [{ provider: 'cc', model: 'cc/claude-opus-4-7' }],
      },
      limits: { max_sequential_tasks: 6 },
    });
    const cfg = loadSetupConfig();
    expect(cfg.disabled_providers).toEqual(['minimax', 'mistral']);
    expect(cfg.role_models.decomposer).toBe('cc/claude-opus-4-7');
    expect(cfg.fallback.enabled).toBe(false);
    expect(cfg.fallback.chain).toHaveLength(1);
    expect(cfg.limits.max_sequential_tasks).toBe(6);
  });

  it('drops chain entries that are not {provider, model}', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        fallback: {
          enabled: true,
          chain: [
            { provider: 'cc', model: 'cc/claude-opus-4-7' },
            { provider: 42 }, // bad
            'invalid', // bad
            { provider: 'cx', model: 'cx/gpt-5.4' },
          ],
        },
      }),
      'utf8',
    );
    const cfg = loadSetupConfig();
    expect(cfg.fallback.chain).toHaveLength(2);
    expect(cfg.fallback.chain[0]).toEqual({ provider: 'cc', model: 'cc/claude-opus-4-7' });
    expect(cfg.fallback.chain[1]).toEqual({ provider: 'cx', model: 'cx/gpt-5.4' });
  });
});

describe('setProviderDisabled', () => {
  it('adds and removes a provider from disabled set', () => {
    setProviderDisabled('cc', true);
    expect(getDisabledProviders().has('cc')).toBe(true);

    setProviderDisabled('cc', false);
    expect(getDisabledProviders().has('cc')).toBe(false);
  });

  it('toggling the same provider on twice keeps the set deduped', () => {
    setProviderDisabled('cc', true);
    setProviderDisabled('cc', true);
    const cfg = loadSetupConfig();
    expect(cfg.disabled_providers.filter((p) => p === 'cc')).toHaveLength(1);
  });
});

describe('setRoleModels', () => {
  it('merges new role overrides without clobbering others', () => {
    setRoleModels({ decomposer: 'cc/claude-opus-4-7' });
    setRoleModels({ task: 'cc/claude-sonnet-4-6' });
    const cfg = loadSetupConfig();
    expect(cfg.role_models.decomposer).toBe('cc/claude-opus-4-7');
    expect(cfg.role_models.task).toBe('cc/claude-sonnet-4-6');
  });

  it("clears an override when an empty string is passed", () => {
    setRoleModels({ decomposer: 'cc/claude-opus-4-7' });
    expect(loadSetupConfig().role_models.decomposer).toBe('cc/claude-opus-4-7');
    setRoleModels({ decomposer: '' });
    expect(loadSetupConfig().role_models.decomposer).toBeUndefined();
  });
});

describe('setFallbackConfig', () => {
  it('replaces the chain wholesale', () => {
    setFallbackConfig({
      enabled: true,
      chain: [
        { provider: 'cc', model: 'cc/claude-opus-4-7' },
        { provider: 'cx', model: 'cx/gpt-5.4' },
      ],
    });
    setFallbackConfig({ enabled: false, chain: [] });
    const cfg = loadSetupConfig();
    expect(cfg.fallback.enabled).toBe(false);
    expect(cfg.fallback.chain).toEqual([]);
  });
});

describe('setLimitsConfig', () => {
  it('merges new limits with previously persisted ones', () => {
    setLimitsConfig({ max_sequential_tasks: 5 });
    const cfg = loadSetupConfig();
    expect(cfg.limits.max_sequential_tasks).toBe(5);
  });

  it('floors fractional values and rejects sub-1 values', () => {
    setLimitsConfig({ max_sequential_tasks: 7.9 });
    expect(loadSetupConfig().limits.max_sequential_tasks).toBe(7);
  });
});

describe('getMaxSequentialTasks precedence', () => {
  it('falls back to 10 when nothing is set', () => {
    expect(getMaxSequentialTasks()).toBe(10);
  });

  it('reads setup-config.json when env is unset', () => {
    setLimitsConfig({ max_sequential_tasks: 6 });
    expect(getMaxSequentialTasks()).toBe(6);
  });

  it('env var overrides config file', () => {
    setLimitsConfig({ max_sequential_tasks: 6 });
    process.env['OMNIFORGE_MAX_SEQUENTIAL_TASKS'] = '4';
    expect(getMaxSequentialTasks()).toBe(4);
  });

  it('ignores non-numeric env values', () => {
    setLimitsConfig({ max_sequential_tasks: 6 });
    process.env['OMNIFORGE_MAX_SEQUENTIAL_TASKS'] = 'banana';
    expect(getMaxSequentialTasks()).toBe(6);
  });
});

describe('atomic write durability', () => {
  it('produces well-formed JSON readable by a fresh load', () => {
    saveSetupConfig({
      disabled_providers: ['x'],
      role_models: { task: 'cc/claude-sonnet-4-6' },
      fallback: { enabled: true, chain: [] },
      limits: { max_sequential_tasks: 8 },
    });
    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.disabled_providers).toEqual(['x']);
  });
});
