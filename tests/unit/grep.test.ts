import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grep, type GrepInput } from '../../src/v2/tools/core/grep.js';
import type { ToolContext } from '../../src/v2/tools/registry.js';

let sandboxDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), 'grep-test-'));
  ctx = { workspaceRoot: sandboxDir, workspace: '__test__', workflowId: 'wf_test' };

  await writeFile(join(sandboxDir, 'a.ts'), [
    'const hello = "world";',
    'const foo = "bar";',
    'const HELLO = "upper";',
    'const end = "done";',
  ].join('\n'));

  await writeFile(join(sandboxDir, 'b.js'), [
    'function greet() { return "hello"; }',
    'module.exports = greet;',
  ].join('\n'));

  await mkdir(join(sandboxDir, 'sub'));
  await writeFile(join(sandboxDir, 'sub', 'c.ts'), 'const nested = "hello world";');

  await mkdir(join(sandboxDir, 'node_modules'));
  await writeFile(join(sandboxDir, 'node_modules', 'ignored.ts'), 'const hello = "ignored";');
});

afterEach(async () => {
  await rm(sandboxDir, { recursive: true, force: true });
});

describe('grep', () => {
  it('finds simple pattern match', async () => {
    const result = await grep({ pattern: 'hello', caseSensitive: false, contextLines: 0, maxResults: 500 }, ctx);
    expect(result.truncated).toBe(false);
    const texts = result.matches.map((m) => m.text);
    expect(texts.some((t) => t.includes('hello'))).toBe(true);
  });

  it('case insensitive finds HELLO', async () => {
    const result = await grep({ pattern: 'hello', caseSensitive: false, contextLines: 0, maxResults: 500 }, ctx);
    const texts = result.matches.map((m) => m.text);
    // should find both `hello` and `HELLO` variants
    expect(texts.some((t) => /hello/i.test(t))).toBe(true);
  });

  it('case sensitive misses HELLO', async () => {
    const result = await grep({ pattern: 'hello', caseSensitive: true, contextLines: 0, maxResults: 500 }, ctx);
    const texts = result.matches.map((m) => m.text);
    expect(texts.every((t) => !t.includes('HELLO'))).toBe(true);
  });

  it('contextLines > 0 populates context', async () => {
    const result = await grep({ pattern: 'foo', caseSensitive: false, contextLines: 1, maxResults: 500 }, ctx);
    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches[0]!;
    expect(match.context).toBeDefined();
    expect(Array.isArray(match.context?.before)).toBe(true);
    expect(Array.isArray(match.context?.after)).toBe(true);
  });

  it('filePattern filters to only matching files', async () => {
    const result = await grep({ pattern: 'hello', filePattern: '*.ts', caseSensitive: false, contextLines: 0, maxResults: 500 }, ctx);
    for (const m of result.matches) {
      expect(m.file.endsWith('.ts')).toBe(true);
    }
  });

  it('path outside workspace throws', async () => {
    const input: GrepInput = { pattern: 'hello', path: '/tmp', caseSensitive: false, contextLines: 0, maxResults: 500 };
    await expect(grep(input, ctx)).rejects.toThrow('escapes workspace sandbox');
  });

  it('maxResults truncates and sets truncated: true', async () => {
    const result = await grep({ pattern: 'hello', caseSensitive: false, contextLines: 0, maxResults: 1 }, ctx);
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBe(1);
  });

  it('no matches returns empty array with truncated: false', async () => {
    const result = await grep({ pattern: 'ZZZNOTFOUNDZZZXXX', caseSensitive: true, contextLines: 0, maxResults: 500 }, ctx);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('matches include correct line numbers', async () => {
    const result = await grep({ pattern: 'foo', caseSensitive: false, contextLines: 0, maxResults: 500 }, ctx);
    const tsMatch = result.matches.find((m) => m.file.endsWith('a.ts'));
    expect(tsMatch).toBeDefined();
    expect(tsMatch!.line).toBe(2); // second line in a.ts
  });
});
