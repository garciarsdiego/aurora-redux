/**
 * Aurora-parity Wave 1 — constrained test-runner.
 *   - detectTestCommand: marker-based detection (node/pnpm/vitest/pytest/cargo/go)
 *   - runTestCommandConstrained: pass / fail / HARD timeout (process killed, not hung)
 *   - parseTestFailures: failure-only summary
 *   - network-off env is applied
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectTestCommand,
  parseTestFailures,
  runTestCommandConstrained,
} from '../../src/brain/validation/test-runner.js';

const tmpDirs: string[] = [];
function fixture(files: Record<string, string>, dirs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'omni-testrunner-'));
  tmpDirs.push(dir);
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterEach(() => { while (tmpDirs.length) { try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } } });

describe('detectTestCommand', () => {
  it('returns null for an empty / unknown dir', () => {
    expect(detectTestCommand(fixture({ 'README.md': '# hi' }))).toBeNull();
  });
  it('detects pnpm test when package.json has a real test script + pnpm lockfile', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      'pnpm-lock.yaml': '',
    });
    expect(detectTestCommand(dir)).toBe('pnpm test');
  });
  it('ignores the npm-init placeholder test script', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    });
    expect(detectTestCommand(dir)).toBeNull();
  });
  it('falls back to npx vitest when a runner is in devDependencies but no test script', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^4' } }) });
    expect(detectTestCommand(dir)).toBe('npx vitest run');
  });
  it('detects cargo / go by manifest marker', () => {
    expect(detectTestCommand(fixture({ 'Cargo.toml': '[package]' }))).toBe('cargo test');
    expect(detectTestCommand(fixture({ 'go.mod': 'module x' }))).toBe('go test ./...');
  });

  it('detects pytest only with a real pytest indicator (not a bare tests/ dir)', () => {
    expect(detectTestCommand(fixture({ 'pytest.ini': '[pytest]' }))).toBe('python -m pytest -q');
    expect(detectTestCommand(fixture({ 'conftest.py': '' }))).toBe('python -m pytest -q');
    expect(detectTestCommand(fixture({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }))).toBe('python -m pytest -q');
    expect(detectTestCommand(fixture({ 'tests/conftest.py': '' }, ['tests']))).toBe('python -m pytest -q');
    // bare tests/ dir or a poetry project without pytest config → no false trigger
    expect(detectTestCommand(fixture({}, ['tests']))).toBeNull();
    expect(detectTestCommand(fixture({ 'pyproject.toml': '[tool.poetry]\nname="x"' }))).toBeNull();
  });
});

describe('parseTestFailures', () => {
  it('extracts failure-marked lines', () => {
    const out = 'ok 1 a\n✗ b should work\nAssertionError: 1 !== 2\nok 2 c\n3 failed';
    const summary = parseTestFailures(out);
    expect(summary).toMatch(/✗ b should work/);
    expect(summary).toMatch(/AssertionError/);
    expect(summary).toMatch(/3 failed/);
    expect(summary).not.toMatch(/ok 1 a/);
  });
  it('falls back to the output tail when no markers match', () => {
    expect(parseTestFailures('line1\nline2\nline3')).toMatch(/line3/);
  });
});

describe('runTestCommandConstrained', () => {
  it('grades exit 0 as passed', async () => {
    const dir = fixture({});
    const r = await runTestCommandConstrained(dir, 'node -e "process.exit(0)"', { timeoutMs: 15_000, networkOff: true });
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it('grades a non-zero exit as failed with a parsed summary', async () => {
    const dir = fixture({});
    const r = await runTestCommandConstrained(dir, 'node -e "console.log(\'AssertionError: nope\'); process.exit(1)"', { timeoutMs: 15_000, networkOff: true });
    expect(r.passed).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.failureSummary).toMatch(/AssertionError/);
  });

  it('HARD-kills a hanging command at the timeout (does not hang) and grades it failed', async () => {
    const dir = fixture({});
    const start = Date.now();
    const r = await runTestCommandConstrained(dir, 'node -e "setInterval(()=>{}, 1000)"', { timeoutMs: 1_500, networkOff: true });
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.failureSummary).toMatch(/exceeded .*and was killed/i);
    expect(elapsed).toBeLessThan(8_000); // proves it was killed, not run to completion
  }, 12_000);

  it('applies network-off env flags to the child', async () => {
    const dir = fixture({});
    const r = await runTestCommandConstrained(dir, 'node -e "process.stdout.write(process.env.CARGO_NET_OFFLINE + \'|\' + process.env.PIP_NO_INDEX)"', { timeoutMs: 15_000, networkOff: true });
    expect(r.output).toContain('true|1');
  });

  it('omits network-off env when networkOff is false', async () => {
    const dir = fixture({});
    const r = await runTestCommandConstrained(dir, 'node -e "process.stdout.write(\'CNO=\' + (process.env.CARGO_NET_OFFLINE || \'unset\'))"', { timeoutMs: 15_000, networkOff: false });
    expect(r.output).toContain('CNO=unset');
  });
});
