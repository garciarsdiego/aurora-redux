import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveToken } from '../../src/mcp/http-server.js';

// ── resolveToken unit tests ───────────────────────────────────────────────────

describe('resolveToken', () => {
  const testDataDir = path.join(tmpdir(), `omniforge-test-token-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(testDataDir, { recursive: true });
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
  });

  afterEach(() => {
    rmSync(testDataDir, { recursive: true, force: true });
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
  });

  it('returns env var when OMNIFORGE_DAEMON_TOKEN is set', () => {
    process.env.OMNIFORGE_DAEMON_TOKEN = 'my-fixed-token';
    expect(resolveToken(testDataDir)).toBe('my-fixed-token');
  });

  it('generates token file on first call', () => {
    const tokenFile = path.join(testDataDir, 'daemon-token.txt');
    expect(existsSync(tokenFile)).toBe(false);

    const token = resolveToken(testDataDir);
    expect(existsSync(tokenFile)).toBe(true);
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not print the generated token value to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const token = resolveToken(path.join(testDataDir, 'no-leak'));
    const stderr = spy.mock.calls.map((args) => String(args[0])).join('');
    expect(stderr).not.toContain(token);
    expect(stderr).toContain('Token generated');
    spy.mockRestore();
  });

  it('returns same token on repeated calls', () => {
    const t1 = resolveToken(testDataDir);
    const t2 = resolveToken(testDataDir);
    expect(t1).toBe(t2);
  });

  it('env var takes precedence over file', () => {
    // Generate file first
    resolveToken(testDataDir);
    const fileToken = readFileSync(path.join(testDataDir, 'daemon-token.txt'), 'utf8').trim();

    // Now set env var to something different
    process.env.OMNIFORGE_DAEMON_TOKEN = 'override-token';
    expect(resolveToken(testDataDir)).toBe('override-token');
    expect(resolveToken(testDataDir)).not.toBe(fileToken);
  });

  it('creates data directory if missing', () => {
    const nestedDir = path.join(testDataDir, 'nested', 'deep');
    const token = resolveToken(nestedDir);
    expect(existsSync(path.join(nestedDir, 'daemon-token.txt'))).toBe(true);
    expect(token).toHaveLength(64);
  });
});
