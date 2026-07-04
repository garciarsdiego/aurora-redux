import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inferProjectDir,
  detectProjectType,
  detectProject,
  getValidationCommand,
} from '../../src/brain/projectDetector.js';

describe('inferProjectDir', () => {
  it('extracts Windows path with drive letter and forward slashes', () => {
    const obj =
      'Criar projeto em C:/Users/Example User/Desktop/foo/ com arquivos no disco.';
    expect(inferProjectDir(obj)).toBe('C:/Users/Example User/Desktop/foo');
  });

  it('extracts Windows path with backslashes', () => {
    const obj = 'Path is C:\\Users\\x\\project\\ please';
    expect(inferProjectDir(obj)).toBe('C:\\Users\\x\\project');
  });

  it('extracts POSIX absolute path', () => {
    const obj = 'Write files to /home/diego/mything next.';
    expect(inferProjectDir(obj)).toBe('/home/diego/mything');
  });

  it('returns null for prose without any path', () => {
    const obj = 'Write a LinkedIn post about AI trends in 2026.';
    expect(inferProjectDir(obj)).toBeNull();
  });

  // D35 regression — real run had `.../linkedin-extractor-v3/. O projeto` and
  // the old regex required whitespace after the trailing slash, skipping path
  // extraction entirely. POSIX fallback then matched `/Users/Example` by accident.
  it('extracts Windows path when trailing separator is immediately followed by sentence punctuation', () => {
    const obj =
      'Corrigir projeto em C:/Users/Example User/Desktop/linkedin-extractor-v3/. O projeto já foi gerado mas tem erros.';
    expect(inferProjectDir(obj)).toBe('C:/Users/Example User/Desktop/linkedin-extractor-v3');
  });

  it('returns null when a Windows drive reference has no trailing separator (POSIX fallback guard)', () => {
    // Windows path without trailing separator can't be safely bounded when it
    // contains spaces. Returning null is better than letting POSIX match a
    // fragment like `/Users/Example` which existsSync resolves on Windows.
    const obj = 'mention of C:\\Users\\Example mid-sentence';
    expect(inferProjectDir(obj)).toBeNull();
  });
});

describe('detectProjectType', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omniforge-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns typescript when both package.json and tsconfig.json exist', () => {
    writeFileSync(join(tmpRoot, 'package.json'), '{}');
    writeFileSync(join(tmpRoot, 'tsconfig.json'), '{}');
    expect(detectProjectType(tmpRoot)).toBe('typescript');
  });

  it('returns javascript when only package.json exists', () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'x', type: 'module' }),
    );
    expect(detectProjectType(tmpRoot)).toBe('javascript');
  });

  it('returns python when requirements.txt exists', () => {
    writeFileSync(join(tmpRoot, 'requirements.txt'), 'pytest\n');
    expect(detectProjectType(tmpRoot)).toBe('python');
  });

  it('returns python when pyproject.toml exists', () => {
    writeFileSync(join(tmpRoot, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(detectProjectType(tmpRoot)).toBe('python');
  });

  it('returns other when directory is empty of known markers', () => {
    writeFileSync(join(tmpRoot, 'README.md'), '# hi');
    expect(detectProjectType(tmpRoot)).toBe('other');
  });

  it('returns null when directory does not exist', () => {
    expect(detectProjectType(join(tmpRoot, 'nope'))).toBeNull();
  });

  it('returns null for non-absolute path', () => {
    expect(detectProjectType('relative/path')).toBeNull();
  });
});

describe('detectProject', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'omniforge-test-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns detected project when path + markers present', () => {
    writeFileSync(join(tmpRoot, 'package.json'), '{}');
    writeFileSync(join(tmpRoot, 'tsconfig.json'), '{}');
    const obj = `Criar projeto em ${tmpRoot}/ please.`;
    const result = detectProject(obj);
    expect(result).toBeTruthy();
    expect(result?.type).toBe('typescript');
  });

  it('returns null when no path in objective', () => {
    expect(detectProject('Write a blog post about AI.')).toBeNull();
  });

  it('returns null when path does not exist', () => {
    expect(
      detectProject('Write to /nonexistent/path/xyz for testing.'),
    ).toBeNull();
  });
});

describe('getValidationCommand', () => {
  it('returns tsc command for typescript', () => {
    const cmd = getValidationCommand('typescript')!;
    expect(cmd).toContain('pnpm install');
    expect(cmd).toContain('tsc --noEmit');
  });

  it('returns install + node check for javascript', () => {
    const cmd = getValidationCommand('javascript')!;
    expect(cmd).toContain('pnpm install');
  });

  it('returns python compileall for python', () => {
    const cmd = getValidationCommand('python')!;
    expect(cmd).toContain('python');
    expect(cmd).toContain('compileall');
  });

  it('returns null for other', () => {
    expect(getValidationCommand('other')).toBeNull();
  });
});
