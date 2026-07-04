/**
 * Unit tests for the external MCP server registry (migration 048).
 *
 * Uses an in-memory SQLite database so each test gets a clean slate
 * with all schema migrations applied via `initDb(':memory:')`. We do
 * NOT exercise the connection layer (`ExternalMcpClient`) here — those
 * are covered by integration tests that spawn a real MCP server.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  listServers,
  getServer,
  addServer,
  updateServer,
  deleteServer,
  setServerActive,
} from '../../src/v2/external-mcp/registry.js';
import { initDb } from '../../src/db/client.js';
import type Database from 'better-sqlite3';

type DB = Database.Database;

function makeDb(): DB {
  return initDb(':memory:');
}

describe('external-mcp registry (CRUD)', () => {
  let db: DB;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  // -- addServer ----------------------------------------------------------

  it('adds a stdio server and returns the persisted row', () => {
    const server = addServer(db, {
      name: 'pal-mcp',
      transport: 'stdio',
      command: '/usr/bin/python',
      args: ['-m', 'pal_mcp.server'],
      env: { PAL_MODEL: 'opus-4-6' },
    });

    expect(server.id).toMatch(/^[0-9a-f]{16}$/);
    expect(server.name).toBe('pal-mcp');
    expect(server.transport).toBe('stdio');
    expect(server.command).toBe('/usr/bin/python');
    expect(server.args).toEqual(['-m', 'pal_mcp.server']);
    expect(server.env).toEqual({ PAL_MODEL: 'opus-4-6' });
    expect(server.url).toBeNull();
    expect(server.bearerEnc).toBeNull();
    expect(server.active).toBe(true);
    expect(server.createdAt).toBeTruthy();
    expect(server.updatedAt).toBeTruthy();
  });

  it('adds an http-sse server with bearer plaintext (encrypted on the way in)', () => {
    const server = addServer(db, {
      name: 'remote-tools',
      transport: 'http-sse',
      url: 'https://mcp.example.com/sse',
      bearer: 'super-secret-token',
    });

    expect(server.transport).toBe('http-sse');
    expect(server.url).toBe('https://mcp.example.com/sse');
    expect(server.command).toBeNull();
    expect(server.args).toBeNull();
    expect(server.env).toBeNull();
    // Bearer is stored encrypted (iv:tag:ct hex envelope) — never plaintext.
    expect(server.bearerEnc).toBeTruthy();
    expect(server.bearerEnc).not.toContain('super-secret-token');
    expect(server.bearerEnc).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  });

  it('rejects stdio config without command via Zod', () => {
    expect(() =>
      addServer(db, { name: 'broken', transport: 'stdio' } as never),
    ).toThrow(/command is required/i);
  });

  it('rejects http-sse config without url via Zod', () => {
    expect(() =>
      addServer(db, { name: 'broken', transport: 'http-sse' } as never),
    ).toThrow(/url is required/i);
  });

  it('rejects mixing transport=stdio with url field', () => {
    expect(() =>
      addServer(db, {
        name: 'broken',
        transport: 'stdio',
        command: '/bin/echo',
        url: 'https://x.com',
      } as never),
    ).toThrow(/url must be null/i);
  });

  it('rejects invalid name characters', () => {
    expect(() =>
      addServer(db, {
        name: 'has spaces',
        transport: 'stdio',
        command: '/bin/echo',
      } as never),
    ).toThrow();
  });

  it('throws DUPLICATE_NAME when adding a server with an existing name', () => {
    addServer(db, {
      name: 'dup',
      transport: 'stdio',
      command: '/bin/echo',
    });
    let caught: unknown;
    try {
      addServer(db, {
        name: 'dup',
        transport: 'stdio',
        command: '/bin/cat',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { code?: string }).code).toBe('DUPLICATE_NAME');
    expect((caught as Error).message).toMatch(/already taken/i);
  });

  // -- listServers --------------------------------------------------------

  it('lists all servers ordered by name (default)', () => {
    addServer(db, { name: 'zeta', transport: 'stdio', command: '/bin/echo' });
    addServer(db, { name: 'alpha', transport: 'stdio', command: '/bin/echo' });
    addServer(db, { name: 'mike', transport: 'stdio', command: '/bin/echo' });

    const servers = listServers(db);
    expect(servers.map((s) => s.name)).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('listServers(activeOnly=true) filters inactive rows', () => {
    addServer(db, { name: 'on', transport: 'stdio', command: '/bin/echo' });
    addServer(db, {
      name: 'off',
      transport: 'stdio',
      command: '/bin/echo',
      active: false,
    });

    const all = listServers(db);
    const activeOnly = listServers(db, true);
    expect(all.map((s) => s.name).sort()).toEqual(['off', 'on']);
    expect(activeOnly.map((s) => s.name)).toEqual(['on']);
  });

  // -- getServer ----------------------------------------------------------

  it('looks up by name', () => {
    addServer(db, { name: 'lookup-test', transport: 'stdio', command: '/x' });
    const found = getServer(db, 'lookup-test');
    expect(found).toBeDefined();
    expect(found?.name).toBe('lookup-test');
  });

  it('looks up by id', () => {
    const inserted = addServer(db, {
      name: 'by-id',
      transport: 'stdio',
      command: '/x',
    });
    const found = getServer(db, inserted.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(inserted.id);
    expect(found?.name).toBe('by-id');
  });

  it('returns undefined for unknown name/id', () => {
    expect(getServer(db, 'does-not-exist')).toBeUndefined();
  });

  // -- updateServer -------------------------------------------------------

  it('patches the command field, leaves others intact', () => {
    const inserted = addServer(db, {
      name: 'patchable',
      transport: 'stdio',
      command: '/old/binary',
      args: ['--old'],
      env: { OLD: '1' },
    });

    const updated = updateServer(db, 'patchable', {
      command: '/new/binary',
    });

    expect(updated.command).toBe('/new/binary');
    // Args/env preserved.
    expect(updated.args).toEqual(['--old']);
    expect(updated.env).toEqual({ OLD: '1' });
    // Timestamps moved forward.
    expect(updated.updatedAt >= inserted.updatedAt).toBe(true);
  });

  it('patches by id as well as by name', () => {
    const inserted = addServer(db, {
      name: 'by-id-patch',
      transport: 'stdio',
      command: '/a',
    });
    const updated = updateServer(db, inserted.id, { command: '/b' });
    expect(updated.id).toBe(inserted.id);
    expect(updated.command).toBe('/b');
  });

  it('explicit null clears args/env', () => {
    addServer(db, {
      name: 'clearme',
      transport: 'stdio',
      command: '/c',
      args: ['x'],
      env: { K: 'v' },
    });
    const updated = updateServer(db, 'clearme', { args: null, env: null });
    expect(updated.args).toBeNull();
    expect(updated.env).toBeNull();
  });

  it('throws when updating a server that does not exist', () => {
    expect(() => updateServer(db, 'ghost', { command: '/x' })).toThrow(
      /not found/i,
    );
  });

  it('re-validates merged row (rejects illegal post-merge state)', () => {
    addServer(db, {
      name: 'merge-test',
      transport: 'stdio',
      command: '/bin/echo',
    });
    // Attempting to set url on a stdio row fails — stdio requires url=null.
    expect(() =>
      updateServer(db, 'merge-test', { url: 'https://x.com' }),
    ).toThrow(/url must be null/i);
  });

  // -- setServerActive ----------------------------------------------------

  it('setServerActive(false) hides the row from the active-only list', () => {
    addServer(db, { name: 'toggleable', transport: 'stdio', command: '/x' });

    setServerActive(db, 'toggleable', false);

    expect(listServers(db, true).map((s) => s.name)).not.toContain(
      'toggleable',
    );
    expect(listServers(db).map((s) => s.name)).toContain('toggleable');
    expect(getServer(db, 'toggleable')?.active).toBe(false);
  });

  it('setServerActive(true) restores visibility', () => {
    addServer(db, {
      name: 'restorable',
      transport: 'stdio',
      command: '/x',
      active: false,
    });

    setServerActive(db, 'restorable', true);

    expect(listServers(db, true).map((s) => s.name)).toContain('restorable');
    expect(getServer(db, 'restorable')?.active).toBe(true);
  });

  it('setServerActive throws when the server is missing', () => {
    expect(() => setServerActive(db, 'nope', true)).toThrow(/not found/i);
  });

  // -- deleteServer -------------------------------------------------------

  it('removes the record and returns true', () => {
    addServer(db, { name: 'goner', transport: 'stdio', command: '/x' });
    expect(deleteServer(db, 'goner')).toBe(true);
    expect(getServer(db, 'goner')).toBeUndefined();
  });

  it('returns false when deleting an unknown row', () => {
    expect(deleteServer(db, 'never-existed')).toBe(false);
  });

  it('deletes by id', () => {
    const inserted = addServer(db, {
      name: 'delete-by-id',
      transport: 'stdio',
      command: '/x',
    });
    expect(deleteServer(db, inserted.id)).toBe(true);
    expect(getServer(db, inserted.id)).toBeUndefined();
  });
});
