/**
 * Aurora-parity Wave 0 (F-LIVE-5): a cli_spawn task that emits prose but writes
 * ZERO files must NOT pass the deterministic gate as hard_success.
 *
 * Covers:
 *   - worktreeStatus(): clean / changed / unavailable (real temp git repos)
 *   - emitBasicReviewOutcome cli_spawn grading: empty, read_only escape hatch,
 *     no-worktree preserves hard_success, clean worktree => soft_failure,
 *     dirty worktree => hard_success.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { worktreeStatus } from '../../src/utils/git-worktree.js';
import { emitBasicReviewOutcome } from '../../src/brain/executor/upstream.js';
import type { Task } from '../../src/types/index.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(dir: string, opts: { dirty?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@local');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(resolve(dir, 'seed.txt'), 'seed');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'seed');
  if (opts.dirty) writeFileSync(resolve(dir, 'new-file.ts'), 'export const x = 1;');
}

// ── DB scaffold for emitBasicReviewOutcome (insertEvent + redaction) ──────────
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, status TEXT, created_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, workflow_id TEXT, workspace TEXT, status TEXT);
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT, task_id TEXT, workspace TEXT,
      type TEXT NOT NULL, payload_json TEXT,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE TABLE secrets (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, key TEXT NOT NULL,
      value_encrypted BLOB NOT NULL, iv BLOB NOT NULL, auth_tag BLOB NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(workspace, key)
    );
  `);
  db.prepare('INSERT INTO workflows(id, workspace, status, created_at) VALUES (?, ?, ?, ?)')
    .run('wf-1', 'internal', 'executing', Date.now());
  return db;
}

function cliTask(inputJson: Record<string, unknown>, fileScope: string[] = ['src/feature.ts']): Task {
  return {
    id: 't1', workflow_id: 'wf-1', name: 'code task', kind: 'cli_spawn',
    input_json: JSON.stringify(inputJson), output_json: null, status: 'completed',
    depends_on: [], executor_hint: null, timeout_seconds: 300, max_retries: 3,
    retry_count: 0, retry_policy: 'exponential', started_at: null, completed_at: null,
    created_at: Date.now(), acceptance_criteria: null,
    file_scope: fileScope,
  } as Task;
}

function latestOutcome(db: Database.Database): { outcome_type: string; feedback?: string } {
  const row = db.prepare("SELECT payload_json FROM events WHERE type = 'task_review_outcome' ORDER BY id DESC LIMIT 1")
    .get() as { payload_json: string };
  return JSON.parse(row.payload_json);
}

const TMP = resolve(process.cwd(), 'data', 'worktrees', '__cli_evidence_test__');
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('worktreeStatus', () => {
  it("returns 'unavailable' for a non-existent path", () => {
    expect(worktreeStatus(resolve(TMP, 'does-not-exist'))).toBe('unavailable');
  });
  it("returns 'clean' for a committed repo with no pending changes", () => {
    const dir = resolve(TMP, 'clean');
    makeRepo(dir);
    expect(worktreeStatus(dir)).toBe('clean');
  });
  it("returns 'changed' when there are uncommitted files", () => {
    const dir = resolve(TMP, 'dirty');
    makeRepo(dir, { dirty: true });
    expect(worktreeStatus(dir)).toBe('changed');
  });
});

describe('emitBasicReviewOutcome — cli_spawn evidence grading', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => db.close());

  it('grades empty output as soft_failure (unchanged)', () => {
    emitBasicReviewOutcome(db, 'wf-1', cliTask({ workspace: 'internal' }), '(empty output)');
    expect(latestOutcome(db).outcome_type).toBe('soft_failure');
  });

  it('preserves hard_success when no worktree exists (cannot tell)', () => {
    // declared file_scope, but the worktree path was never created → unavailable.
    emitBasicReviewOutcome(db, 'wf-1', cliTask({ workspace: 'internal' }), 'I analysed the code and here is my report...');
    expect(latestOutcome(db).outcome_type).toBe('hard_success');
  });

  it('does NOT enforce evidence when the task declared no file_scope (analysis task)', () => {
    const dir = resolve(TMP, 'wf-noscope');
    makeRepo(dir); // clean worktree
    const task = cliTask({ execution_context: { worktree_root: dir } }, []); // no file_scope
    emitBasicReviewOutcome(db, 'wf-1', task, 'Analysis report — reviewed the architecture, no edits intended.');
    expect(latestOutcome(db).outcome_type).toBe('hard_success');
  });

  it('read_only escape hatch keeps hard_success even on a clean worktree', () => {
    const dir = resolve(TMP, 'wf-ro');
    makeRepo(dir); // clean
    const task = cliTask({ read_only: true, execution_context: { worktree_root: dir } });
    emitBasicReviewOutcome(db, 'wf-1', task, 'Read-only analysis output, no files changed.');
    expect(latestOutcome(db).outcome_type).toBe('hard_success');
  });

  it('downgrades to soft_failure when the worktree exists and is CLEAN (talks but no files)', () => {
    const dir = resolve(TMP, 'wf-clean');
    makeRepo(dir); // committed, no pending changes
    const task = cliTask({ execution_context: { worktree_root: dir } });
    emitBasicReviewOutcome(db, 'wf-1', task, 'Sure! Here is how you would implement it: ...');
    const outcome = latestOutcome(db);
    expect(outcome.outcome_type).toBe('soft_failure');
    expect(outcome.feedback).toMatch(/changed no files/i);
  });

  it('keeps hard_success when the worktree has uncommitted file changes', () => {
    const dir = resolve(TMP, 'wf-dirty');
    makeRepo(dir, { dirty: true });
    const task = cliTask({ execution_context: { worktree_root: dir } });
    emitBasicReviewOutcome(db, 'wf-1', task, 'Implemented the feature.');
    expect(latestOutcome(db).outcome_type).toBe('hard_success');
  });
});
