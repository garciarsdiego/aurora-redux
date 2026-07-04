import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Vault } from '../../src/v2/vault/store.js';

let tmpDir: string;
let vault: Vault;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'vault-test-'));
  vault = new Vault(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Vault.write', () => {
  it('writes a file and returns a VaultEntry', async () => {
    const entry = await vault.write('ws1', 'notes/hello.txt', 'Hello, world!');
    expect(entry.path).toBe('notes/hello.txt');
    expect(entry.content).toBe('Hello, world!');
    expect(entry.sizeBytes).toBe(Buffer.byteLength('Hello, world!', 'utf8'));
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.updatedAt).toBeGreaterThanOrEqual(entry.createdAt);
    expect(entry.contentType).toBe('text/plain');
  });

  it('preserves createdAt on subsequent writes', async () => {
    const first = await vault.write('ws1', 'file.md', '# v1');
    await new Promise((r) => setTimeout(r, 5));
    const second = await vault.write('ws1', 'file.md', '# v2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });
});

describe('Vault.read', () => {
  it('reads back the exact content that was written', async () => {
    await vault.write('ws1', 'data.json', '{"key":"value"}');
    const content = await vault.read('ws1', 'data.json');
    expect(content).toBe('{"key":"value"}');
  });

  it('throws when entry does not exist', async () => {
    await expect(vault.read('ws1', 'missing.txt')).rejects.toThrow(/not found/);
  });
});

describe('Vault.list', () => {
  it('lists all entries in a workspace', async () => {
    await vault.write('ws1', 'a.txt', 'aaa');
    await vault.write('ws1', 'b.txt', 'bbb');
    const entries = await vault.list('ws1');
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(['a.txt', 'b.txt']);
  });

  it('filters entries with a glob pattern', async () => {
    await vault.write('ws1', 'notes/a.md', '# A');
    await vault.write('ws1', 'notes/b.md', '# B');
    await vault.write('ws1', 'other.txt', 'other');
    const entries = await vault.list('ws1', 'notes/*.md');
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.path.startsWith('notes/'))).toBe(true);
  });
});

describe('Vault.delete', () => {
  it('deletes an entry and removes it from index', async () => {
    await vault.write('ws1', 'temp.txt', 'bye');
    await vault.delete('ws1', 'temp.txt');
    await expect(vault.read('ws1', 'temp.txt')).rejects.toThrow(/not found/);
    const entries = await vault.list('ws1');
    expect(entries.find((e) => e.path === 'temp.txt')).toBeUndefined();
  });

  it('throws when deleting a non-existent entry', async () => {
    await expect(vault.delete('ws1', 'ghost.txt')).rejects.toThrow(/not found/);
  });
});

describe('Vault.deepMerge', () => {
  it('merges partial object into existing JSON', async () => {
    await vault.write('ws1', 'cfg.json', JSON.stringify({ a: 1, nested: { x: 10, y: 20 } }));
    const entry = await vault.deepMerge('ws1', 'cfg.json', { b: 2, nested: { y: 99 } });
    const merged = JSON.parse(entry.content);
    expect(merged.a).toBe(1);
    expect(merged.b).toBe(2);
    expect(merged.nested.x).toBe(10);
    expect(merged.nested.y).toBe(99);
  });

  it('creates a new file when path does not exist', async () => {
    const entry = await vault.deepMerge('ws1', 'new.json', { hello: 'world' });
    const parsed = JSON.parse(entry.content);
    expect(parsed.hello).toBe('world');
  });
});

describe('Path traversal rejection', () => {
  it('rejects paths containing ".."', async () => {
    await expect(vault.write('ws1', '../escape.txt', 'evil')).rejects.toThrow(
      /traversal|absolute/i
    );
  });

  it('rejects absolute paths', async () => {
    await expect(vault.write('ws1', '/etc/passwd', 'evil')).rejects.toThrow(
      /traversal|absolute/i
    );
  });

  it('rejects embedded traversal segments', async () => {
    await expect(vault.read('ws1', 'safe/../../etc/shadow')).rejects.toThrow(
      /traversal|absolute/i
    );
  });
});

// B9 — pre-validation helper consumed by the worker preHook so the operator
// sees missing inputs as a `vault_input_missing` event before the worker
// spawns and reads "(not found)" placeholders into its prompt.
describe('Vault.checkPaths', () => {
  it('partitions inputs into found / missing buckets', async () => {
    await vault.write('ws1', 'present.md', 'hello');
    const result = await vault.checkPaths('ws1', ['present.md', 'absent.md']);
    expect(result.found).toEqual(['present.md']);
    expect(result.missing).toEqual(['absent.md']);
  });

  it('treats path-traversal attempts as missing (does not throw)', async () => {
    const result = await vault.checkPaths('ws1', ['ok.md', '../escape']);
    // ok.md was never written → also missing; the traversal entry is missing too,
    // but the function returns structured output instead of throwing.
    expect(result.missing).toContain('../escape');
    expect(result.missing).toContain('ok.md');
    expect(result.found).toEqual([]);
  });

  it('returns empty arrays for empty input', async () => {
    const result = await vault.checkPaths('ws1', []);
    expect(result.found).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('isolates per-workspace existence', async () => {
    await vault.write('ws1', 'shared.md', 'a');
    const result = await vault.checkPaths('ws2', ['shared.md']);
    expect(result.missing).toEqual(['shared.md']);
    expect(result.found).toEqual([]);
  });
});
