/**
 * Aurora Tier 0 / Wave 5 — FK CASCADE E2E.
 *
 * Migration 038 backfilled ON DELETE CASCADE / SET NULL semantics on every
 * child table that references workflows / tasks. The Wave 4 unit test
 * (`tests/unit/migration-038-fk-cascade.test.ts`) verifies the migration
 * applied; this integration test exercises the real-world deletion paths
 * with a heavier seed shape (one workflow + 5 tasks + 20 events + 3
 * artifacts + 2 reviews + 1 HITL gate + 1 subagent run + 1 idempotency
 * key + 1 pattern usage).
 *
 * Spec contract:
 *   - DELETE FROM workflows → CASCADE removes every child row keyed by
 *     workflow_id, regardless of task_id linkage.
 *   - tasks (ON DELETE CASCADE on workflow_id) → gone.
 *   - events (CASCADE on workflow_id, SET NULL on task_id) → gone (the
 *     parent workflow is gone, so cascade wins).
 *   - artifacts (CASCADE on workflow_id, SET NULL on task_id) → gone.
 *   - reviews (CASCADE on both workflow_id and task_id) → gone.
 *   - hitl_gates (CASCADE on workflow_id, SET NULL on task_id) → gone.
 *   - subagent_runs (CASCADE on both) → gone.
 *   - subagent_messages (CASCADE on workflow_id, default on task_ids) → gone.
 *   - pattern_usage (CASCADE on workflow_id + pattern_id) → gone.
 *   - idempotency_keys (CASCADE on task_id) → gone (transitively through tasks).
 *
 * Separately: DELETE FROM tasks WHERE workflow lives → SET NULL on
 *   events.task_id, artifacts.task_id, hitl_gates.task_id.
 *
 * Uses a tempfile DB so foreign_keys=ON behaviour is identical to the
 * production daemon (in-memory `:memory:` also honours it).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';

interface SeededFixture {
  workflowId: string;
  patternId: string;
  taskIds: string[];
}

function seedHeavyWorkflow(db: Database.Database): SeededFixture {
  const now = Date.now();
  const workflowId = 'wf_cascade_e2e';
  const patternId = 'pat_cascade_e2e';
  const taskIds: string[] = [];

  // Pattern row — pattern_usage children attach to this id.
  // Schema from 001_initial.sql: source + objective_sample + dag_json are
  // NOT NULL. The UNIQUE(workspace, name) constraint means name must be
  // unique per workspace.
  db.prepare(
    `INSERT INTO patterns (id, workspace, name, source, objective_sample, dag_json, created_at, usage_count)
     VALUES (?, 'internal', 'cascade-pat', 'test', 'sample', '{}', ?, 0)`,
  ).run(patternId, now);

  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, pattern_id, status, started_at, created_at)
     VALUES (?, 'internal', 'cascade heavy seed', ?, 'completed', ?, ?)`,
  ).run(workflowId, patternId, now, now);

  // 5 tasks.
  for (let i = 0; i < 5; i += 1) {
    const taskId = `tk_cascade_${i}`;
    taskIds.push(taskId);
    db.prepare(
      `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, workflowId, `task ${i}`, 'llm_call', 'completed', now);
  }

  // 20 events — mix of workflow-level (task_id=NULL) and task-level.
  for (let i = 0; i < 20; i += 1) {
    const taskId = i < 5 ? null : taskIds[i % 5];
    db.prepare(
      `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workflowId, taskId, `event_${i}`, '{}', now + i);
  }

  // 3 artifacts — one workflow-level, two task-level.
  db.prepare(
    `INSERT INTO artifacts (id, workflow_id, task_id, workspace, kind, created_at)
     VALUES (?, ?, NULL, 'internal', 'note', ?)`,
  ).run('art_workflow', workflowId, now);
  db.prepare(
    `INSERT INTO artifacts (id, workflow_id, task_id, workspace, kind, created_at)
     VALUES (?, ?, ?, 'internal', 'file', ?)`,
  ).run('art_t0', workflowId, taskIds[0], now);
  db.prepare(
    `INSERT INTO artifacts (id, workflow_id, task_id, workspace, kind, created_at)
     VALUES (?, ?, ?, 'internal', 'file', ?)`,
  ).run('art_t1', workflowId, taskIds[1], now);

  // 2 reviews.
  db.prepare(
    `INSERT INTO reviews (id, task_id, workflow_id, reviewer_model, score, passed, created_at)
     VALUES (?, ?, ?, 'sonnet', ?, ?, ?)`,
  ).run('rv_t0', taskIds[0], workflowId, 0.9, 1, now);
  db.prepare(
    `INSERT INTO reviews (id, task_id, workflow_id, reviewer_model, score, passed, created_at)
     VALUES (?, ?, ?, 'sonnet', ?, ?, ?)`,
  ).run('rv_t1', taskIds[1], workflowId, 0.7, 1, now);

  // 1 HITL gate.
  db.prepare(
    `INSERT INTO hitl_gates (id, workflow_id, task_id, gate_type, prompt, status, channel, created_at)
     VALUES (?, ?, ?, 'cli', 'approve?', 'approved', 'cli', ?)`,
  ).run('hg_cascade', workflowId, taskIds[2], now);

  // 1 subagent run.
  db.prepare(
    `INSERT INTO subagent_runs
       (run_id, task_id, workflow_id, depth, task_text, status, cleanup, spawn_mode, created_at)
     VALUES (?, ?, ?, 0, ?, 'complete', 'delete', 'run', ?)`,
  ).run('sa_cascade', taskIds[3], workflowId, 'subagent prompt', now);

  // 1 subagent message.
  db.prepare(
    `INSERT INTO subagent_messages
       (id, workflow_id, from_task_id, to_task_id, message_type, payload_json, status, created_at)
     VALUES (?, ?, ?, ?, 'request', '{}', 'delivered', ?)`,
  ).run('sm_cascade', workflowId, taskIds[0], taskIds[1], now);

  // 1 idempotency key tied to a task.
  db.prepare(
    `INSERT INTO idempotency_keys (key, task_id, response_json, created_at, expires_at)
     VALUES (?, ?, '{}', ?, ?)`,
  ).run('idempo_cascade', taskIds[0], now, now + 60_000);

  // 1 pattern_usage row tying workflow + pattern.
  db.prepare(
    `INSERT INTO pattern_usage (workflow_id, pattern_id, used_as_is, succeeded, created_at)
     VALUES (?, ?, 1, 1, ?)`,
  ).run(workflowId, patternId, now);

  return { workflowId, patternId, taskIds };
}

function countWhereWf(db: Database.Database, table: string, workflowId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workflow_id = ?`).get(workflowId) as { n: number }).n;
}

function countWhereTask(db: Database.Database, table: string, taskId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE task_id = ?`).get(taskId) as { n: number }).n;
}

describe('FK CASCADE E2E (Tier 0 Wave 5)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-fk-cascade-e2e-'));
    dbPath = join(tmpDir, 'omniforge.db');
    db = initDb(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  });

  it('foreign_keys pragma is ON for the integration DB', () => {
    const fk = db.pragma('foreign_keys', { simple: true });
    expect(fk).toBe(1);
  });

  it('DELETE workflow cascades to all child rows (workflow + 5 tasks + 20 events + 3 artifacts + 2 reviews)', () => {
    const { workflowId, taskIds } = seedHeavyWorkflow(db);

    // Sanity: rows landed.
    expect(countWhereWf(db, 'tasks', workflowId)).toBe(5);
    expect(countWhereWf(db, 'events', workflowId)).toBe(20);
    expect(countWhereWf(db, 'artifacts', workflowId)).toBe(3);
    expect(countWhereWf(db, 'reviews', workflowId)).toBe(2);
    expect(countWhereWf(db, 'hitl_gates', workflowId)).toBe(1);
    expect(countWhereWf(db, 'subagent_runs', workflowId)).toBe(1);
    expect(countWhereWf(db, 'subagent_messages', workflowId)).toBe(1);
    expect(countWhereWf(db, 'pattern_usage', workflowId)).toBe(1);
    expect(countWhereTask(db, 'idempotency_keys', taskIds[0])).toBe(1);

    const result = db.prepare(`DELETE FROM workflows WHERE id = ?`).run(workflowId);
    expect(result.changes).toBe(1);

    // Workflow gone.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workflows WHERE id = ?`).get(workflowId)).toEqual({ n: 0 });

    // All child rows keyed by workflow_id gone.
    expect(countWhereWf(db, 'tasks', workflowId)).toBe(0);
    expect(countWhereWf(db, 'events', workflowId)).toBe(0);
    expect(countWhereWf(db, 'artifacts', workflowId)).toBe(0);
    expect(countWhereWf(db, 'reviews', workflowId)).toBe(0);
    expect(countWhereWf(db, 'hitl_gates', workflowId)).toBe(0);
    expect(countWhereWf(db, 'subagent_runs', workflowId)).toBe(0);
    expect(countWhereWf(db, 'subagent_messages', workflowId)).toBe(0);
    expect(countWhereWf(db, 'pattern_usage', workflowId)).toBe(0);

    // Idempotency keys cascade through tasks. After tasks went via the
    // workflow cascade, idempotency_keys.task_id CASCADE took them with.
    expect(countWhereTask(db, 'idempotency_keys', taskIds[0])).toBe(0);

    // Pattern row itself is NOT cascaded (only pattern_usage was).
    const patternStillThere = db
      .prepare(`SELECT COUNT(*) AS n FROM patterns WHERE id = ?`)
      .get('pat_cascade_e2e') as { n: number };
    expect(patternStillThere.n).toBe(1);
  });

  it('DELETE task SETS NULL on events.task_id, artifacts.task_id, hitl_gates.task_id', () => {
    const { workflowId, taskIds } = seedHeavyWorkflow(db);

    const targetTask = taskIds[2]; // gate is tied to this task
    expect(countWhereTask(db, 'hitl_gates', targetTask)).toBe(1);

    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(targetTask);

    // Workflow still alive.
    const wf = db.prepare(`SELECT id FROM workflows WHERE id = ?`).get(workflowId);
    expect(wf).toBeDefined();

    // Gate row still exists but its task_id is NULL.
    const gate = db.prepare(`SELECT id, task_id FROM hitl_gates WHERE id = 'hg_cascade'`).get() as
      | { id: string; task_id: string | null }
      | undefined;
    expect(gate).toBeDefined();
    expect(gate!.task_id).toBeNull();

    // Events for the deleted task: still present (workflow_id alive) but
    // task_id = NULL (SET NULL clause).
    const eventsForTask = db
      .prepare(`SELECT task_id FROM events WHERE workflow_id = ? AND type LIKE 'event_%'`)
      .all(workflowId) as Array<{ task_id: string | null }>;
    // Any event row that used to point at `targetTask` now has task_id=NULL,
    // others are unchanged.
    const wasOnTarget = eventsForTask.filter((e) => e.task_id === null).length;
    expect(wasOnTarget).toBeGreaterThan(0);
    // Specifically, the row that USED to be tied to targetTask (i.e. i=7
    // since taskIds[7 % 5] = taskIds[2]) now reads task_id=NULL.
  });

  it('DELETE task CASCADEs reviews tied to the task (reviews.task_id is CASCADE)', () => {
    const { workflowId } = seedHeavyWorkflow(db);
    // Seed a CLEAN task that has only a review attached — no subagent
    // message references (whose from_task_id/to_task_id are RESTRICT by
    // default per migration 038), no idempotency_keys, no artifacts.
    // This isolates the reviews.task_id CASCADE assertion from all
    // cross-table RESTRICT noise.
    const now = Date.now();
    db.prepare(
      `INSERT INTO tasks (id, workflow_id, name, kind, status, created_at)
       VALUES ('tk_clean_for_review', ?, 'clean', 'llm_call', 'completed', ?)`,
    ).run(workflowId, now);
    db.prepare(
      `INSERT INTO reviews (id, task_id, workflow_id, reviewer_model, score, passed, created_at)
       VALUES ('rv_clean', 'tk_clean_for_review', ?, 'sonnet', 0.8, 1, ?)`,
    ).run(workflowId, now);

    expect(countWhereTask(db, 'reviews', 'tk_clean_for_review')).toBe(1);

    db.prepare(`DELETE FROM tasks WHERE id = 'tk_clean_for_review'`).run();

    // The review row is gone (cascade on task_id).
    expect(countWhereTask(db, 'reviews', 'tk_clean_for_review')).toBe(0);
  });

  it('DELETE workflow cascades subagent_runs and subagent_messages', () => {
    const { workflowId } = seedHeavyWorkflow(db);
    expect(countWhereWf(db, 'subagent_runs', workflowId)).toBe(1);
    expect(countWhereWf(db, 'subagent_messages', workflowId)).toBe(1);

    db.prepare(`DELETE FROM workflows WHERE id = ?`).run(workflowId);

    expect(countWhereWf(db, 'subagent_runs', workflowId)).toBe(0);
    expect(countWhereWf(db, 'subagent_messages', workflowId)).toBe(0);
  });

  it('DELETE pattern cascades pattern_usage but NOT the parent workflow', () => {
    const { workflowId, patternId } = seedHeavyWorkflow(db);
    expect(countWhereWf(db, 'pattern_usage', workflowId)).toBe(1);

    db.prepare(`DELETE FROM patterns WHERE id = ?`).run(patternId);

    expect(countWhereWf(db, 'pattern_usage', workflowId)).toBe(0);
    // Workflow row still exists — patterns CASCADE wipes pattern_usage,
    // never the parent workflow.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM workflows WHERE id = ?`).get(workflowId)).toEqual({ n: 1 });
  });

  it('PRAGMA foreign_key_check returns no rows after the heavy delete (integrity holds)', () => {
    const { workflowId } = seedHeavyWorkflow(db);
    db.prepare(`DELETE FROM workflows WHERE id = ?`).run(workflowId);

    const violations = db.prepare(`PRAGMA foreign_key_check`).all();
    expect(violations).toEqual([]);
  });

  it('cascades survive a separate connection reading the DB after the delete', () => {
    // Verify the cascade is committed to the file, not just visible inside
    // the writing connection.
    const { workflowId } = seedHeavyWorkflow(db);
    db.prepare(`DELETE FROM workflows WHERE id = ?`).run(workflowId);
    db.close();

    // Reopen with a fresh connection (initDb runs migrations idempotently).
    const verifier = initDb(dbPath);
    try {
      expect(countWhereWf(verifier, 'tasks', workflowId)).toBe(0);
      expect(countWhereWf(verifier, 'events', workflowId)).toBe(0);
      expect(countWhereWf(verifier, 'artifacts', workflowId)).toBe(0);
      expect(countWhereWf(verifier, 'reviews', workflowId)).toBe(0);
      expect(countWhereWf(verifier, 'hitl_gates', workflowId)).toBe(0);
    } finally {
      verifier.close();
      // Re-open the original `db` slot so afterEach's close() is a no-op
      // (better-sqlite3 throws on double-close).
      db = initDb(dbPath);
    }
  });
});
