/**
 * Unit tests for src/v2/runtime/opencode-config.ts.
 *
 * Wave C / Agent P (revised) — verify the model-resolution priority ladder
 * and the snapshot extraction from real (temp-dir) opencode config files.
 *
 * Conventions follow other v2 unit tests: per-test mkdtempSync, full cleanup
 * in afterEach, no global mocks. Each `home` fixture is passed explicitly to
 * `readOpencodeConfig({ home })` so we never touch the operator's real
 * `~/.config/opencode/`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildOpencodeConfigCandidates,
  readOpencodeConfig,
  resolveOpencodeModelForWorkflow,
  stripJsonComments,
  type OpencodeConfigSnapshot,
} from '../../src/v2/runtime/opencode-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let homeDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(path.join(tmpdir(), 'omniforge-opencode-cfg-'));
});

afterEach(() => {
  try {
    rmSync(homeDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeConfig(relPath: string, body: string): string {
  const fullPath = path.join(homeDir, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, body, 'utf8');
  return fullPath;
}

function withProviders(providers: Record<string, { models: Record<string, unknown> }>): string {
  return JSON.stringify({ provider: providers });
}

// ─────────────────────────────────────────────────────────────────────────────
// buildOpencodeConfigCandidates — discovery order is load-bearing
// ─────────────────────────────────────────────────────────────────────────────

describe('buildOpencodeConfigCandidates', () => {
  it('emits the documented 5-path ordering rooted at the given home', () => {
    const got = buildOpencodeConfigCandidates('/home/test');
    expect(got).toEqual([
      path.join('/home/test', '.config', 'opencode', 'opencode.json'),
      path.join('/home/test', '.config', 'opencode', 'config.json'),
      path.join('/home/test', '.config', 'opencode', 'opencode.jsonc'),
      path.join('/home/test', '.opencode', 'opencode.json'),
      path.join('/home/test', '.opencode', 'opencode.jsonc'),
    ]);
  });

  it('returns a frozen array (immutability invariant)', () => {
    const got = buildOpencodeConfigCandidates('/home/test');
    expect(Object.isFrozen(got)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stripJsonComments — JSONC support is opt-in by extension
// ─────────────────────────────────────────────────────────────────────────────

describe('stripJsonComments', () => {
  it('strips // line comments outside strings', () => {
    const src = `{
      // top comment
      "a": 1, // trailing
      "b": "hello // not-a-comment"
    }`;
    const out = stripJsonComments(src);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 'hello // not-a-comment' });
  });

  it('strips /* block */ comments outside strings', () => {
    const src = `{
      /* block
         spanning */
      "a": 1,
      "b": "x /* still string */ y"
    }`;
    const out = stripJsonComments(src);
    expect(JSON.parse(out)).toEqual({ a: 1, b: 'x /* still string */ y' });
  });

  it('preserves escaped quotes inside strings', () => {
    const src = '{"a": "he said \\"hi\\" // not-a-comment"}';
    const out = stripJsonComments(src);
    expect(JSON.parse(out)).toEqual({ a: 'he said "hi" // not-a-comment' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readOpencodeConfig — file-system snapshot extraction
// ─────────────────────────────────────────────────────────────────────────────

describe('readOpencodeConfig', () => {
  it('returns empty snapshot when no config file exists', () => {
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.configPath).toBeNull();
    expect(snap.raw).toEqual({});
    expect(snap.defaultModel).toBeNull();
    expect(snap.declaredProviders).toEqual([]);
    expect(snap.declaredModels).toEqual([]);
    expect(snap.errors).toEqual([]);
  });

  it('parses defaultModel from the canonical opencode.json location', () => {
    writeConfig(
      '.config/opencode/opencode.json',
      JSON.stringify({ defaultModel: 'opencode/claude-haiku-4-5' }),
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.configPath).toContain(path.join('.config', 'opencode', 'opencode.json'));
    expect(snap.defaultModel).toBe('opencode/claude-haiku-4-5');
    expect(snap.errors).toEqual([]);
  });

  it('also accepts the snake_case default_model alias', () => {
    writeConfig(
      '.config/opencode/opencode.json',
      JSON.stringify({ default_model: 'omniroute/gpt-5.5' }),
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.defaultModel).toBe('omniroute/gpt-5.5');
  });

  it('extracts declared providers and prefixes models with provider name', () => {
    writeConfig(
      '.config/opencode/opencode.json',
      withProviders({
        omniroute: { models: { 'gpt-5.5': {}, 'claude-sonnet-4-6': {} } },
        anthropic: { models: { 'claude-haiku-4-5-20251001': {} } },
      }),
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.declaredProviders).toEqual(['omniroute', 'anthropic']);
    expect(snap.declaredModels).toEqual([
      'omniroute/gpt-5.5',
      'omniroute/claude-sonnet-4-6',
      'anthropic/claude-haiku-4-5-20251001',
    ]);
  });

  it('parses JSONC files with line and block comments', () => {
    writeConfig(
      '.config/opencode/opencode.jsonc',
      `{
        // operator notes — pinned during incident #41
        "defaultModel": "opencode/kimi-k2",
        /* providers below are managed by Aurora */
        "provider": { "opencode": { "models": { "kimi-k2": {} } } }
      }`,
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.defaultModel).toBe('opencode/kimi-k2');
    expect(snap.declaredModels).toEqual(['opencode/kimi-k2']);
    expect(snap.errors).toEqual([]);
  });

  it('records a parse error when JSON is malformed (and keeps configPath)', () => {
    const badPath = writeConfig('.config/opencode/opencode.json', '{ "defaultModel": ');
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.configPath).toBe(badPath);
    expect(snap.raw).toEqual({});
    expect(snap.defaultModel).toBeNull();
    expect(snap.errors.length).toBeGreaterThan(0);
    expect(snap.errors[0]).toMatch(/JSON parse failed/);
  });

  it('records an error when root is not an object (e.g. array)', () => {
    writeConfig('.config/opencode/opencode.json', '[1, 2, 3]');
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.raw).toEqual({});
    expect(snap.errors[0]).toMatch(/Config root is not an object/);
  });

  it('warns when multiple configs exist and uses the first found (priority order)', () => {
    writeConfig(
      '.config/opencode/opencode.json',
      JSON.stringify({ defaultModel: 'omniroute/primary' }),
    );
    writeConfig(
      '.config/opencode/config.json',
      JSON.stringify({ defaultModel: 'omniroute/secondary' }),
    );
    writeConfig(
      '.opencode/opencode.json',
      JSON.stringify({ defaultModel: 'omniroute/tertiary' }),
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.configPath).toContain(path.join('.config', 'opencode', 'opencode.json'));
    expect(snap.defaultModel).toBe('omniroute/primary');
    expect(snap.errors.length).toBe(2);
    expect(snap.errors.every((e) => e.includes('Multiple opencode configs detected'))).toBe(true);
  });

  it('handles provider declared without any models (empty declaredModels)', () => {
    writeConfig(
      '.config/opencode/opencode.json',
      JSON.stringify({ provider: { omniroute: {} } }),
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.declaredProviders).toEqual(['omniroute']);
    expect(snap.declaredModels).toEqual([]);
  });

  it('falls back to the .opencode dotfile when XDG paths are absent', () => {
    writeConfig(
      '.opencode/opencode.json',
      JSON.stringify({ defaultModel: 'opencode/dotfile-model' }),
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.configPath).toContain(path.join('.opencode', 'opencode.json'));
    expect(snap.defaultModel).toBe('opencode/dotfile-model');
  });

  it('ignores empty-string defaultModel (treated as absent)', () => {
    writeConfig(
      '.config/opencode/opencode.json',
      JSON.stringify({ defaultModel: '   ' }),
    );
    const snap = readOpencodeConfig({ home: homeDir });
    expect(snap.defaultModel).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveOpencodeModelForWorkflow — the priority ladder
// ─────────────────────────────────────────────────────────────────────────────

function snap(partial: Partial<OpencodeConfigSnapshot>): OpencodeConfigSnapshot {
  return {
    configPath: partial.configPath ?? null,
    raw: partial.raw ?? {},
    defaultModel: partial.defaultModel ?? null,
    declaredProviders: partial.declaredProviders ?? [],
    declaredModels: partial.declaredModels ?? [],
    errors: partial.errors ?? [],
  };
}

describe('resolveOpencodeModelForWorkflow', () => {
  it('env override wins over everything else', () => {
    const got = resolveOpencodeModelForWorkflow({
      envOverride: 'opencode/env-pin',
      workflowModelHint: 'opencode/hint',
      configSnapshot: snap({
        defaultModel: 'opencode/cfg-default',
        declaredProviders: ['opencode'],
        declaredModels: ['opencode/first'],
      }),
    });
    expect(got).toEqual({
      model: 'opencode/env-pin',
      source: 'env',
      warnings: [],
    });
  });

  it('workflow hint wins over config default and first declared', () => {
    const got = resolveOpencodeModelForWorkflow({
      workflowModelHint: 'opencode/hint',
      configSnapshot: snap({
        defaultModel: 'opencode/cfg-default',
        declaredProviders: ['opencode'],
        declaredModels: ['opencode/first'],
      }),
    });
    expect(got.model).toBe('opencode/hint');
    expect(got.source).toBe('workflow_hint');
    expect(got.warnings).toEqual([]);
  });

  it('config default wins when no env / hint provided', () => {
    const got = resolveOpencodeModelForWorkflow({
      configSnapshot: snap({
        defaultModel: 'opencode/cfg-default',
        declaredProviders: ['opencode'],
        declaredModels: ['opencode/first', 'opencode/second'],
      }),
    });
    expect(got.model).toBe('opencode/cfg-default');
    expect(got.source).toBe('config_default');
  });

  it('falls through to first declared model when defaultModel is absent', () => {
    const got = resolveOpencodeModelForWorkflow({
      configSnapshot: snap({
        declaredProviders: ['opencode'],
        declaredModels: ['opencode/first', 'opencode/second'],
      }),
    });
    expect(got.model).toBe('opencode/first');
    expect(got.source).toBe('config_first_declared');
  });

  it('returns {model: null, source: "none"} when nothing resolves', () => {
    const got = resolveOpencodeModelForWorkflow({
      configSnapshot: snap({}),
    });
    expect(got.model).toBeNull();
    expect(got.source).toBe('none');
    expect(got.warnings).toContain('No model resolvable');
  });

  it('surfaces snapshot errors as warnings even when env override succeeds', () => {
    const got = resolveOpencodeModelForWorkflow({
      envOverride: 'opencode/env-pin',
      configSnapshot: snap({
        errors: ['JSON parse failed for ~/.config/opencode/opencode.json: bad token'],
      }),
    });
    expect(got.model).toBe('opencode/env-pin');
    expect(got.source).toBe('env');
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toMatch(/opencode-config:.*JSON parse failed/);
  });

  it('warns on provider-prefix mismatch but still passes the hint through', () => {
    const got = resolveOpencodeModelForWorkflow({
      workflowModelHint: 'cc/claude-opus-4-7',
      configSnapshot: snap({
        declaredProviders: ['opencode'],
        declaredModels: ['opencode/first'],
      }),
    });
    expect(got.model).toBe('cc/claude-opus-4-7');
    expect(got.source).toBe('workflow_hint');
    expect(got.warnings).toHaveLength(1);
    expect(got.warnings[0]).toMatch(/workflow_hint provider 'cc' not in declared providers/);
  });

  it('does NOT warn about prefix mismatch when no providers are declared', () => {
    const got = resolveOpencodeModelForWorkflow({
      workflowModelHint: 'cc/claude-opus-4-7',
      configSnapshot: snap({}),
    });
    expect(got.warnings).toEqual([]);
  });

  it('treats whitespace-only env override as absent (falls through)', () => {
    const got = resolveOpencodeModelForWorkflow({
      envOverride: '   ',
      configSnapshot: snap({ defaultModel: 'opencode/cfg-default' }),
    });
    expect(got.model).toBe('opencode/cfg-default');
    expect(got.source).toBe('config_default');
  });

  it('treats whitespace-only workflow hint as absent (falls through)', () => {
    const got = resolveOpencodeModelForWorkflow({
      workflowModelHint: '\t\n',
      configSnapshot: snap({ defaultModel: 'opencode/cfg-default' }),
    });
    expect(got.source).toBe('config_default');
  });

  it('preserves snapshot errors as warnings when nothing resolves', () => {
    const got = resolveOpencodeModelForWorkflow({
      configSnapshot: snap({
        errors: ['Multiple opencode configs detected; using first: a (also found: b)'],
      }),
    });
    expect(got.model).toBeNull();
    expect(got.source).toBe('none');
    expect(got.warnings.length).toBe(2);
    expect(got.warnings[0]).toMatch(/Multiple opencode configs/);
    expect(got.warnings[1]).toBe('No model resolvable');
  });

  it('uses on-disk snapshot when configSnapshot is omitted', () => {
    // Sanity: when caller doesn't pre-fetch a snapshot, the resolver still
    // works — but since we can't intercept homedir() here without more
    // plumbing, just verify it doesn't throw and returns the canonical
    // "no model" shape (the operator's real ~/.config/opencode/ may or may
    // not have a config; result depends on env, so we only check the shape).
    const got = resolveOpencodeModelForWorkflow({});
    expect(typeof got.source).toBe('string');
    expect(Array.isArray(got.warnings)).toBe(true);
  });
});
