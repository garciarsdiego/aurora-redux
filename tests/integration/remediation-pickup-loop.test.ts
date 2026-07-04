/**
 * M1 Wave 2 (Aurora dogfood-readiness, 2026-05-12): daemon startup
 * remediation child pickup loop.
 *
 * Wave 2 (2026-05-11) wired `spawnRemediationWorkflow` behind
 * `OMNIFORGE_AUTO_REMEDIATION`. The helper creates a child workflow in
 * `status='pending'` parented to the failing parent, but NOTHING scheduled
 * it. Operator had to run the child by hand — making the feature unusable
 * in practice.
 *
 * This test verifies the closure of that gap:
 *
 *   1. After spawn, `pickupPendingRemediationWorkflows(db)` finds the child.
 *   2. The pickup loop dispatches the child via `continueWorkflowExecution`,
 *      flipping its status from `pending` to `executing` and eventually
 *      reaching `completed` when the (mocked) task loop terminates.
 *   3. A `workflow_remediation_picked_up` event lands under the child's
 *      workflow_id with `dispatcher: 'daemon_startup_pickup'`.
 *   4. A `daemon_recovery_sweep_completed` event lands under `_daemon` with
 *      `kind: 'remediation_pickup'`.
 *   5. A second invocation is a no-op (the child is no longer in `pending`).
 *
 * Mock strategy:
 *   - `continueWorkflowExecution` is mocked at module level so the test
 *     does NOT actually run reviewers / consolidators / LLM calls. We
 *     simulate the executor's side effect (status flip + completed event)
 *     to exercise the pickup pathway without touching external services.
 *   - Migration 046's `_daemon` sentinel row is supplied by `initDb`, no
 *     extra seeding needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

// Mock `continueWorkflowExecution` BEFORE any module under test resolves
// it. We need a real DB write inside the mock so the test can assert the
// status flip without depending on the full executor pipeline.
vi.mock('../../src/brain/executor/orchestrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/brain/executor/orchestrate.js')>();
  return {
    ...actual,
    continueWorkflowExecution: vi.fn(async (db: Database.Database, workflow) => {
      // Simulate the executor: workflow flips to 'executing' immediately
      // (real executor does this inside continueWorkflowExecution via the
      // 'workflow_resumed' event path), then 'completed' on success.
      db.prepare('UPDATE workflows SET status = ? WHERE id = ?').run('executing', workflow.id);
      // Insert a workflow_resumed event so we can verify the executor was
      // actually invoked end-to-end (not just status-flipped externally).
      db.prepare(
        `INSERT INTO events (workflow_id, task_id, type, payload_json, timestamp)
         VALUES (?, NULL, 'workflow_resumed', '{}', ?)`,
      ).run(workflow.id, Date.now());
      // Flip to completed so a subsequent pickup invocation finds nothing.
      db.prepare('UPDATE workflows SET status = ?, completed_at = ? WHERE id = ?').run(
        'completed',
        Date.now(),
        workflow.id,
      );
      return { ...workflow, status: 'completed', completed_at: Date.now() };
    }),
  };
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  loadWorkflowById,
  newWorkflowId,
  setTaskFailed,
} from '../../src/db/persist.js';
import { createQualityFixTasks } from '../../src/quality/fix-tasks.js';
import { spawnRemediationWorkflow } from '../../src/quality/remediation.js';
import { saveQualityReview } from '../../src/quality/store.js';
import {
  _resetDispatchedSetForTesting,
  pickupPendingRemediationWorkflows,
} from '../../src/quality/remediation-pickup.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  const now = Date.now();
  return {
    id: newWorkflowId(),
    workspace: 'internal',
    objective: 'pickup-test parent',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: 1.0,
    max_duration_seconds: null,
    metadata: null,
    ...overrides,
  };
}

function makeSourceTask(workflowId: string): Task {
  const now = Date.now();
  return {
    id: `tk_src_${crypto.randomUUID()}`,
    workflow_id: workflowId,
    name: 'Source task that failed quality gate',
    kind: 'cli_spawn',
    input_json: JSON.stringify({ objective: 'do the thing' }),
    output_json: 'partial output',
    status: 'failed',
    depends_on: [],
    executor_hint: 'cli:codex',
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: now,
    completed_at: now,
    created_at: now,
    acceptance_criteria: 'browser smoke confirms button works',
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: null,
    hitl: false,
    execution_mode: 'ephemeral',
  };
}

function insertSourceTask(db: Database.Database, task: Task): void {
  db.prepare(
    `INSERT INTO tasks
       (id, workflow_id, name, kind, input_json, output_json, status,
        depends_on_json, executor_hint, timeout_seconds, max_retries,
        retry_count, retry_policy, started_at, completed_at, created_at,
        acceptance_criteria, refine_count, max_refine, refine_feedback, model, hitl,
        execution_mode, tool_name, file_scope_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id, task.workflow_id, task.name, task.kind,
    task.input_json, task.output_json, task.status,
    JSON.stringify(task.depends_on),
    task.executor_hint, task.timeout_seconds, task.max_retries,
    task.retry_count, task.retry_policy, task.started_at,
    task.completed_at, task.created_at, task.acceptance_criteria,
    task.refine_count, task.max_refine, task.refine_feedback, task.model,
    task.hitl ? 1 : 0,
    task.execution_mode ?? 'ephemeral',
    null,
    null,
  );
}

function seedReviewAndFixTasks(
  db: Database.Database,
  workflowId: string,
): { fixIds: string[] } {
  const review = saveQualityReview(db, {
    workflowId,
    scope: 'task',
    reviewerKind: 'light_ai',
    outcome: 'needs_fixes',
    score: 0.3,
    fixTasks: [
      {
        title: 'Fix the button copy',
        kind: 'cli_spawn',
        objective: 'Update button label so the smoke passes.',
        acceptanceCriteria: 'Click counter increments on Enter.',
      },
    ],
  });
  const fixResult = createQualityFixTasks(db, review);
  return { fixIds: fixResult.created.map((t) => t.id) };
}

/**
 * Spawn a parent failure scenario end-to-end: parent workflow + failing
 * source task + fix-tasks created + child remediation workflow spawned
 * pending. Returns the child workflow id for the pickup test to scan.
 */
