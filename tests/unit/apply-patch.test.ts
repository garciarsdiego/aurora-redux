// Tests for apply-patch tool. Uses real `git apply` against fixture dirs created
// per-test, so behavior matches production.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { applyPatch, parsePatchPaths } from '../../src/v2/tools/core/apply-patch.js';
import type { ToolContext } from '../../src/v2/tools/registry.js';

function git(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('git', args, { cwd, shell: false });
    p.on('close', (code) => resolve(code ?? -1));
    p.on('error', () => resolve(-1));
  });
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'apply-patch-test-'));
  await git(['init', '-q'], dir);
  await git(['config', 'user.email', 't@t.test'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  return dir;
}

function ctxFor(root: string): ToolContext {
  return {
    workspaceRoot: root,
    workspace: 'test-ws',
    workflowId: 'wf_test',
  };
}

describe('parsePatchPaths', () => {
  it('extracts paths from a `diff --git` patch', () => {
    const patch = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index e69de29..b6fc4c6 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n');
    expect(parsePatchPaths(patch)).toContain('src/foo.ts');
  });

  it('handles raw unified diffs without git header', () => {
    const patch = [
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parsePatchPaths(patch)).toContain('foo.txt');
  });

  it('skips /dev/null markers', () => {
    const patch = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1 @@',
      '+x',
    ].join('\n');
    const paths = parsePatchPaths(patch);
    expect(paths).toContain('new.ts');
    expect(paths).not.toContain('/dev/null');
  });
});

describe('applyPatch', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeRepo();
    await writeFile(join(repo, 'foo.txt'), 'hello\n', 'utf-8');
    await git(['add', '.'], repo);
    await git(['commit', '-q', '-m', 'init'], repo);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('dry-run reports filesChanged without modifying disk', async () => {
    const patch = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+world',
      '',
    ].join('\n');
    const out = await applyPatch({ patch, dryRun: true }, ctxFor(repo));
    expect(out.applied).toBe(false);
    expect(out.message).toContain('dry-run');
    expect(out.filesChanged).toContain('foo.txt');
    expect(await readFile(join(repo, 'foo.txt'), 'utf-8')).toBe('hello\n');
  });

  it('applies a valid patch', async () => {
    const patch = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-hello',
      '+world',
      '',
    ].join('\n');
    const out = await applyPatch({ patch, dryRun: false }, ctxFor(repo));
    expect(out.applied).toBe(true);
    expect(out.filesChanged).toContain('foo.txt');
    // Git on Windows may rewrite LF → CRLF on apply via core.autocrlf; accept both.
    const content = (await readFile(join(repo, 'foo.txt'), 'utf-8')).replace(/\r\n/g, '\n');
    expect(content).toBe('world\n');
  });

  it('rejects patch with bad context (file content does not match)', async () => {
    const patch = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-NONEXISTENT',
      '+world',
      '',
    ].join('\n');
    const out = await applyPatch({ patch, dryRun: false }, ctxFor(repo));
    expect(out.applied).toBe(false);
    expect(out.message.toLowerCase()).toContain('check');
    expect(await readFile(join(repo, 'foo.txt'), 'utf-8')).toBe('hello\n');
  });

  it('rejects patch that escapes workspace via ../', async () => {
    const patch = [
      'diff --git a/../escape.txt b/../escape.txt',
      '--- a/../escape.txt',
      '+++ b/../escape.txt',
      '@@ -0,0 +1 @@',
      '+leak',
      '',
    ].join('\n');
    const out = await applyPatch({ patch, dryRun: true }, ctxFor(repo));
    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/outside workspace/);
  });

  it('rejects patch with absolute path that escapes workspace (drive-letter form)', async () => {
    // Path that triggers the path.isAbsolute() / drive-letter check independently of OS.
    const outsideDrive = process.platform === 'win32'
      ? 'C:/temp/definitely-outside-workspace.txt'
      : '/tmp/definitely-outside-workspace.txt';
    const patch = [
      `diff --git a/${outsideDrive} b/${outsideDrive}`,
      `--- a/${outsideDrive}`,
      `+++ b/${outsideDrive}`,
      '@@ -0,0 +1 @@',
      '+leak',
      '',
    ].join('\n');
    const out = await applyPatch({ patch, dryRun: true }, ctxFor(repo));
    expect(out.applied).toBe(false);
    expect(out.message).toMatch(/outside workspace/);
  });

  it('cleans up tempdir even on failure path', async () => {
    const fsPromises = await import('node:fs/promises');
    const patch = [
      'diff --git a/foo.txt b/foo.txt',
      '--- a/foo.txt',
      '+++ b/foo.txt',
      '@@ -1 +1 @@',
      '-no-match',
      '+world',
      '',
    ].join('\n');
    // Snapshot pre-existing tempdirs from concurrent tests so we only assert on
    // OUR delta — otherwise parallel test workers leak across this assertion.
    const before = new Set(
      (await fsPromises.readdir(tmpdir())).filter((e) =>
        e.startsWith('omniforge-apply-patch-'),
      ),
    );
    await applyPatch({ patch, dryRun: false }, ctxFor(repo));
    // Poll briefly: rm({recursive}) inside applyPatch's finally is awaited, but
    // on Windows the directory entry can linger a few ms after the handle drops.
    await vi.waitFor(
      async () => {
        const after = (await fsPromises.readdir(tmpdir())).filter((e) =>
          e.startsWith('omniforge-apply-patch-'),
        );
        const leftovers = after.filter((e) => !before.has(e));
        expect(leftovers).toEqual([]);
      },
      { timeout: 2000, interval: 50 },
    );
  });
});
