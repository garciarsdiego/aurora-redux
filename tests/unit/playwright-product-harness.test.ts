/**
 * F6-1 unit test: Playwright product harness skip-path coverage.
 *
 * Verifies that the harness:
 *   - returns status='skipped' with reason='no package.json' when the project
 *     root exists but has no package.json (this is the Playwright-not-needed
 *     short-circuit, so we do NOT spawn anything and Playwright import is
 *     never reached).
 *   - returns status='skipped' when Playwright cannot be loaded at runtime
 *     (mocked import failure).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runPlaywrightProductHarness,
  type PlaywrightHarnessInput,
} from '../../src/quality/playwright-product-harness.js';

function makeTempDir(label: string): string {
  const dir = join(
    tmpdir(),
    `omniforge-pwh-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const baseInput = (projectRoot: string): PlaywrightHarnessInput => ({
  projectRoot,
  objective: 'verify the dashboard renders the home view',
  expectedSelectors: ['[data-testid="root"]'],
});

describe('runPlaywrightProductHarness — skip paths', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    vi.restoreAllMocks();
  });

  it('returns skipped with reason="no package.json" when the project root has no package.json', async () => {
    const dir = makeTempDir('no-pkg');
    cleanup.push(dir);

    const result = await runPlaywrightProductHarness(baseInput(dir));

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('no package.json');
    expect(result.mismatches).toEqual([]);
    expect(result.screenshotPaths).toEqual([]);
    expect(result.appUrl).toBeUndefined();
  });

  it('returns skipped with reason="playwright not installed" when the playwright import fails', async () => {
    const dir = makeTempDir('no-playwright');
    cleanup.push(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { dev: 'vite' } }),
      'utf8',
    );

    // Force playwright loader to fail. We re-import the module after mocking
    // so the dynamic import inside loadPlaywright sees the failing stub.
    vi.doMock('playwright', () => {
      throw new Error('mocked: playwright not available');
    });

    const { runPlaywrightProductHarness: runHarness } = await import(
      '../../src/quality/playwright-product-harness.js'
    );

    const result = await runHarness(baseInput(dir));

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('playwright not installed');
    expect(result.mismatches).toEqual([]);
    expect(result.screenshotPaths).toEqual([]);

    vi.doUnmock('playwright');
  });
});
