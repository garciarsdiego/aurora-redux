import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  createDagDraft,
  deleteDagDraft,
  listDagDrafts,
  loadDagDraft,
  patchDagDraft,
} from '../../src/db/dag-drafts.js';
import type { Dag } from '../../src/types/index.js';

const secretLikeValue = 'sk-test-secret-value-that-must-not-be-stored';

const sampleDag: Dag = {
  tasks: [
    {
      id: 't0',
      name: 'Write report',
      kind: 'llm_call',
      depends_on: [],
      model: 'cc/claude-sonnet-4-6',
    },
  ],
};

describe('dashboard DAG drafts', () => {
  it('creates, loads, and lists a draft without requiring it to become a workflow run', () => {
    const db = initDb(':memory:');

    const draft = createDagDraft(db, {
      workspace: 'internal',
      title: 'Weekly audit',
      objective: 'Build a weekly audit',
      dag: sampleDag,
      source: 'planner',
    });

    expect(draft.id).toMatch(/^draft_/);
    expect(draft.status).toBe('draft');
    expect(draft.dag).toEqual(sampleDag);
    expect(loadDagDraft(db, draft.id)).toEqual(draft);
    expect(listDagDrafts(db, { workspace: 'internal' })).toEqual([draft]);

    const runs = db.prepare("SELECT id FROM workflows WHERE id != '_daemon'").all();
    expect(runs).toHaveLength(0);

    db.close();
  });

  it('patches draft metadata and DAG while preserving the same draft id', () => {
    const db = initDb(':memory:');
    const draft = createDagDraft(db, {
      workspace: 'internal',
      title: 'Initial title',
      objective: 'Initial objective',
      dag: sampleDag,
      source: 'planner',
    });
    const nextDag: Dag = {
      tasks: [
        ...sampleDag.tasks,
        {
          id: 't1',
          name: 'Review report',
          kind: 'llm_call',
          depends_on: ['t0'],
        },
      ],
    };

    const patched = patchDagDraft(db, draft.id, {
      title: 'Patched title',
      objective: 'Patched objective',
      dag: nextDag,
    });

    expect(patched).toMatchObject({
      id: draft.id,
      title: 'Patched title',
      objective: 'Patched objective',
      status: 'draft',
    });
    expect(patched.dag.tasks).toHaveLength(2);
    expect(patched.updated_at).toBeGreaterThanOrEqual(draft.updated_at);

    db.close();
  });

  it('deletes a draft and returns null when reloaded', () => {
    const db = initDb(':memory:');
    const draft = createDagDraft(db, {
      workspace: 'internal',
      title: 'Delete me',
      objective: 'temporary draft',
      dag: sampleDag,
      source: 'planner',
    });

    expect(deleteDagDraft(db, draft.id)).toBe(true);
    expect(loadDagDraft(db, draft.id)).toBeNull();
    expect(deleteDagDraft(db, draft.id)).toBe(false);

    db.close();
  });

  it('redacts obvious secret tokens before storing objective or DAG JSON in SQLite', () => {
    const db = initDb(':memory:');

    const draft = createDagDraft(db, {
      workspace: 'internal',
      title: `token ${secretLikeValue}`,
      objective: `use ${secretLikeValue} for the call`,
      dag: {
        tasks: [
          {
            id: 't0',
            name: `Never persist ${secretLikeValue}`,
            kind: 'llm_call',
            depends_on: [],
          },
        ],
      },
      source: 'planner',
    });

    const raw = db
      .prepare('SELECT title, objective, dag_json FROM dag_drafts WHERE id = ?')
      .get(draft.id) as { title: string; objective: string; dag_json: string };
    expect(raw.title).not.toContain(secretLikeValue);
    expect(raw.objective).not.toContain(secretLikeValue);
    expect(raw.dag_json).not.toContain(secretLikeValue);
    expect(raw.dag_json).toContain('***REDACTED***');

    db.close();
  });
});
