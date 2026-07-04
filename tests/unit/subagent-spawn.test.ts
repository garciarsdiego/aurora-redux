import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { spawnSubagent } from '../../src/v2/subagent/spawn.js';
import { registerSubagentRun, getRunById, markRunStarted } from '../../src/v2/subagent/registry.js';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_RUN_TIMEOUT_SECONDS,
  newSubagentRunId,
} from '../../src/v2/subagent/types.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

interface TestFixture {
  workflowId: string;
  taskId: string;
}

function setupWorkflow(db: Database.Database): TestFixture {
  const workflowId = `wf_test_${Math.random().toString(36).slice(2, 8)}`;
  const taskId = `tk_test_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  db.prepare(
    `INSERT INTO workflows (id, workspace, objective, status, created_at)
     VALUES (?, 'internal', 'test objective', 'pending', ?)`,
  ).run(workflowId, now);

  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, status, depends_on_json,
        max_retries, retry_count, retry_policy, refine_count, max_refine,
        hitl, created_at)
     VALUES (?, ?, 'Test Task', 'llm_call', 'pending', '[]',
             3, 0, 'exponential', 0, 2, 0, ?)`,
  ).run(taskId, workflowId, now);

  return { workflowId, taskId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('spawnSubagent — happy path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns {status:accepted, runId} and persists a pending row', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'do something', depth: 0 },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('accepted');
    expect(typeof result.runId).toBe('string');
    expect(result.runId).toMatch(/^sa_/);

    const row = getRunById(db, result.runId as string);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.task_text).toBe('do something');
    expect(row?.depth).toBe(0);
  });
});

describe('spawnSubagent — depth guard', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns forbidden when depth >= DEFAULT_MAX_DEPTH (no params.maxDepth)', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'deep task', depth: DEFAULT_MAX_DEPTH },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('forbidden');
    expect(result.note).toMatch(/depth/i);

    // No row must have been inserted
    const rows = db.prepare(`SELECT * FROM subagent_runs WHERE task_id = ?`).all(taskId);
    expect(rows).toHaveLength(0);
  });

  it('returns forbidden when depth >= explicit maxDepth', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'too deep', depth: 2, maxDepth: 2 },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('forbidden');
  });

  it('allows depth = maxDepth - 1', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'just within limit', depth: DEFAULT_MAX_DEPTH - 1 },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('accepted');
  });
});

describe('spawnSubagent — max children guard', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns forbidden when parent already has DEFAULT_MAX_CHILDREN active descendants', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    // Create the parent run
    const parentRunId = newSubagentRunId();
    registerSubagentRun(db, {
      runId: parentRunId,
      taskId,
      workflowId,
      depth: 0,
      taskText: 'parent',
    });

    // Pre-populate 5 active (pending) children of parentRunId
    for (let i = 0; i < DEFAULT_MAX_CHILDREN; i++) {
      const childId = newSubagentRunId();
      registerSubagentRun(db, {
        runId: childId,
        taskId,
        workflowId,
        parentRunId,
        depth: 1,
        taskText: `child ${i}`,
      });
    }

    const result = await spawnSubagent(
      db,
      { task: 'one too many', depth: 1 },
      { parentTaskId: taskId, workflowId, parentModel: null, parentRunId },
    );

    expect(result.status).toBe('forbidden');
    expect(result.note).toMatch(/max children/i);
  });

  it('skips the children guard when parentRunId is null', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    // Even if there are many runs for the task, no parent means no cap
    for (let i = 0; i < DEFAULT_MAX_CHILDREN + 2; i++) {
      const childId = newSubagentRunId();
      registerSubagentRun(db, {
        runId: childId,
        taskId,
        workflowId,
        depth: 0,
        taskText: `run ${i}`,
      });
    }

    const result = await spawnSubagent(
      db,
      { task: 'no parent, no cap', depth: 0 },
      { parentTaskId: taskId, workflowId, parentModel: null, parentRunId: null },
    );

    expect(result.status).toBe('accepted');
  });
});

