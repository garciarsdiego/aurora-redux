import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glob, type GlobInput } from '../../src/v2/tools/core/glob.js';
import type { ToolContext } from '../../src/v2/tools/registry.js';

let sandboxDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  sandboxDir = await mkdtemp(join(tmpdir(), 'glob-test-'));
  ctx = { workspaceRoot: sandboxDir, workspace: '__test__', workflowId: 'wf_test' };
  // Create fixture files
  await writeFile(join(sandboxDir, 'a.ts'), 'const a = 1;');
  await writeFile(join(sandboxDir, 'b.ts'), 'const b = 2;');
  await writeFile(join(sandboxDir, 'c.js'), 'const c = 3;');
  await mkdir(join(sandboxDir, 'sub'));
  await writeFile(join(sandboxDir, 'sub', 'd.ts'), 'const d = 4;');
  // Create ignored directories
  await mkdir(join(sandboxDir, 'node_modules'));
  await writeFile(join(sandboxDir, 'node_modules', 'pkg.ts'), 'ignored');
  await mkdir(join(sandboxDir, 'dist'));
  await writeFile(join(sandboxDir, 'dist', 'out.ts'), 'ignored');
});

afterEach(async () => {
  await rm(sandboxDir, { recursive: true, force: true });
});

describe('glob', () => {
  it('simple *.ts pattern finds top-level ts files', async () => {
    const result = await glob({ pattern: '*.ts', maxResults: 1000 }, ctx);
    expect(result.truncated).toBe(false);
    expect(result.matches).toContain('a.ts');
    expect(result.matches).toContain('b.ts');
    expect(result.matches).not.toContain('c.js');
  });

  it('recursive **/*.ts finds files in subdirectories', async () => {
    const result = await glob({ pattern: '**/*.ts', maxResults: 1000 }, ctx);
    expect(result.truncated).toBe(false);
    expect(result.matches).toContain('a.ts');
    expect(result.matches).toContain('b.ts');
    // sub/d.ts should be found (exact format may vary by OS)
    const hasSubFile = result.matches.some((m) => m.includes('d.ts'));
    expect(hasSubFile).toBe(true);
  });

  it('default ignore excludes node_modules and dist', async () => {
    const result = await glob({ pattern: '**/*.ts', maxResults: 1000 }, ctx);
    expect(result.matches).not.toContain('node_modules/pkg.ts');
    expect(result.matches).not.toContain('dist/out.ts');
    expect(result.matches.some((m) => m.includes('node_modules'))).toBe(false);
    expect(result.matches.some((m) => m.includes('dist'))).toBe(false);
  });

  it('custom ignore excludes specified directories', async () => {
    const result = await glob({ pattern: '**/*.ts', ignore: ['sub/**'], maxResults: 1000 }, ctx);
    expect(result.matches.some((m) => m.includes('d.ts'))).toBe(false);
    expect(result.matches).toContain('a.ts');
  });

  it('maxResults truncates and sets truncated: true', async () => {
    const result = await glob({ pattern: '**/*.ts', maxResults: 1 }, ctx);
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBe(1);
  });

  it('path outside workspace throws', async () => {
    const input: GlobInput = { pattern: '*.ts', path: '/tmp', maxResults: 1000 };
    await expect(glob(input, ctx)).rejects.toThrow('escapes workspace sandbox');
  });

  it('empty matches returns { matches: [], truncated: false }', async () => {
    const result = await glob({ pattern: '*.xyz', maxResults: 1000 }, ctx);
    expect(result).toEqual({ matches: [], truncated: false });
  });

  it('path relative to workspace root works', async () => {
    const result = await glob({ pattern: '*.ts', path: 'sub', maxResults: 1000 }, ctx);
    expect(result.matches).toContain('d.ts');
    expect(result.matches).not.toContain('a.ts');
  });
});
