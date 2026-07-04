import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';

describe('db client', () => {
  it('initializes schema and round-trips a workflow row', () => {
    const db = initDb(':memory:');

    const now = Date.now();
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('wf_test', 'internal', 'test objective', 'pending', now);

    const row = db
      .prepare(
        'SELECT id, workspace, objective, status, created_at FROM workflows WHERE id = ?',
      )
      .get('wf_test') as {
      id: string;
      workspace: string;
      objective: string;
      status: string;
      created_at: number;
    };

    expect(row.id).toBe('wf_test');
    expect(row.workspace).toBe('internal');
    expect(row.objective).toBe('test objective');
    expect(row.status).toBe('pending');
    expect(row.created_at).toBe(now);

    db.close();
  });
});