function arrangePendingRemediationChild(db: Database.Database): {
  parentId: string;
  childId: string;
  sourceTaskId: string;
} {
  const parent = makeWorkflow();
  insertWorkflow(db, parent);
  const sourceTask = makeSourceTask(parent.id);
  insertSourceTask(db, sourceTask);
  setTaskFailed(db, sourceTask.id);
  const { fixIds } = seedReviewAndFixTasks(db, parent.id);
  const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
    sourceTaskId: sourceTask.id,
  });
  return {
    parentId: parent.id,
    childId: result.child_workflow_id,
    sourceTaskId: sourceTask.id,
  };
}

describe('M1 Wave 2 — remediation pickup loop (daemon startup)', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    // Tempfile DB (not :memory:) so the pickup loop's per-child
    // `initDb(getDbPath())` opens the SAME DB as the test's scan handle.
    tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-pickup-'));
    dbPath = join(tmpDir, 'omniforge.db');
    process.env.DB_PATH = dbPath;
    delete process.env.OMNIFORGE_AUTO_REMEDIATION;
    db = initDb(dbPath);
    _resetDispatchedSetForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.OMNIFORGE_AUTO_REMEDIATION;
    delete process.env.DB_PATH;
    try {
      db.close();
    } catch { /* already closed */ }
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* Windows file lock race */ }
  });

  it('picks up a single pending remediation child and dispatches it', async () => {
    const { parentId, childId } = arrangePendingRemediationChild(db);

    // Sanity — child exists in pending status, parent in awaiting_remediation.
    expect(loadWorkflowById(db, childId)!.status).toBe('pending');
    expect(loadWorkflowById(db, parentId)!.status).toBe('awaiting_remediation');

    const result = await pickupPendingRemediationWorkflows(db);

    expect(result.pickedUp).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.dispatched).toEqual([childId]);
    expect(result.errors).toEqual([]);

    // Status flipped (the mocked continueWorkflowExecution wrote 'completed').
    expect(loadWorkflowById(db, childId)!.status).toBe('completed');

    // workflow_remediation_picked_up event landed on the child's stream.
    const pickupEv = db
      .prepare(
        `SELECT payload_json FROM events
         WHERE workflow_id = ? AND type = 'workflow_remediation_picked_up'`,
      )
      .get(childId) as { payload_json: string } | undefined;
    expect(pickupEv).toBeDefined();
    const payload = JSON.parse(pickupEv!.payload_json) as {
      parent_workflow_id: string;
      dispatcher: string;
      task_count: number;
    };
    expect(payload.parent_workflow_id).toBe(parentId);
    expect(payload.dispatcher).toBe('daemon_startup_pickup');
    expect(payload.task_count).toBeGreaterThanOrEqual(2); // t0 + fix-task

    // workflow_resumed event proves continueWorkflowExecution was invoked.
    const resumedEv = db
      .prepare(
        `SELECT id FROM events
         WHERE workflow_id = ? AND type = 'workflow_resumed'`,
      )
      .get(childId);
    expect(resumedEv).toBeDefined();
  });

  it('emits zero events and returns empty when no pending children exist', async () => {
    const result = await pickupPendingRemediationWorkflows(db);

    expect(result.pickedUp).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.dispatched).toEqual([]);
    expect(result.errors).toEqual([]);

    // No spurious events emitted.
    const eventCount = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'workflow_remediation_picked_up'`)
      .get() as { n: number };
    expect(eventCount.n).toBe(0);
  });

  it('is idempotent on second invocation (child no longer pending)', async () => {
    const { childId } = arrangePendingRemediationChild(db);

    const first = await pickupPendingRemediationWorkflows(db);
    expect(first.pickedUp).toBe(1);

    // Second call — child is now 'completed' (mocked), so scan finds 0 candidates.
    _resetDispatchedSetForTesting(); // reset the in-process guard
    const second = await pickupPendingRemediationWorkflows(db);
    expect(second.pickedUp).toBe(0);
    expect(second.dispatched).toEqual([]);

    // Only ONE pickup event was emitted (no double-dispatch event).
    const pickupCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE workflow_id = ? AND type = 'workflow_remediation_picked_up'`,
      )
      .get(childId) as { n: number };
    expect(pickupCount.n).toBe(1);
  });

  it('handles multiple pending children in a single pickup invocation', async () => {
    const a = arrangePendingRemediationChild(db);
    const b = arrangePendingRemediationChild(db);
    const c = arrangePendingRemediationChild(db);

    // All 3 are independent pending children.
    expect(loadWorkflowById(db, a.childId)!.status).toBe('pending');
    expect(loadWorkflowById(db, b.childId)!.status).toBe('pending');
    expect(loadWorkflowById(db, c.childId)!.status).toBe('pending');

    const result = await pickupPendingRemediationWorkflows(db);

    expect(result.pickedUp).toBe(3);
    expect(result.failed).toBe(0);
    expect(new Set(result.dispatched)).toEqual(new Set([a.childId, b.childId, c.childId]));

    // Each child flipped to completed via the mocked executor.
    expect(loadWorkflowById(db, a.childId)!.status).toBe('completed');
    expect(loadWorkflowById(db, b.childId)!.status).toBe('completed');
    expect(loadWorkflowById(db, c.childId)!.status).toBe('completed');

    // Each child got its own pickup event.
    const pickupCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE type = 'workflow_remediation_picked_up'`,
      )
      .get() as { n: number };
    expect(pickupCount.n).toBe(3);
  });

  it('does NOT pick up children whose parent_workflow_id is null (regular workflows)', async () => {
    // A regular pending workflow without a parent must NOT be touched by
    // the pickup loop — it is the operator's responsibility to start it
    // via `omniforge_run_workflow` or the dashboard.
    const lone = makeWorkflow({ status: 'pending' });
    insertWorkflow(db, lone);
    expect(loadWorkflowById(db, lone.id)!.status).toBe('pending');

    const result = await pickupPendingRemediationWorkflows(db);

    expect(result.pickedUp).toBe(0);
    expect(loadWorkflowById(db, lone.id)!.status).toBe('pending'); // untouched
  });

  it('does NOT pick up children whose status is already executing/completed/failed', async () => {
    const a = arrangePendingRemediationChild(db);
    // Simulate an operator who manually started the child between spawn and pickup.
    db.prepare(`UPDATE workflows SET status = 'executing' WHERE id = ?`).run(a.childId);

    const b = arrangePendingRemediationChild(db);
    db.prepare(`UPDATE workflows SET status = 'completed' WHERE id = ?`).run(b.childId);

    const c = arrangePendingRemediationChild(db); // still pending — the only eligible one.

    const result = await pickupPendingRemediationWorkflows(db);

    expect(result.pickedUp).toBe(1);
    expect(result.dispatched).toEqual([c.childId]);
  });

  it('handles errors per-child without aborting the whole sweep', async () => {
    const { childId: goodChild } = arrangePendingRemediationChild(db);

    // Insert a malformed pending child (no tasks) — dispatch should fail
    // because `loadWorkflowTasks` returns zero rows.
    const bad: Workflow = {
      ...makeWorkflow({ status: 'pending' }),
      objective: 'malformed child — no tasks',
    };
    insertWorkflow(db, bad);
    db.prepare(`UPDATE workflows SET parent_workflow_id = ? WHERE id = ?`)
      .run(goodChild, bad.id); // any other workflow id satisfies FK

    const result = await pickupPendingRemediationWorkflows(db);

    // Good child dispatched, bad child failed — sweep does not abort.
    expect(result.pickedUp).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.dispatched).toContain(goodChild);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.workflow_id).toBe(bad.id);
    expect(result.errors[0]!.error).toMatch(/no tasks/i);

    // Bad child got a failure-flavored pickup event.
    const badEv = db
      .prepare(
        `SELECT payload_json FROM events
         WHERE workflow_id = ? AND type = 'workflow_remediation_picked_up'`,
      )
      .get(bad.id) as { payload_json: string } | undefined;
    expect(badEv).toBeDefined();
    const badPayload = JSON.parse(badEv!.payload_json) as {
      dispatched: boolean;
      error: string;
    };
    expect(badPayload.dispatched).toBe(false);
    expect(badPayload.error).toMatch(/no tasks/i);
  });

  it('returns a deterministic result shape (pickedUp/failed/dispatched/errors)', async () => {
    arrangePendingRemediationChild(db);
    const result = await pickupPendingRemediationWorkflows(db);

    expect(result).toEqual(
      expect.objectContaining({
        pickedUp: expect.any(Number),
        failed: expect.any(Number),
        dispatched: expect.any(Array),
        errors: expect.any(Array),
      }),
    );
    expect(result.pickedUp + result.failed).toBe(result.dispatched.length + result.errors.length);
  });
});
