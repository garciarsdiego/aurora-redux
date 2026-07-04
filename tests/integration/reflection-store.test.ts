// PHASE-3 / Tasks 3.1-3.3 — reflection store recorder + recaller tests.
//
// Validates the full loop: migration 055 applies, recordReflection writes
// a row, recallReflections finds it back via FTS5, and the formatter
// renders a "## Past run lessons" block ready for the decomposer prompt.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { initDb } from '../../src/db/client.js';
import { getDbPath } from '../../src/utils/config.js';
import {
  insertWorkflowWithTasks,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import {
  recordReflection,
  recallReflections,
  formatReflectionsForPrompt,
} from '../../src/v2/reflection/store.js';
import type { Workflow, Task } from '../../src/types/index.js';

const workspace = 'reflection_test';

function makeWorkflow(id: string, objective: string, status: Workflow['status'] = 'completed'): Workflow {
  const now = Date.now();
  return {
    id,
    workspace,
    objective,
    pattern_id: null,
    status,
    started_at: now - 30_000,
    completed_at: now,
    created_at: now - 30_000,
    created_by: 'reflection_test',
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    max_duration_seconds: null,
    metadata: null,
  };
}

function makeTask(wfId: string, name: string, status: Task['status'] = 'completed'): Task {
  const now = Date.now();
  return {
    id: newTaskId(),
    workflow_id: wfId,
    name,
    kind: 'llm_call',
    input_json: '{}',
    output_json: '{"ok": true}',
    status,
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 1,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: now - 10_000,
    completed_at: now,
    created_at: now - 10_000,
    acceptance_criteria: 'returns ok with exit code 0',
    refine_count: 0,
    max_refine: 1,
    refine_feedback: null,
    model: null,
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

describe('reflection store', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = initDb(getDbPath());
  });

  beforeEach(() => {
    db.prepare(`DELETE FROM reflection_store WHERE workspace = ?`).run(workspace);
    db.prepare(`DELETE FROM tasks WHERE workflow_id IN (
      SELECT id FROM workflows WHERE workspace = ?
    )`).run(workspace);
    db.prepare(`DELETE FROM workflows WHERE workspace = ?`).run(workspace);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM reflection_store WHERE workspace = ?`).run(workspace);
    db.prepare(`DELETE FROM tasks WHERE workflow_id IN (
      SELECT id FROM workflows WHERE workspace = ?
    )`).run(workspace);
    db.prepare(`DELETE FROM workflows WHERE workspace = ?`).run(workspace);
    db.close();
  });

  it('records a reflection on a completed workflow and recalls it via FTS5', () => {
    const wfId = newWorkflowId();
    const wf = makeWorkflow(wfId, 'Audit Google Ads account for Acme, 30-day window');
    insertWorkflowWithTasks(db, wf, [makeTask(wfId, 'Plan'), makeTask(wfId, 'Keyword waste audit')]);

    const tasks = db
      .prepare('SELECT * FROM tasks WHERE workflow_id = ?')
      .all(wfId) as Task[];
    const result = recordReflection(db, wf, tasks);
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^rfl_/);

    const stored = db
      .prepare('SELECT * FROM reflection_store WHERE workflow_id = ?')
      .get(wfId) as { outcome: string; plan_summary: string; lessons_learned: string };
    expect(stored.outcome).toBe('success');
    expect(stored.plan_summary).toContain('task_count');
    expect(stored.lessons_learned).toContain('Completed end-to-end');

    const recalled = recallReflections(db, workspace, 'Audit Google Ads account for some other client');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]!.workflow_id).toBe(wfId);
    expect(recalled[0]!.objective_shape).toContain('audit');
  });

  it('captures failure outcome and surfaces failure-themed lessons', () => {
    const wfId = newWorkflowId();
    const wf = makeWorkflow(wfId, 'Render formatted answer with placeholders', 'failed');
    insertWorkflowWithTasks(db, wf, [makeTask(wfId, 'Plan'), makeTask(wfId, 'Render', 'failed')]);
    const tasks = db.prepare('SELECT * FROM tasks WHERE workflow_id = ?').all(wfId) as Task[];

    const result = recordReflection(db, wf, tasks);
    expect(result.ok).toBe(true);

    const stored = db
      .prepare('SELECT outcome, lessons_learned FROM reflection_store WHERE workflow_id = ?')
      .get(wfId) as { outcome: string; lessons_learned: string };
    expect(stored.outcome).toBe('failure');
    expect(stored.lessons_learned).toContain('Failed');
    expect(stored.lessons_learned).toContain('Render');
  });

  it('formatReflectionsForPrompt produces an empty string when no matches', () => {
    expect(formatReflectionsForPrompt([])).toBe('');
  });

  it('formatReflectionsForPrompt assembles a Past run lessons block', () => {
    const wfId = newWorkflowId();
    const wf = makeWorkflow(wfId, 'Audit Google Ads account for Acme');
    insertWorkflowWithTasks(db, wf, [makeTask(wfId, 'Plan')]);
    const tasks = db.prepare('SELECT * FROM tasks WHERE workflow_id = ?').all(wfId) as Task[];
    recordReflection(db, wf, tasks);

    const recalled = recallReflections(db, workspace, 'Audit Google Ads account for NewClient');
    const block = formatReflectionsForPrompt(recalled);
    expect(block).toContain('## Past run lessons');
    expect(block).toContain('success');
    expect(block).toContain('Audit Google Ads account for Acme');
  });

  it('returns empty array when no FTS match in this workspace', () => {
    const recalled = recallReflections(db, workspace, 'Totally unrelated objective xyzzy plugh');
    expect(recalled).toHaveLength(0);
  });
});
