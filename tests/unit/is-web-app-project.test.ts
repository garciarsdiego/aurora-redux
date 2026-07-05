/**
 * Q4c: Unit tests for isWebAppProject (final-evidence.ts).
 *
 * Q4b widened this heuristic: in addition to the existing
 * react/vue/svelte/next package.json dependency detection, a project root
 * with a root-level index.html (a zero-build static app — e.g. a game
 * clone with no framework package.json) now also counts as a web app.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isWebAppProject } from '../../src/quality/final-evidence.js';

function makeTempDir(label: string): string {
  const dir = join(
    tmpdir(),
    `omniforge-iswebapp-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('isWebAppProject', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('returns true for a directory with a root index.html and no package.json (Q4b static app case)', () => {
    const dir = makeTempDir('index-html-only');
    cleanup.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf8');

    expect(isWebAppProject(dir)).toBe(true);
  });

  it('returns false for a directory with neither index.html nor package.json', () => {
    const dir = makeTempDir('empty');
    cleanup.push(dir);

    expect(isWebAppProject(dir)).toBe(false);
  });

  it('returns false for a directory with a package.json that has no web framework dependency and no index.html', () => {
    const dir = makeTempDir('non-web-pkg');
    cleanup.push(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'cli-tool', dependencies: { commander: '^12.0.0' } }),
      'utf8',
    );

    expect(isWebAppProject(dir)).toBe(false);
  });

  it('returns true for a directory with a package.json declaring a react dependency (regression, pre-Q4b behavior)', () => {
    const dir = makeTempDir('react-pkg');
    cleanup.push(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' } }),
      'utf8',
    );

    expect(isWebAppProject(dir)).toBe(true);
  });

  it('returns true when both index.html and a non-web package.json are present (index.html widens, never narrows)', () => {
    const dir = makeTempDir('index-plus-nonweb-pkg');
    cleanup.push(dir);
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html></html>', 'utf8');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'game-clone', dependencies: { three: '^0.160.0' } }),
      'utf8',
    );

    expect(isWebAppProject(dir)).toBe(true);
  });

  it('returns false for a non-existent directory', () => {
    const dir = join(tmpdir(), `omniforge-iswebapp-does-not-exist-${Date.now()}`);
    expect(isWebAppProject(dir)).toBe(false);
  });
});
