import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The settings-file module honours OMNIFORGE_SETTINGS_PATH so tests never
// touch the real ~/.omniforge/settings.json.  Each test gets a fresh temp
// dir; the env var is restored after every test.

let tmpDir: string;
let settingsPath: string;
const ENV_KEY = 'OMNIFORGE_SETTINGS_PATH';
let envBackup: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-settings-'));
  settingsPath = join(tmpDir, 'settings.json');
  envBackup = process.env[ENV_KEY];
  process.env[ENV_KEY] = settingsPath;
});

afterEach(() => {
  if (envBackup === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = envBackup;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// Re-import inside tests using dynamic import so the env override is in place
// before the module's resolveSettingsPath() is evaluated at call time (it reads
// process.env lazily on every call, so static import is also fine here).
import { readSettings, writeSettings } from '../../src/utils/settings-file.js';

describe('settings-file', () => {
  it('readSettings returns {} when file does not exist', () => {
    expect(existsSync(settingsPath)).toBe(false);
    expect(readSettings()).toEqual({});
  });

  it('writeSettings creates the file', () => {
    writeSettings({ daemon_token: 'tok-abc' });
    expect(existsSync(settingsPath)).toBe(true);
  });

  it('writeSettings stores content as valid JSON', () => {
    writeSettings({ daemon_token: 'tok-xyz' });
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    expect(parsed).toEqual({ daemon_token: 'tok-xyz' });
  });

  it('writeSettings uses mode 0o600 on POSIX (skipped on Windows)', () => {
    // Windows does not expose POSIX permission bits; skip there.
    if (process.platform === 'win32') return;
    writeSettings({ daemon_token: 'secure-tok' });
    const mode = statSync(settingsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readSettings round-trips written settings', () => {
    writeSettings({ daemon_token: 'test-token-123' });
    expect(readSettings().daemon_token).toBe('test-token-123');
  });

  it('writeSettings merges — later write overwrites earlier value', () => {
    writeSettings({ daemon_token: 'first' });
    writeSettings({ daemon_token: 'second' });
    expect(readSettings().daemon_token).toBe('second');
  });

  it('writeSettings preserves unrelated keys that were already on disk', () => {
    // Manually write a settings file with an extra unknown key to simulate a
    // future schema field that this version doesn't know about.
    writeFileSync(settingsPath, JSON.stringify({ daemon_token: 'old', extra_key: 42 }, null, 2), 'utf-8');
    writeSettings({ daemon_token: 'new' });
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['daemon_token']).toBe('new');
    expect(parsed['extra_key']).toBe(42);
  });

  it('readSettings handles malformed JSON gracefully — returns {}', () => {
    writeFileSync(settingsPath, '{ this is not valid json }', 'utf-8');
    expect(readSettings()).toEqual({});
  });

  it('readSettings handles non-object JSON gracefully — returns {}', () => {
    writeFileSync(settingsPath, '"just a string"', 'utf-8');
    expect(readSettings()).toEqual({});
  });

  it('readSettings handles an array JSON value gracefully — returns {}', () => {
    writeFileSync(settingsPath, '[1, 2, 3]', 'utf-8');
    expect(readSettings()).toEqual({});
  });
});
