// Week 3 / Task 2.3 — pattern auto-capture integration.
//
// End-to-end test of the runAutoCaptureHook → DB write loop using real
// workflows and tasks (no mocks). Verifies:
//   1. First match returns `matches-similar` and writes a
//      `pattern_auto_capture` event with the right outcome.
//   2. After 3 sibling completions, the next completion mints a new
//      pattern with source='auto-captured' and the right objective_shape.
//   3. Subsequent completions bump the existing pattern's counters
//      instead of creating duplicates.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import { getDbPath } from '../../src/utils/config.js';
import {
  insertWorkflowWithTasks,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import { runAutoCaptureHook } from '../../src/patterns/auto-capture.js';
import { objectiveShape } from '../../src/patterns/shape.js';
import type { Workflow, Task } from '../../src/types/index.js';

const workspace = 'auto_capture_test';

function makeWorkflow(id: string, objective: string): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective,
    pattern_id: null,
    status: 'completed',
    started_at: now - 10_000,
    completed_at: now,
    created_at: now - 10_000,
    created_by: 'auto_capture_test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(wfId: string): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: wfId,
    name: 'task one',
    kind: 'llm_call',
    input_json: '{}',
    output_json: '{"ok": true}',
    status: 'completed',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 1,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: now - 5_000,
    completed_at: now,
    created_at: now - 5_000,
    acceptance_criteria: 'returns content with exit code equals 0',
    refine_count: 0,
    max_refine: 1,
    refine_feedback: null,
    model: null,
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function seedCompletedWorkflow(db: Database.Database, objective: string): string {
  const wfId = newWorkflowId();
  const wf = makeWorkflow(wfId, objective);
  // Mark workflow + task as completed up front so countCompletedSiblings finds them.
  insertWorkflowWithTasks(db, { ...wf, status: 'completed' }, [makeTask(wfId)]);
  return wfId;
}

describe('pattern auto-capture', () => {
  let db: Database.Database;
  const wfIds: string[] = [];

  beforeAll(() => {
    db = initDb(getDbPath());
  });

  beforeEach(() => {
    // Clean state per test so threshold semantics stay deterministic.
    db.prepare(`DELETE FROM events WHERE workflow_id IN (
      SELECT id FROM workflows WHERE workspace = ?
    )`).run(workspace);
    db.prepare(`DELETE FROM tasks WHERE workflow_id IN (
      SELECT id FROM workflows WHERE workspace = ?
    )`).run(workspace);
    db.prepare(`DELETE FROM patterns WHERE workspace = ?`).run(workspace);
    db.prepare(`DELETE FROM workflows WHERE workspace = ?`).run(workspace);
    wfIds.length = 0;
  });

  afterAll(() => {
    db.prepare(`DELETE FROM events WHERE workflow_id IN (
      SELECT id FROM workflows WHERE workspace = ?
    )`).run(workspace);
    db.prepare(`DELETE FROM tasks WHERE workflow_id IN (
      SELECT id FROM workflows WHERE workspace = ?
    )`).run(workspace);
    db.prepare(`DELETE FROM patterns WHERE workspace = ?`).run(workspace);
    db.prepare(`DELETE FROM workflows WHERE workspace = ?`).run(workspace);
    db.close();
  });

  it('first match returns matches-similar with no pattern minted', () => {
    const wfId = seedCompletedWorkflow(db, 'Audit Google Ads account for Acme, 30-day window');
    wfIds.push(wfId);
    const wf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(wfId) as Workflow;

    const result = runAutoCaptureHook(db, wf);
    expect(result.outcome).toBe('matches-similar');
    expect(result.patternId).toBeUndefined();

    const patternCount = (
      db.prepare(`SELECT COUNT(*) c FROM patterns WHERE workspace = ?`).get(workspace) as { c: number }
    ).c;
    expect(patternCount).toBe(0);

    const events = db
      .prepare(`SELECT type FROM events WHERE workflow_id = ?`)
      .all(wfId) as { type: string }[];
    expect(events.some((e) => e.type === 'pattern_auto_capture')).toBe(true);
  });

  it('mints a new pattern after 3 sibling completions and bumps it on next match', () => {
    // Seed 3 completed siblings BEFORE the workflow we run the hook on.
    seedCompletedWorkflow(db, 'Audit Google Ads account for Acme, 30-day window');
    seedCompletedWorkflow(db, 'Audit Google Ads account for Initech, 7-day window');
    seedCompletedWorkflow(db, 'Audit Google Ads account for Globex, 14-day window');

    // The "trigger" workflow itself completes — it sees 3 successful siblings.
    const triggerId = seedCompletedWorkflow(
      db,
      'Audit Google Ads account for Foo Corp, 30-day window',
    );
    const triggerWf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(triggerId) as Workflow;

    const result = runAutoCaptureHook(db, triggerWf);
    expect(result.outcome).toBe('auto-saved-new');
    expect(result.patternId).toBeDefined();

    const pattern = db
      .prepare(`SELECT * FROM patterns WHERE id = ?`)
      .get(result.patternId) as { source: string; objective_shape: string; name: string };
    expect(pattern.source).toBe('auto-captured');
    expect(pattern.objective_shape).toBe(objectiveShape(triggerWf.objective));
    expect(pattern.name.startsWith('auto:')).toBe(true);

    // A 5th workflow with the same shape should bump the existing pattern,
    // not mint a new one.
    const fifthId = seedCompletedWorkflow(
      db,
      'Audit Google Ads account for NewClient, 90-day window',
    );
    const fifthWf = db.prepare('SELECT * FROM workflows WHERE id = ?').get(fifthId) as Workflow;
    const bumpResult = runAutoCaptureHook(db, fifthWf);
    expect(bumpResult.outcome).toBe('bumped-existing');
    expect(bumpResult.patternId).toBe(result.patternId);

    const bumped = db
      .prepare(`SELECT usage_count, success_count FROM patterns WHERE id = ?`)
      .get(result.patternId) as { usage_count: number; success_count: number };
    expect(bumped.usage_count).toBeGreaterThan(0);
    expect(bumped.success_count).toBeGreaterThan(0);

    // Only one pattern total in the workspace — no duplicates.
    const totalPatterns = (
      db.prepare(`SELECT COUNT(*) c FROM patterns WHERE workspace = ?`).get(workspace) as { c: number }
    ).c;
    expect(totalPatterns).toBe(1);
  });

  it('skips capture when workflow already ran from a pattern', () => {
    // Seed a workflow with pattern_id set, then run the hook.
    const wfId = newWorkflowId();
    const wf = makeWorkflow(wfId, 'Audit Google Ads account for Acme, 30-day window');
    insertWorkflowWithTasks(
      db,
      { ...wf, pattern_id: 'pt_existing_xxx', status: 'completed' },
      [makeTask(wfId)],
    );
    const stored = db.prepare('SELECT * FROM workflows WHERE id = ?').get(wfId) as Workflow;
    const result = runAutoCaptureHook(db, stored);
    expect(result.outcome).toBe('already-pattern');

    const patternCount = (
      db.prepare(`SELECT COUNT(*) c FROM patterns WHERE workspace = ?`).get(workspace) as { c: number }
    ).c;
    expect(patternCount).toBe(0);
  });
});
