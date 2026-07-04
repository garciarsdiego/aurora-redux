import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { getDbPath } from '../../src/utils/config.js';

describe('Workspace Management Integration', () => {
  const testWorkspace = 'integration_test_workspace';
  const testWorkspace2 = 'integration_test_workspace_2';

  beforeAll(() => {
    const db = initDb(getDbPath());
    const now = Date.now();

    try {
      // Clean up any existing test workspaces
      db.prepare(`DELETE FROM dashboard_workspaces WHERE name IN (?, ?)`).run(testWorkspace, testWorkspace2);

      // Insert test workspaces
      db.prepare(
        `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
         VALUES (?, ?, 'integration_test', ?)`,
      ).run(testWorkspace, now, JSON.stringify({ test: true }));

      db.prepare(
        `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
         VALUES (?, ?, 'integration_test', ?)`,
      ).run(testWorkspace2, now, JSON.stringify({ test: true }));
    } finally {
      db.close();
    }
  });

  afterAll(() => {
    const db = initDb(getDbPath());
    
    try {
      db.prepare(`DELETE FROM dashboard_workspaces WHERE name IN (?, ?)`).run(testWorkspace, testWorkspace2);
    } finally {
      db.close();
    }
  });

  it('creates workspace with metadata', () => {
    const db = initDb(getDbPath());
    
    try {
      const workspace = db
        .prepare('SELECT * FROM dashboard_workspaces WHERE name = ?')
        .get(testWorkspace) as any;
      
      expect(workspace).toBeDefined();
      expect(workspace.name).toBe(testWorkspace);
      expect(workspace.created_by).toBe('integration_test');
      
      const metadata = JSON.parse(workspace.metadata_json);
      expect(metadata.test).toBe(true);
    } finally {
      db.close();
    }
  });

  it('lists all workspaces', () => {
    const db = initDb(getDbPath());
    
    try {
      const workspaces = db
        .prepare('SELECT * FROM dashboard_workspaces WHERE name IN (?, ?)')
        .all(testWorkspace, testWorkspace2);
      
      expect(workspaces).toHaveLength(2);
      expect(workspaces.map((w: any) => w.name)).toContain(testWorkspace);
      expect(workspaces.map((w: any) => w.name)).toContain(testWorkspace2);
    } finally {
      db.close();
    }
  });

  it('updates workspace metadata', () => {
    const db = initDb(getDbPath());
    
    try {
      const newMetadata = JSON.stringify({ test: true, updated: true });
      
      db.prepare(
        `UPDATE dashboard_workspaces SET metadata_json = ? WHERE name = ?`,
      ).run(newMetadata, testWorkspace);
      
      const workspace = db
        .prepare('SELECT * FROM dashboard_workspaces WHERE name = ?')
        .get(testWorkspace) as any;
      
      const metadata = JSON.parse(workspace.metadata_json);
      expect(metadata.updated).toBe(true);
    } finally {
      db.close();
    }
  });

  it('enforces workspace name uniqueness', () => {
    const db = initDb(getDbPath());

    try {
      // Inserting a duplicate workspace name must throw via UNIQUE constraint.
      expect(() =>
        db.prepare(
          `INSERT INTO dashboard_workspaces (name, created_at, created_by, metadata_json)
           VALUES (?, ?, 'integration_test', ?)`,
        ).run(testWorkspace, Date.now(), JSON.stringify({ duplicate: true })),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('deletes workspace', () => {
    const db = initDb(getDbPath());
    
    try {
      // Delete testWorkspace2
      db.prepare(`DELETE FROM dashboard_workspaces WHERE name = ?`).run(testWorkspace2);
      
      const workspace = db
        .prepare('SELECT * FROM dashboard_workspaces WHERE name = ?')
        .get(testWorkspace2);
      
      expect(workspace).toBeUndefined();
    } finally {
      db.close();
    }
  });
});