import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendHistoryEntry,
  loadHistoryEntries,
  rotateHistoryIfNeeded,
  clearHistory,
} from '../../../src/repl/input/history.js';

// Each test gets a unique isolated tmp workspace rooted in a temp directory.
// We override process.cwd() for this by pointing history paths through a
// known tmp root; instead we use a controlled workspace name that resolves
// under os.tmpdir() by patching the file path resolution.

// Strategy: create a tmp dir per test that acts as the project root, then
// chdir into it so historyFilePath() builds correct absolute paths.

let originalCwd: string;
let tmpRoot: string;
const WORKSPACE = 'test-ws';

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omniforge-hist-test-'));
  // Create the workspace directory structure that history.ts expects.
  await fs.mkdir(path.join(tmpRoot, 'workspaces', WORKSPACE), { recursive: true });
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('appendHistoryEntry', () => {
  it('redacts secrets before writing to disk', async () => {
    await appendHistoryEntry(WORKSPACE, {
      ts: 1000,
      raw: 'my key is sk-ant-abc1234567890abcdefghij and token Bearer supersecretlongtokenhere',
      category: 'user',
    });

    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const content = await fs.readFile(filePath, 'utf8');
    // The secret must be absent from disk regardless of which pattern matched it.
    expect(content).not.toContain('sk-ant-abc1234567890abcdefghij');
    expect(content).not.toContain('supersecretlongtokenhere');
    // Either the anthropic-specific or the generic sk- pattern fires — both redact.
    expect(content).toMatch(/\*\*\*REDACTED\*\*\*/);
  });

  it('writes valid JSONL format (1 entry per line, parseable)', async () => {
    await appendHistoryEntry(WORKSPACE, { ts: 2000, raw: 'hello world', category: 'user' });
    await appendHistoryEntry(WORKSPACE, { ts: 3000, raw: 'another command', category: 'system' });

    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toMatchObject({ ts: 2000, raw: 'hello world', category: 'user' });
    expect(parsed[1]).toMatchObject({ ts: 3000, raw: 'another command', category: 'system' });
  });

  it('applies chmod 0600 (best-effort — skips assertion on Windows)', async () => {
    await appendHistoryEntry(WORKSPACE, { ts: 4000, raw: 'chmod test', category: 'user' });

    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const stat = await fs.stat(filePath);

    // On Windows (win32), chmod is a no-op so we skip the mode assertion.
    if (process.platform !== 'win32') {
      // Extract permission bits: mode & 0o777
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
    } else {
      // Just verify the file exists and is readable.
      expect(stat.size).toBeGreaterThan(0);
    }
  });
});

describe('loadHistoryEntries', () => {
  it('returns empty array when file does not exist', async () => {
    const entries = await loadHistoryEntries(WORKSPACE);
    expect(entries).toEqual([]);
  });

  it('skips malformed lines without throwing', async () => {
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const lines = [
      JSON.stringify({ ts: 1, raw: 'valid', category: 'user' }),
      'NOT JSON {{{{',
      JSON.stringify({ ts: 2, raw: 'also valid', category: 'user' }),
      '{"incomplete":',
    ].join('\n') + '\n';
    await fs.writeFile(filePath, lines, 'utf8');

    const entries = await loadHistoryEntries(WORKSPACE);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.raw).toBe('valid');
    expect(entries[1]!.raw).toBe('also valid');
  });

  it('caps output at 1000 entries (returns last 1000)', async () => {
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const lines: string[] = [];
    for (let i = 0; i < 1200; i++) {
      lines.push(JSON.stringify({ ts: i, raw: `cmd-${i}`, category: 'user' }));
    }
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

    const entries = await loadHistoryEntries(WORKSPACE);
    expect(entries).toHaveLength(1000);
    // Should be the last 1000 (entries 200..1199).
    expect(entries[0]!.ts).toBe(200);
    expect(entries[999]!.ts).toBe(1199);
  });

  it('handles file with only whitespace/empty lines gracefully', async () => {
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    await fs.writeFile(filePath, '\n\n   \n\n', 'utf8');
    const entries = await loadHistoryEntries(WORKSPACE);
    expect(entries).toEqual([]);
  });
});