describe('spawnSubagent — model resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('inherits parentModel when params.model is absent', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'inherit model', depth: 0 },
      { parentTaskId: taskId, workflowId, parentModel: 'claude/claude-sonnet-4-6' },
    );

    expect(result.status).toBe('accepted');
    const row = getRunById(db, result.runId as string);
    expect(row?.model).toBe('claude/claude-sonnet-4-6');
  });

  it('overrides parentModel when params.model is supplied', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'override model', depth: 0, model: 'claude/claude-haiku-4-5-20251001' },
      { parentTaskId: taskId, workflowId, parentModel: 'claude/claude-sonnet-4-6' },
    );

    expect(result.status).toBe('accepted');
    const row = getRunById(db, result.runId as string);
    expect(row?.model).toBe('claude/claude-haiku-4-5-20251001');
  });

  it('stores null model when neither params.model nor parentModel is set', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'no model', depth: 0 },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('accepted');
    const row = getRunById(db, result.runId as string);
    expect(row?.model).toBeNull();
  });
});

describe('spawnSubagent — timeout resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('uses DEFAULT_RUN_TIMEOUT_SECONDS when params.timeoutSeconds is absent', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'default timeout', depth: 0 },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('accepted');
    const row = getRunById(db, result.runId as string);
    expect(row?.timeout_seconds).toBe(DEFAULT_RUN_TIMEOUT_SECONDS);
  });

  it('uses explicit params.timeoutSeconds when supplied', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'custom timeout', depth: 0, timeoutSeconds: 60 },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('accepted');
    const row = getRunById(db, result.runId as string);
    expect(row?.timeout_seconds).toBe(60);
  });
});

describe('spawnSubagent — DB error path', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('returns {status:error} on FK violation (invalid taskId) without throwing', async () => {
    const { workflowId } = setupWorkflow(db);

    // parentTaskId references a task that does not exist → FK error
    const result = await spawnSubagent(
      db,
      { task: 'bad task id', depth: 0 },
      { parentTaskId: 'tk_does_not_exist', workflowId, parentModel: null },
    );

    expect(result.status).toBe('error');
    expect(typeof result.error).toBe('string');
    expect((result.error as string).length).toBeGreaterThan(0);
    // Crucially: no row was inserted
    const rows = db.prepare(`SELECT * FROM subagent_runs`).all();
    expect(rows).toHaveLength(0);
  });
});

describe('spawnSubagent — note field', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('accepted result includes the Bloco A.2 note', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    const result = await spawnSubagent(
      db,
      { task: 'noted', depth: 0 },
      { parentTaskId: taskId, workflowId, parentModel: null },
    );

    expect(result.status).toBe('accepted');
    expect(result.note).toContain('Bloco A.2');
  });
});

describe('spawnSubagent — children counted transitively', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
  });

  it('counts grandchildren when checking parent capacity', async () => {
    const { workflowId, taskId } = setupWorkflow(db);

    // Parent A
    const parentId = newSubagentRunId();
    registerSubagentRun(db, { runId: parentId, taskId, workflowId, depth: 0, taskText: 'A' });

    // 3 direct children of A
    for (let i = 0; i < 3; i++) {
      const childId = newSubagentRunId();
      registerSubagentRun(db, {
        runId: childId,
        taskId,
        workflowId,
        parentRunId: parentId,
        depth: 1,
        taskText: `child ${i}`,
      });
    }

    // 2 grandchildren (children of the first child) — total descendants = 5
    const firstChild = db
      .prepare(`SELECT run_id FROM subagent_runs WHERE parent_run_id = ? LIMIT 1`)
      .get(parentId) as { run_id: string };

    for (let i = 0; i < 2; i++) {
      const gcId = newSubagentRunId();
      registerSubagentRun(db, {
        runId: gcId,
        taskId,
        workflowId,
        parentRunId: firstChild.run_id,
        depth: 2,
        taskText: `gc ${i}`,
      });
    }

    // Now spawn another child of A — should be forbidden because 5 descendants active
    const result = await spawnSubagent(
      db,
      { task: 'overflow', depth: 1 },
      { parentTaskId: taskId, workflowId, parentModel: null, parentRunId: parentId },
    );

    expect(result.status).toBe('forbidden');
  });
});
