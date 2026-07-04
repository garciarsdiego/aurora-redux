import { describe, it, expect } from 'vitest';
import { initDb } from '../../src/db/client.js';
import type Database from 'better-sqlite3';

/**
 * Migration 038 — FK ON DELETE backfill.
 *
 * Verifies that after migrations 001..038 have run, deleting a workflow or a
 * task triggers the correct cascading behavior on every child table called
 * out in the migration spec.
 *
 * Each test uses a fresh in-memory DB so there is no cross-pollination
 * between assertions and we can rely on autoincrement starting from 1.
 */

interface SeededWorkflow {
  workflowId: string;
  taskAId: string;
  taskBId: string;
}

const HOUR = 60 * 60 * 1000;

function seedWorkflowWithTasks(db: Database.Database, suffix = ''): SeededWorkflow {
  const now = Date.now();
  const workflowId = `wf_038_${suffix}`;
  const taskAId = `tk_a_${suffix}`;
  const taskBId = `tk_b_${suffix}`;

  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(workflowId, 'internal', 'cascade test', 'pending', now);

  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskAId, workflowId, 'task-a', 'llm_call', 'pending', now);

  db.prepare(
    `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(taskBId, workflowId, 'task-b', 'tool_call', 'pending', now);

  return { workflowId, taskAId, taskBId };
}

describe('migration 038 — FK ON DELETE backfill', () => {
  it('applies migration 038 and confirms it is recorded', () => {
    const db = initDb(':memory:');

    const row = db
      .prepare('SELECT id FROM schema_migrations WHERE id = ?')
      .get('038_fk_cascade_backfill') as { id: string } | undefined;

    expect(row?.id).toBe('038_fk_cascade_backfill');

    db.close();
  });

  it('preserves the FK enforcement pragma after migration runs', () => {
    const db = initDb(':memory:');
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
    db.close();
  });

  it('cascades workflow delete to tasks/events/artifacts/reviews', () => {
    const db = initDb(':memory:');
    const { workflowId, taskAId } = seedWorkflowWithTasks(db);
    const now = Date.now();

    // workflow-level event (task_id NULL).
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, NULL, ?, ?, ?)`,
    ).run(workflowId, 'workflow_started', '{}', now);

    // task-level event.
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workflowId, taskAId, 'task_started', '{}', now);

    db.prepare(
      `INSERT INTO artifacts (id, workflow_id, task_id, workspace, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('art_1', workflowId, taskAId, 'internal', 'note', now);

    db.prepare(
      `INSERT INTO reviews (id, task_id, workflow_id, reviewer_model, score, passed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('rv_1', taskAId, workflowId, 'sonnet', 0.9, 1, now);

    db.prepare(
      `INSERT INTO hitl_gates (id, workflow_id, task_id, gate_type, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('gate_1', workflowId, taskAId, 'approve', 'ok?', 'pending', now);

    db.prepare(
      `INSERT INTO idempotency_keys (key, task_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run('idem_1', taskAId, now, now + HOUR);

    // Sanity: rows exist before the delete.
    const beforeTasks = db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?')
      .get(workflowId) as { n: number };
    expect(beforeTasks.n).toBe(2);

    db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);

    // Workflow-scoped CASCADE expectations.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workflow_id = ?').get(workflowId) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM events WHERE workflow_id = ?').get(workflowId) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE workflow_id = ?').get(workflowId) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE workflow_id = ?').get(workflowId) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM hitl_gates WHERE workflow_id = ?').get(workflowId) as { n: number }).n,
    ).toBe(0);

    // idempotency_keys cascades via tasks (task → CASCADE).
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE task_id = ?').get(taskAId) as { n: number }).n,
    ).toBe(0);

    db.close();
  });

  it('SET NULL on events.task_id when task deleted but workflow lives', () => {
    const db = initDb(':memory:');
    const { workflowId, taskAId } = seedWorkflowWithTasks(db, 'evt');
    const now = Date.now();

    // Two events: one workflow-level (task_id NULL), one tied to task A.
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, NULL, ?, ?, ?)`,
    ).run(workflowId, 'workflow_started', '{}', now);

    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workflowId, taskAId, 'task_started', '{}', now + 1);

    // Delete just the task (workflow stays alive).
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskAId);

    const events = db
      .prepare('SELECT type, task_id FROM events WHERE workflow_id = ? ORDER BY timestamp')
      .all(workflowId) as Array<{ type: string; task_id: string | null }>;

    expect(events).toHaveLength(2);
    // Both rows still present, but task-tied event has task_id reset to NULL.
    expect(events[0]).toMatchObject({ type: 'workflow_started', task_id: null });
    expect(events[1]).toMatchObject({ type: 'task_started', task_id: null });

    db.close();
  });

  it('SET NULL on artifacts.task_id and hitl_gates.task_id when task deleted', () => {
    const db = initDb(':memory:');
    const { workflowId, taskAId } = seedWorkflowWithTasks(db, 'art');
    const now = Date.now();

    db.prepare(
      `INSERT INTO artifacts (id, workflow_id, task_id, workspace, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('art_1', workflowId, taskAId, 'internal', 'note', now);

    db.prepare(
      `INSERT INTO hitl_gates (id, workflow_id, task_id, gate_type, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('gate_1', workflowId, taskAId, 'approve', 'ok?', 'pending', now);

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskAId);

    const art = db
      .prepare('SELECT id, task_id, workflow_id FROM artifacts WHERE id = ?')
      .get('art_1') as { id: string; task_id: string | null; workflow_id: string } | undefined;
    expect(art).toBeDefined();
    expect(art?.task_id).toBeNull();
    expect(art?.workflow_id).toBe(workflowId);

    const gate = db
      .prepare('SELECT id, task_id, workflow_id FROM hitl_gates WHERE id = ?')
      .get('gate_1') as { id: string; task_id: string | null; workflow_id: string } | undefined;
    expect(gate).toBeDefined();
    expect(gate?.task_id).toBeNull();
    expect(gate?.workflow_id).toBe(workflowId);

    db.close();
  });

  it('CASCADE on reviews and idempotency_keys when task deleted', () => {
    const db = initDb(':memory:');
    const { workflowId, taskAId } = seedWorkflowWithTasks(db, 'rv');
    const now = Date.now();

    db.prepare(
      `INSERT INTO reviews (id, task_id, workflow_id, reviewer_model, score, passed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('rv_1', taskAId, workflowId, 'sonnet', 0.9, 1, now);

    db.prepare(
      `INSERT INTO idempotency_keys (key, task_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    ).run('idem_1', taskAId, now, now + HOUR);

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskAId);

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE task_id = ?').get(taskAId) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys WHERE task_id = ?').get(taskAId) as { n: number }).n,
    ).toBe(0);

    db.close();
  });

  it('CASCADE on pattern_usage when workflow deleted', () => {
    const db = initDb(':memory:');
    const now = Date.now();

    db.prepare(
      `INSERT INTO patterns (id, workspace, name, source, objective_sample, dag_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('pat_1', 'internal', 'sample', 'manual', 'demo objective', '{"tasks":[]}', now);

    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('wf_pu', 'internal', 'pu test', 'pending', now);

    db.prepare(
      `INSERT INTO pattern_usage (workflow_id, pattern_id, used_as_is, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('wf_pu', 'pat_1', 1, now);

    db.prepare('DELETE FROM workflows WHERE id = ?').run('wf_pu');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM pattern_usage WHERE workflow_id = ?').get('wf_pu') as { n: number }).n,
    ).toBe(0);

    // Pattern itself is untouched.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM patterns WHERE id = ?').get('pat_1') as { n: number }).n,
    ).toBe(1);

    db.close();
  });

  it('CASCADE on pattern_usage when pattern deleted', () => {
    const db = initDb(':memory:');
    const now = Date.now();

    db.prepare(
      `INSERT INTO patterns (id, workspace, name, source, objective_sample, dag_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('pat_2', 'internal', 'sample-2', 'manual', 'demo objective', '{"tasks":[]}', now);

    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('wf_p2', 'internal', 'pu test 2', 'pending', now);

    db.prepare(
      `INSERT INTO pattern_usage (workflow_id, pattern_id, used_as_is, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('wf_p2', 'pat_2', 1, now);

    db.prepare('DELETE FROM patterns WHERE id = ?').run('pat_2');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM pattern_usage WHERE pattern_id = ?').get('pat_2') as { n: number }).n,
    ).toBe(0);

    // Workflow itself is untouched (pattern_usage was the only link).
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM workflows WHERE id = ?').get('wf_p2') as { n: number }).n,
    ).toBe(1);

    db.close();
  });

  it('CASCADE on subagent_runs when workflow or task deleted', () => {
    const db = initDb(':memory:');
    const { workflowId, taskAId } = seedWorkflowWithTasks(db, 'sa');
    const now = Date.now();

    db.prepare(
      `INSERT INTO subagent_runs (run_id, task_id, workflow_id, task_text, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('sar_1', taskAId, workflowId, 'sub run', now);

    db.prepare(
      `INSERT INTO subagent_messages (id, workflow_id, from_task_id, message_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sam_1', workflowId, taskAId, 'request', '{}', now);

    db.prepare('DELETE FROM workflows WHERE id = ?').run(workflowId);

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM subagent_runs WHERE workflow_id = ?').get(workflowId) as { n: number }).n,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM subagent_messages WHERE workflow_id = ?').get(workflowId) as { n: number }).n,
    ).toBe(0);

    db.close();
  });

  it('preserves all original columns added by migrations 002..036 on rebuilt tables', () => {
    const db = initDb(':memory:');

    function colNames(table: string): string[] {
      const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
      return rows.map(r => r.name);
    }

    // Subset assertions: each column added via a later migration must still be
    // present after the rebuild (we are not deleting columns, just changing FKs).
    const taskCols = colNames('tasks');
    for (const c of [
      'hitl', 'input_tokens', 'output_tokens', 'model_used',
      'tool_name', 'steer_instruction', 'execution_mode', 'replay_of',
    ]) {
      expect(taskCols).toContain(c);
    }

    const hitlCols = colNames('hitl_gates');
    expect(hitlCols).toContain('task_id');
    expect(hitlCols).toContain('resolved_by_actor');

    db.close();
  });
});
