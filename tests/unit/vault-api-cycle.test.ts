import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteVaultEntry,
  readVaultEntry,
  writeVaultEntry,
} from '../../apps/dashboard-v2/src/api.js';

describe('dashboard vault API cycle', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();

    vi.stubGlobal('window', {
      location: { search: '', pathname: '/dashboard/vault', hash: '' },
      history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
      clear: vi.fn(() => {
        storage.clear();
      }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('writes, reads, then deletes a vault entry', async () => {
    const entries = new Map<string, string>();
    const calls: string[] = [];

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const [, workspace, path] = url.pathname.match(/^\/api\/dashboard\/vault\/([^/]+)\/(.+)$/) ?? [];
      if (!workspace || !path) {
        return jsonResponse({ error: 'not found' }, 404);
      }

      const key = `${decodeURIComponent(workspace)}:${decodeURIComponent(path)}`;
      calls.push(`${init?.method ?? 'GET'} ${key}`);

      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body ?? '{}')) as { content?: string };
        entries.set(key, body.content ?? '');
        return jsonResponse({
          workspace: decodeURIComponent(workspace),
          path: decodeURIComponent(path),
          entry: {
            path: decodeURIComponent(path),
            sizeBytes: Buffer.byteLength(body.content ?? '', 'utf8'),
            hash: 'test-hash',
            contentType: 'text/plain',
            updatedAt: 1,
          },
        });
      }

      if (init?.method === 'DELETE') {
        entries.delete(key);
        return jsonResponse({
          deleted: true,
          workspace: decodeURIComponent(workspace),
          path: decodeURIComponent(path),
        });
      }

      if (!entries.has(key)) {
        return jsonResponse({ error: 'vault entry not found' }, 404);
      }
      return jsonResponse({
        workspace: decodeURIComponent(workspace),
        path: decodeURIComponent(path),
        content: entries.get(key),
      });
    }));

    const writeResult = await writeVaultEntry('internal', 'notes/cycle.txt', 'cycle content');
    const readResult = await readVaultEntry('internal', 'notes/cycle.txt');
    const deleteResult = await deleteVaultEntry('internal', 'notes/cycle.txt');

    expect(writeResult.entry.path).toBe('notes/cycle.txt');
    expect(readResult.content).toBe('cycle content');
    expect(deleteResult.deleted).toBe(true);
    await expect(readVaultEntry('internal', 'notes/cycle.txt')).rejects.toThrow(/vault entry not found/);
    expect(calls).toEqual([
      'PUT internal:notes/cycle.txt',
      'GET internal:notes/cycle.txt',
      'DELETE internal:notes/cycle.txt',
      'GET internal:notes/cycle.txt',
    ]);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