describe('rotateHistoryIfNeeded', () => {
  it('renames file to .repl-history.1 when size exceeds 10MB', async () => {
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    // Write slightly over 10MB of data.
    const chunk = Buffer.alloc(1024 * 1024, 'x'); // 1MB
    const handle = await fs.open(filePath, 'w');
    for (let i = 0; i < 11; i++) {
      await handle.write(chunk);
    }
    await handle.close();

    const rotated = await rotateHistoryIfNeeded(WORKSPACE);
    expect(rotated).toBe(true);

    const rotatedPath = filePath + '.1';
    const rotatedStat = await fs.stat(rotatedPath);
    expect(rotatedStat.size).toBeGreaterThan(10 * 1024 * 1024);

    // Original file should no longer exist (renamed, not copied).
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is a no-op when file is below 10MB', async () => {
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    await fs.writeFile(filePath, JSON.stringify({ ts: 1, raw: 'small', category: 'user' }) + '\n', 'utf8');
    const statBefore = await fs.stat(filePath);

    const rotated = await rotateHistoryIfNeeded(WORKSPACE);
    expect(rotated).toBe(false);

    const statAfter = await fs.stat(filePath);
    expect(statAfter.size).toBe(statBefore.size);

    const rotatedPath = filePath + '.1';
    await expect(fs.stat(rotatedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is a no-op when file does not exist', async () => {
    // Should not throw, and should report no rotation.
    await expect(rotateHistoryIfNeeded(WORKSPACE)).resolves.toBe(false);
  });

  it('FIFO with cap=1: after 3 rotations, only .1 + current exist (no .2)', async () => {
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const r1Path = filePath + '.1';
    const r2Path = filePath + '.2';
    const overCapBytes = 11 * 1024 * 1024; // > 10MB

    for (let round = 0; round < 3; round++) {
      // Write > 10MB.
      const chunk = Buffer.alloc(1024 * 1024, String.fromCharCode(97 + round));
      const handle = await fs.open(filePath, 'w');
      for (let i = 0; i < 11; i++) {
        await handle.write(chunk);
      }
      await handle.close();

      const rotated = await rotateHistoryIfNeeded(WORKSPACE);
      expect(rotated).toBe(true);
    }

    // .1 must exist (most recent backup).
    const r1Stat = await fs.stat(r1Path);
    expect(r1Stat.size).toBeGreaterThanOrEqual(overCapBytes);

    // .2 must NOT exist — FIFO keeps only one backup.
    await expect(fs.stat(r2Path)).rejects.toMatchObject({ code: 'ENOENT' });

    // Original is gone (last rotate moved it to .1).
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans up a stale .2 file left by an older code path', async () => {
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const r2Path = filePath + '.2';

    // Seed a stale .2 from a hypothetical older rotation scheme.
    await fs.writeFile(r2Path, 'stale leftover', 'utf8');

    // Write > 10MB to trigger rotation.
    const chunk = Buffer.alloc(1024 * 1024, 'z');
    const handle = await fs.open(filePath, 'w');
    for (let i = 0; i < 11; i++) {
      await handle.write(chunk);
    }
    await handle.close();

    await rotateHistoryIfNeeded(WORKSPACE);

    // .2 must be gone after rotation.
    await expect(fs.stat(r2Path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('workspace validation (security)', () => {
  it('rejects path traversal: "../../etc"', async () => {
    await expect(
      appendHistoryEntry('../../etc', { ts: 1, raw: 'pwned', category: 'user' }),
    ).rejects.toThrow(/Invalid workspace name/);
  });

  it('rejects absolute path: "/etc/passwd"', async () => {
    await expect(
      appendHistoryEntry('/etc/passwd', { ts: 1, raw: 'pwned', category: 'user' }),
    ).rejects.toThrow(/Invalid workspace name/);
  });

  it('rejects backslash separator: "..\\windows\\system32"', async () => {
    await expect(
      appendHistoryEntry('..\\windows\\system32', { ts: 1, raw: 'pwned', category: 'user' }),
    ).rejects.toThrow(/Invalid workspace name/);
  });

  it('rejects empty string', async () => {
    await expect(
      appendHistoryEntry('', { ts: 1, raw: 'x', category: 'user' }),
    ).rejects.toThrow(/Invalid workspace name/);
  });

  it('rejects whitespace-containing name: "my workspace"', async () => {
    await expect(
      loadHistoryEntries('my workspace'),
    ).rejects.toThrow(/Invalid workspace name/);
  });

  it('rejects dot segments: "."', async () => {
    await expect(
      rotateHistoryIfNeeded('.'),
    ).rejects.toThrow(/Invalid workspace name/);
  });

  it('accepts valid alphanumeric + underscore + hyphen names', async () => {
    // These should NOT throw on validation (they may still ENOENT internally).
    await expect(loadHistoryEntries('valid_ws-123')).resolves.toEqual([]);
  });
});

describe('redaction idempotence', () => {
  it('appending an already-redacted string produces the same on-disk content', async () => {
    // First append with a real-looking secret.
    await appendHistoryEntry(WORKSPACE, {
      ts: 5000,
      raw: 'token sk-ant-1234567890abcdefghijklmn here',
      category: 'user',
    });
    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    const first = await fs.readFile(filePath, 'utf8');
    const firstParsed = JSON.parse(first.trim().split('\n').pop() as string) as { raw: string };

    // Now feed the redacted output back in. Result must equal the first.
    await appendHistoryEntry(WORKSPACE, {
      ts: 6000,
      raw: firstParsed.raw,
      category: 'user',
    });
    const after = await fs.readFile(filePath, 'utf8');
    const lines = after.trim().split('\n');
    const lastParsed = JSON.parse(lines[lines.length - 1]!) as { raw: string };

    // The redacted .raw is unchanged through a second redact pass.
    expect(lastParsed.raw).toBe(firstParsed.raw);
  });
});

describe('clearHistory', () => {
  it('deletes the history file', async () => {
    await appendHistoryEntry(WORKSPACE, { ts: 9999, raw: 'to be cleared', category: 'user' });
    await clearHistory(WORKSPACE);

    const filePath = path.join(tmpRoot, 'workspaces', WORKSPACE, '.repl-history');
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not throw when file does not exist', async () => {
    await expect(clearHistory(WORKSPACE)).resolves.toBeUndefined();
  });
});
