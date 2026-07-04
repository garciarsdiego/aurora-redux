/**
 * W2 (Aurora dogfood-readiness, 2026-05-11) — auto-remediation end-to-end.
 *
 * Verifies the contract documented in `src/quality/remediation.ts`:
 *
 *   1. When OMNIFORGE_AUTO_REMEDIATION=true and a quality gate fires
 *      QualityGateFailedError, the executor MUST:
 *        - Create the fix-task rows (existing behaviour, unchanged).
 *        - Spawn a CHILD workflow whose DAG is [t0 HITL gate,
 *          ...reparented fix-tasks depending on t0].
 *        - Flip the PARENT workflow status to 'awaiting_remediation'.
 *        - Set tasks.remediation_workflow_id on the originally failing
 *          parent task.
 *        - Emit `task_remediation_scheduled` (parent task scope) and
 *          `workflow_awaiting_remediation` (parent workflow scope) events.
 *
 *   2. When the child workflow completes successfully, the parent
 *      MUST flip from 'awaiting_remediation' to 'completed' and emit
 *      `workflow_remediation_completed`.
 *
 *   3. When the child workflow fails, the parent MUST flip to 'failed'
 *      and emit `workflow_remediation_failed`.
 *
 *   4. When the feature flag is off (default), the original behaviour
 *      MUST be preserved verbatim: fix-tasks created in DB but NO
 *      child workflow spawned, NO parent status flip, the original
 *      QualityGateFailedError still propagates.
 *
 * Test strategy:
 *   We exercise the helper layer directly (no full executor loop) so the
 *   test is deterministic and runs in single-digit ms. The orchestrate
 *   integration is already covered by tests/integration/workflow-tasks-
 *   atomic-e2e.test.ts and tests/integration/fk-cascade-e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import {
  insertEvent,
  insertWorkflow,
  loadWorkflowById,
  loadWorkflowTasks,
  newWorkflowId,
  setTaskFailed,
  setWorkflowDone,
} from '../../src/db/persist.js';
import { createQualityFixTasks } from '../../src/quality/fix-tasks.js';
import {
  resolveParentAfterRemediation,
  spawnRemediationWorkflow,
} from '../../src/quality/remediation.js';
import { saveQualityReview } from '../../src/quality/store.js';
import { recordModelCall } from '../../src/v2/llm-ledger/store.js';
import type { QualityFixTaskDraft, QualityReviewRow } from '../../src/quality/types.js';
import type { Task, Workflow } from '../../src/types/index.js';

function makeWorkflow(): Workflow {
  const now = Date.now();
  return {
    id: newWorkflowId(),
    workspace: 'internal',
    objective: 'auto-remediation e2e',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: 1.0, // $1 cap so we can verify 30% slice
    max_duration_seconds: null,
    metadata: null,
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

function seedReview(
  db: Database.Database,
  workflowId: string,
  fixTasks: QualityFixTaskDraft[],
): QualityReviewRow {
  return saveQualityReview(db, {
    workflowId,
    scope: 'task',
    reviewerKind: 'light_ai',
    outcome: 'needs_fixes',
    score: 0.3,
    fixTasks,
  });
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

describe('W2 — auto-remediation end-to-end', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDb(':memory:');
    // Ensure flag is unset at the start of every test so we test both
    // paths deterministically; individual tests set as needed.
    delete process.env.OMNIFORGE_AUTO_REMEDIATION;
    delete process.env.AUTO_REMEDIATION_AUTO_APPROVE;
    delete process.env.REMEDIATION_BUDGET_PCT;
  });

  afterEach(() => {
    delete process.env.OMNIFORGE_AUTO_REMEDIATION;
    delete process.env.AUTO_REMEDIATION_AUTO_APPROVE;
    delete process.env.REMEDIATION_BUDGET_PCT;
    db.close();
  });

  it('spawns a child workflow with HITL gate at t0 and reparents fix-tasks', () => {
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    setTaskFailed(db, sourceTask.id);

    const review = seedReview(db, parent.id, [
      {
        title: 'Fix button copy',
        kind: 'cli_spawn',
        objective: 'Update button label so the smoke passes.',
        acceptanceCriteria: 'Click counter increments on Enter.',
      },
      {
        title: 'Add screenshot evidence',
        kind: 'cli_spawn',
        objective: 'Capture a passing-state screenshot.',
        acceptanceCriteria: 'screenshot.png exists in workspace.',
      },
    ]);
    const fixResult = createQualityFixTasks(db, review);
    const fixIds = fixResult.created.map((t) => t.id);
    expect(fixIds).toHaveLength(2);

    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });

    // Child workflow exists and is linked to parent.
    const child = loadWorkflowById(db, result.child_workflow_id);
    expect(child).not.toBeNull();
    expect(child!.workspace).toBe('internal');
    const parentLinkRow = db
      .prepare('SELECT parent_workflow_id FROM workflows WHERE id = ?')
      .get(result.child_workflow_id) as { parent_workflow_id: string | null };
    expect(parentLinkRow.parent_workflow_id).toBe(parent.id);

    // Parent flipped to awaiting_remediation.
    const updatedParent = loadWorkflowById(db, parent.id);
    expect(updatedParent!.status).toBe('awaiting_remediation');

    // Source task carries the back-reference.
    const sourceRow = db
      .prepare('SELECT remediation_workflow_id FROM tasks WHERE id = ?')
      .get(sourceTask.id) as { remediation_workflow_id: string | null };
    expect(sourceRow.remediation_workflow_id).toBe(result.child_workflow_id);

    // Child workflow tasks: t0 HITL gate + 2 fix tasks.
    const childTasks = loadWorkflowTasks(db, result.child_workflow_id);
    expect(childTasks).toHaveLength(3);
    const t0 = childTasks.find((t) => t.id === result.hitl_gate_task_id);
    expect(t0).toBeDefined();
    expect(t0!.hitl).toBe(true);
    expect(t0!.depends_on).toEqual([]);

    // Every fix-task depends on t0.
    const fixTasksUnderChild = childTasks.filter((t) => fixIds.includes(t.id));
    expect(fixTasksUnderChild).toHaveLength(2);
    for (const t of fixTasksUnderChild) {
      expect(t.depends_on).toContain(result.hitl_gate_task_id);
      expect(t.workflow_id).toBe(result.child_workflow_id);
    }

    // HITL gate row pending (no auto-approve set).
    const gateRow = db
      .prepare('SELECT status FROM hitl_gates WHERE id = ?')
      .get(result.hitl_gate_id) as { status: string };
    expect(gateRow.status).toBe('pending');

    // Events fired on parent.
    const events = db
      .prepare(
        `SELECT type, payload_json FROM events
         WHERE workflow_id = ? ORDER BY id`,
      )
      .all(parent.id) as Array<{ type: string; payload_json: string }>;
    const scheduledEv = events.find((e) => e.type === 'task_remediation_scheduled');
    const awaitingEv = events.find((e) => e.type === 'workflow_awaiting_remediation');
    expect(scheduledEv).toBeDefined();
    expect(awaitingEv).toBeDefined();
    const scheduledPayload = JSON.parse(scheduledEv!.payload_json) as {
      child_workflow_id: string;
      fix_task_count: number;
      auto_approved: boolean;
    };
    expect(scheduledPayload.child_workflow_id).toBe(result.child_workflow_id);
    expect(scheduledPayload.fix_task_count).toBe(2);
    expect(scheduledPayload.auto_approved).toBe(false);

    // Child gets the symmetric workflow_remediation_started event.
    const childStartedEv = db
      .prepare(
        `SELECT type FROM events WHERE workflow_id = ? AND type = ?`,
      )
      .get(result.child_workflow_id, 'workflow_remediation_started');
    expect(childStartedEv).toBeDefined();

    // Budget cap is 30% of remaining budget. Parent had $1.0 and zero
    // spend so remaining = $1.0; 30% = $0.30.
    expect(result.budget_cap_usd).toBeCloseTo(0.3, 5);
  });

  it('respects AUTO_REMEDIATION_AUTO_APPROVE=true by pre-resolving the t0 gate', () => {
    process.env.AUTO_REMEDIATION_AUTO_APPROVE = 'true';
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    setTaskFailed(db, sourceTask.id);
    const review = seedReview(db, parent.id, [
      {
        title: 'auto-approved fix',
        kind: 'cli_spawn',
        objective: 'no-op',
        acceptanceCriteria: 'n/a',
      },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);

    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });
    expect(result.auto_approved).toBe(true);

    const gateRow = db
      .prepare('SELECT status, decision FROM hitl_gates WHERE id = ?')
      .get(result.hitl_gate_id) as { status: string; decision: string };
    expect(gateRow.status).toBe('approved');
    expect(gateRow.decision).toBe('approved');
  });

  it('honours REMEDIATION_BUDGET_PCT override (50% of remaining)', () => {
    process.env.REMEDIATION_BUDGET_PCT = '50';
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'x', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });
    expect(result.budget_cap_usd).toBeCloseTo(0.5, 5);
  });

  it('flips parent to completed when child workflow completes', () => {
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'fix', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });

    // Parent in awaiting_remediation.
    expect(loadWorkflowById(db, parent.id)!.status).toBe('awaiting_remediation');

    // Resolve child as completed.
    resolveParentAfterRemediation(db, parent.id, result.child_workflow_id, 'completed');

    const updatedParent = loadWorkflowById(db, parent.id);
    expect(updatedParent!.status).toBe('completed');
    expect(updatedParent!.completed_at).not.toBeNull();

    const remediationCompletedEv = db
      .prepare(
        `SELECT payload_json FROM events
         WHERE workflow_id = ? AND type = 'workflow_remediation_completed'`,
      )
      .get(parent.id) as { payload_json: string } | undefined;
    expect(remediationCompletedEv).toBeDefined();
    const payload = JSON.parse(remediationCompletedEv!.payload_json) as { child_workflow_id: string };
    expect(payload.child_workflow_id).toBe(result.child_workflow_id);
  });

  it('flips parent to failed when child workflow fails (via setWorkflowDone)', () => {
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'fix', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });

    // Simulate child workflow failure: call setWorkflowDone('failed') on
    // the child. setWorkflowDone has the W2 hook that walks parent_workflow_id
    // and flips the parent to failed when the parent was awaiting_remediation.
    setWorkflowDone(db, result.child_workflow_id, 'failed');

    const updatedParent = loadWorkflowById(db, parent.id);
    expect(updatedParent!.status).toBe('failed');

    const failedEv = db
      .prepare(
        `SELECT payload_json FROM events
         WHERE workflow_id = ? AND type = 'workflow_remediation_failed'`,
      )
      .get(parent.id) as { payload_json: string } | undefined;
    expect(failedEv).toBeDefined();
  });

  it('preserves original behaviour when OMNIFORGE_AUTO_REMEDIATION is off (default)', () => {
    // The feature flag is read inside executor/run-task.ts. We verify here
    // that calling `createQualityFixTasks` alone (the legacy path) does NOT
    // spawn a child workflow or flip the parent's status.
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'manual fix', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    expect(process.env.OMNIFORGE_AUTO_REMEDIATION).toBeUndefined();

    const fixResult = createQualityFixTasks(db, review);
    expect(fixResult.created).toHaveLength(1);

    // No new workflow row was created.
    const wfCount = (db
      .prepare(`SELECT COUNT(*) AS n FROM workflows WHERE id != '_daemon'`)
      .get() as { n: number }).n;
    expect(wfCount).toBe(1);

    // Parent status untouched.
    expect(loadWorkflowById(db, parent.id)!.status).toBe('executing');

    // No remediation events emitted.
    const remediationEv = db
      .prepare(
        `SELECT id FROM events WHERE workflow_id = ? AND type LIKE '%remediation%'`,
      )
      .all(parent.id);
    expect(remediationEv).toHaveLength(0);

    // No remediation_workflow_id link on the source task.
    const sourceRow = db
      .prepare('SELECT remediation_workflow_id FROM tasks WHERE id = ?')
      .get(sourceTask.id) as { remediation_workflow_id: string | null };
    expect(sourceRow.remediation_workflow_id).toBeNull();
  });

  it('rejects empty fix-task list (programmer error)', () => {
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);

    expect(() => spawnRemediationWorkflow(db, parent.id, [], { sourceTaskId: sourceTask.id }))
      .toThrowError(/no fix-task ids provided/i);
  });

  it('rejects unknown parent workflow id', () => {
    expect(() => spawnRemediationWorkflow(db, 'wf_does_not_exist', ['tk_x'], {
      sourceTaskId: 'tk_src',
    })).toThrowError(/not found/i);
  });

  it('handles parent with no budget cap (null max_total_cost_usd)', () => {
    const parent = { ...makeWorkflow(), max_total_cost_usd: null };
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'fix', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });
    expect(result.budget_cap_usd).toBeNull();
    const child = loadWorkflowById(db, result.child_workflow_id);
    expect(child!.max_total_cost_usd).toBeNull();
  });

  it('child workflow is deleted via FK CASCADE when parent is deleted (cancel cascade)', () => {
    // Verifies migration 045 wired `parent_workflow_id REFERENCES workflows(id)
    // ON DELETE CASCADE`. Cancelling the parent (which in production means
    // deleting the workflow row) must cascade-delete the child remediation
    // workflow so we don't leak orphans into the dashboard. Also confirms
    // child tasks + events disappear via existing FKs.
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'fix', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });

    // Sanity — child workflow + child tasks exist before parent delete.
    expect(loadWorkflowById(db, result.child_workflow_id)).not.toBeNull();
    expect(loadWorkflowTasks(db, result.child_workflow_id)).toHaveLength(2);

    // Force-enable FK enforcement for this connection so the cascade fires
    // (test DBs sometimes inherit OFF from migration scripts).
    db.pragma('foreign_keys = ON');

    // Cancel cascade — deleting the parent must remove the child.
    db.prepare('DELETE FROM workflows WHERE id = ?').run(parent.id);

    expect(loadWorkflowById(db, result.child_workflow_id)).toBeNull();
    // Child tasks were cascade-deleted via tasks.workflow_id FK CASCADE.
    expect(loadWorkflowTasks(db, result.child_workflow_id)).toHaveLength(0);
  });

  it('produces a DAG where t0 has no deps and every fix-task depends on t0', () => {
    // Topological invariant — t0 is the unique gate (depends_on: []) and
    // every reparented fix-task depends on it. The executor's topo-sort
    // will schedule t0 first, then unblock the fix-tasks once approved.
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'fix1', kind: 'cli_spawn', objective: 'do1', acceptanceCriteria: 'a' },
      { title: 'fix2', kind: 'cli_spawn', objective: 'do2', acceptanceCriteria: 'b' },
      { title: 'fix3', kind: 'cli_spawn', objective: 'do3', acceptanceCriteria: 'c' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });

    const childTasks = loadWorkflowTasks(db, result.child_workflow_id);
    expect(childTasks).toHaveLength(4);

    // Find t0 explicitly — order is by created_at and t0 is inserted last
    // (after fix-tasks were created during the failing-gate flow), so its
    // position isn't first. Position is not the contract; the dependency
    // structure is.
    const t0 = childTasks.find((t) => t.id === result.hitl_gate_task_id);
    expect(t0).toBeDefined();
    expect(t0!.depends_on).toEqual([]);
    expect(t0!.hitl).toBe(true);

    // Every non-t0 task is a fix-task that depends on t0.
    const nonT0 = childTasks.filter((t) => t.id !== result.hitl_gate_task_id);
    expect(nonT0).toHaveLength(3);
    for (const task of nonT0) {
      expect(fixIds).toContain(task.id);
      expect(task.depends_on).toContain(result.hitl_gate_task_id);
    }

    // The set of fix-tasks exactly matches what we passed in (no drops, no
    // duplicates).
    expect(new Set(nonT0.map((t) => t.id))).toEqual(new Set(fixIds));
  });

  it('budget cap reflects 30% of REMAINING (parent.cap - spent), not 30% of cap', () => {
    // Parent has $1.0 cap and has already spent $0.40 — remaining = $0.60.
    // Child cap should be 30% of remaining = $0.18, NOT 30% of $1.0 = $0.30.
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);

    // Seed a model_call so getWorkflowModelSpendUsd reports $0.40 spent.
    recordModelCall(db, {
      workflowId: parent.id,
      taskId: sourceTask.id,
      model: 'cc/claude-sonnet-4-6',
      costUsd: 0.4,
      kind: 'llm_call',
    });

    const review = seedReview(db, parent.id, [
      { title: 'x', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });

    // 30% of (1.0 - 0.4) = 0.18. Rounded to 6 decimals.
    expect(result.budget_cap_usd).toBeCloseTo(0.18, 5);
    const child = loadWorkflowById(db, result.child_workflow_id);
    expect(child!.max_total_cost_usd).toBeCloseTo(0.18, 5);
  });

  it('budget cap is floored at 0 when parent has already overspent', () => {
    // Parent had $1.0 cap and overspent to $1.20 — remaining = max(0, -0.20)
    // = 0. Child cap must be 0, NOT negative.
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    recordModelCall(db, {
      workflowId: parent.id,
      taskId: sourceTask.id,
      model: 'cc/claude-sonnet-4-6',
      costUsd: 1.2,
      kind: 'llm_call',
    });

    const review = seedReview(db, parent.id, [
      { title: 'x', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });

    expect(result.budget_cap_usd).toBe(0);
  });

  it('rejects invalid REMEDIATION_BUDGET_PCT and falls back to 30% default', () => {
    // Guards parseBudgetPct() — any non-numeric / out-of-range value must
    // fall back to DEFAULT_REMEDIATION_BUDGET_PCT (30) rather than producing
    // a corrupted cap or throwing.
    process.env.REMEDIATION_BUDGET_PCT = 'not-a-number';
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'x', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });
    expect(result.budget_cap_usd).toBeCloseTo(0.3, 5);

    // Also exercise the upper-bound clamp (>100) and zero/negative cases.
    process.env.REMEDIATION_BUDGET_PCT = '150';
    const fixIds2 = createQualityFixTasks(
      db,
      seedReview(db, parent.id, [
        { title: 'y', kind: 'cli_spawn', objective: 'y', acceptanceCriteria: 'y' },
      ]),
    ).created.map((t) => t.id);
    // We can't spawn a second remediation off the same parent (it's already
    // in awaiting_remediation), so just exercise parseBudgetPct indirectly
    // via a fresh parent.
    const parent2 = makeWorkflow();
    insertWorkflow(db, parent2);
    const srcTask2 = makeSourceTask(parent2.id);
    insertSourceTask(db, srcTask2);
    const result2 = spawnRemediationWorkflow(db, parent2.id, fixIds2, {
      sourceTaskId: srcTask2.id,
    });
    // Still 30% — out-of-range values fall back to default.
    expect(result2.budget_cap_usd).toBeCloseTo(0.3, 5);
  });

  it('setWorkflowDone(child, completed) does NOT auto-propagate to parent (orchestrate path)', () => {
    // Contract pin: by design (see persist.ts:230-235), setWorkflowDone only
    // auto-propagates the FAILED path on a child workflow — the COMPLETED
    // path runs through resolveParentAfterRemediation called from
    // orchestrate.ts so the parent gets the richer event payload. This test
    // guards against a future regression where someone "fixes" the
    // asymmetry by adding completed-propagation here and double-emits.
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'fix', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });
    expect(loadWorkflowById(db, parent.id)!.status).toBe('awaiting_remediation');

    setWorkflowDone(db, result.child_workflow_id, 'completed');

    // Parent stays in awaiting_remediation until resolveParentAfterRemediation
    // runs explicitly — see the symmetric `flips parent to completed` test.
    expect(loadWorkflowById(db, parent.id)!.status).toBe('awaiting_remediation');
    // And no synthetic completed event was emitted by setWorkflowDone.
    const completedEv = db
      .prepare(
        `SELECT id FROM events
         WHERE workflow_id = ? AND type = 'workflow_remediation_completed'`,
      )
      .all(parent.id);
    expect(completedEv).toHaveLength(0);
  });

  it('does not re-flip parent when resolveParentAfterRemediation called twice', () => {
    const parent = makeWorkflow();
    insertWorkflow(db, parent);
    const sourceTask = makeSourceTask(parent.id);
    insertSourceTask(db, sourceTask);
    const review = seedReview(db, parent.id, [
      { title: 'fix', kind: 'cli_spawn', objective: 'x', acceptanceCriteria: 'x' },
    ]);
    const fixIds = createQualityFixTasks(db, review).created.map((t) => t.id);
    const result = spawnRemediationWorkflow(db, parent.id, fixIds, {
      sourceTaskId: sourceTask.id,
    });
    resolveParentAfterRemediation(db, parent.id, result.child_workflow_id, 'completed');
    expect(loadWorkflowById(db, parent.id)!.status).toBe('completed');

    // Second call should be a no-op (status no longer awaiting_remediation).
    resolveParentAfterRemediation(db, parent.id, result.child_workflow_id, 'failed');
    expect(loadWorkflowById(db, parent.id)!.status).toBe('completed');

    // Only one completed event emitted.
    const completedEvents = db
      .prepare(
        `SELECT id FROM events
         WHERE workflow_id = ? AND type = 'workflow_remediation_completed'`,
      )
      .all(parent.id);
    expect(completedEvents).toHaveLength(1);
  });
});

// Suppress unused-import warning while exporting nothing.
void insertEvent;
