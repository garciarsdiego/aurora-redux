/**
 * W2 (Aurora dogfood-readiness, 2026-05-11): auto-remediation child workflow.
 *
 * When the light quality gate fails inside `executeTaskWithRetry`,
 * `createQualityFixTasks` materialises fix-task rows in `tasks` but NOTHING
 * scheduled them — they were orphans in the DB. Operator had to spawn a
 * follow-up workflow by hand to consume those task ids.
 *
 * W2 closes the loop: this module builds a CHILD workflow whose DAG is
 *   [t0_hitl_gate, ...fix-tasks-depending-on-t0]
 * and links it back to the parent via `workflows.parent_workflow_id`. The
 * parent workflow is flipped to status 'awaiting_remediation' so the
 * dashboard surfaces the pending decision; cancelling the parent cascades
 * to the child via the existing FK `ON DELETE CASCADE` and the
 * cancel-broadcast helper.
 *
 * Feature-flagged behind `OMNIFORGE_AUTO_REMEDIATION` (default false). When
 * the flag is off, the legacy "throw QualityGateFailedError + operator does
 * it manually" path is preserved verbatim.
 *
 * ── M1 Wave 2 (2026-05-12): daemon startup pickup loop ───────────────────
 * The child workflow is created in `status='pending'` and parented via
 * `parent_workflow_id`. NOTHING in this module schedules the child for
 * execution — that responsibility now lives in
 * `src/quality/remediation-pickup.ts` (`pickupPendingRemediationWorkflows`),
 * which is invoked once per daemon startup from
 * `runStartupAsyncSweeps` in `src/cli/commands/daemon.ts`.
 *
 * The pickup loop:
 *   1. Scans `workflows WHERE parent_workflow_id IS NOT NULL AND status='pending'`.
 *   2. Re-validates the child is still pending (race guard) and that its
 *      tasks exist in the DB.
 *   3. Dispatches the child via `continueWorkflowExecution` (NOT
 *      `executeWorkflow` — the task rows already exist, we resume them).
 *   4. Emits a `workflow_remediation_picked_up` event under the child's
 *      workflow_id for the dashboard timeline.
 *
 * The pickup runs at STARTUP only (not periodically) because:
 *   - When the daemon is alive, the natural in-process dispatch is already
 *     handled by `executeTaskWithRetry` in the parent's executor loop.
 *   - The pickup loop's job is solely crash recovery for daemons killed
 *     between the spawn transaction commit and the dispatch hand-off.
 *   - A periodic scan would introduce double-dispatch risk and add timer
 *     lifecycle complexity (mirror to the trigger-orphan-retry sweep
 *     pattern, which is also one-shot at startup).
 */
import type Database from 'better-sqlite3';
import {
  insertEvent,
  insertHitlGate,
  insertWorkflow,
  linkRemediationToParent,
  loadWorkflowById,
  loadWorkflowTasks,
  newHitlGateId,
  newTaskId,
  newWorkflowId,
  resolveHitlGate,
  setTaskRemediationLink,
  setWorkflowStatus,
} from '../db/persist.js';
import type { Task, Workflow } from '../types/index.js';
import { getWorkflowModelSpendUsd } from '../v2/budget/control.js';

export interface SpawnRemediationWorkflowOptions {
  /** The original task whose quality gate failed. Stored on the child as
   *  source_parent_task_id so we can crosslink in the UI / events. */
  sourceTaskId: string;
}

export interface SpawnRemediationWorkflowResult {
  child_workflow_id: string;
  fix_task_ids_scheduled: string[];
  hitl_gate_id: string;
  hitl_gate_task_id: string;
  budget_cap_usd: number | null;
  auto_approved: boolean;
}

const DEFAULT_REMEDIATION_BUDGET_PCT = 30;

function parseBudgetPct(): number {
  const raw = process.env.REMEDIATION_BUDGET_PCT;
  if (!raw) return DEFAULT_REMEDIATION_BUDGET_PCT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    return DEFAULT_REMEDIATION_BUDGET_PCT;
  }
  return parsed;
}

function shouldAutoApprove(): boolean {
  return process.env.AUTO_REMEDIATION_AUTO_APPROVE === 'true';
}

/**
 * Compute the child workflow's budget cap from the parent's REMAINING
 * budget. Returns null when the parent has no cap (unlimited dogfood mode).
 *
 * Formula: child cap = (parent_cap - parent_spent_so_far) * pct / 100.
 * Floor at 0 so a parent that already overspent doesn't produce a negative cap.
 */
function computeChildBudgetCap(
  db: Database.Database,
  parent: Workflow,
  pct: number,
): number | null {
  if (parent.max_total_cost_usd === null || parent.max_total_cost_usd === undefined) {
    return null;
  }
  const spent = getWorkflowModelSpendUsd(db, parent.id);
  const remaining = Math.max(0, parent.max_total_cost_usd - spent);
  const cap = (remaining * pct) / 100;
  // Round to 6 decimals to match the rest of the cost ledger precision.
  return Math.round(cap * 1_000_000) / 1_000_000;
}

/**
 * Build the in-memory fix-tasks list cloned to the child workflow. Each
 * original task row is preserved (id is recycled — the task already exists
 * with the old `workflow_id`); we just UPDATE workflow_id and depends_on.
 * Returns the new id list AFTER renaming.
 *
 * Implementation note: rather than physically moving rows, we DELETE the
 * orphaned parent-task fix rows and re-create them under the child's
 * workflow_id with the t0 dependency added. This keeps the existing
 * `tasks.id` referential semantics simple (no FK breakage from foreign
 * tables like artifacts / events whose task_id is ON DELETE SET NULL).
 *
 * NOTE: tasks rows on the parent have `workflow_id = parent.id`, so they
 * were never schedulable from the child loop. We reparent them by updating
 * workflow_id to the child id and prepending t0 to depends_on.
 */
function reparentFixTasksToChild(
  db: Database.Database,
  fixTaskIds: string[],
  childWfId: string,
  t0TaskId: string,
): void {
  const updateStmt = db.prepare(
    `UPDATE tasks
       SET workflow_id = ?,
           depends_on_json = ?
     WHERE id = ?`,
  );
  for (const taskId of fixTaskIds) {
    // Read existing depends_on so we can prepend t0 without dropping
    // intra-fix-task dependencies (createQualityFixTasks may have set them).
    const row = db
      .prepare(`SELECT depends_on_json FROM tasks WHERE id = ?`)
      .get(taskId) as { depends_on_json: string | null } | undefined;
    let existing: string[] = [];
    if (row?.depends_on_json) {
      try {
        const parsed = JSON.parse(row.depends_on_json) as unknown;
        if (Array.isArray(parsed)) existing = parsed.filter((v): v is string => typeof v === 'string');
      } catch { /* malformed depends_on — start fresh with [t0] */ }
    }
    // Drop any depends_on entries that reference the OLD parent workflow's
    // task ids — those tasks live in a different workflow and the child
    // loop won't see them, so the dependency would deadlock the child.
    // Replace with the t0 gate alone (plus any sibling fix-task ids that
    // travelled with us into the child workflow).
    const siblingIds = new Set(fixTaskIds);
    const preservedSiblingDeps = existing.filter((id) => siblingIds.has(id));
    const newDepends = [t0TaskId, ...preservedSiblingDeps];
    updateStmt.run(childWfId, JSON.stringify(newDepends), taskId);
  }
}

/**
 * Spawn the remediation child workflow. The CALLER must have already
 * checked the OMNIFORGE_AUTO_REMEDIATION feature flag — when off, the
 * legacy behavior (throw QualityGateFailedError) is preserved.
 *
 * Returns the spawned child workflow id plus the task ids that were
 * scheduled under it. Throws on:
 *   - parent workflow row missing (would be a programmer error since the
 *     caller is the parent's executor loop)
 *   - fixTaskIds being empty (no work to schedule — caller should treat
 *     this as "fix-task creation failed" and re-raise the gate error)
 *   - DB insert errors propagated from the transactional block (caller
 *     decides whether to re-raise the original gate error)
 *
 * Side effects:
 *   - Inserts child workflow row + child t0 hitl_gate task row.
 *   - REPARENTS the existing fix-task rows from parent to child workflow.
 *   - Creates a HITL gate row for t0 (channel='cli', status='pending').
 *   - If AUTO_REMEDIATION_AUTO_APPROVE=true, immediately resolves the gate
 *     row as 'approved' so the child workflow runner can sail past t0.
 *   - Sets `tasks.remediation_workflow_id = childWfId` on the parent task.
 *   - Flips parent workflow status to 'awaiting_remediation'.
 *   - Emits `task_remediation_scheduled` (parent task) and
 *     `workflow_awaiting_remediation` (parent workflow) events.
 */
export function spawnRemediationWorkflow(
  db: Database.Database,
  parentWfId: string,
  fixTaskIds: string[],
  opts: SpawnRemediationWorkflowOptions,
): SpawnRemediationWorkflowResult {
  if (fixTaskIds.length === 0) {
    throw new Error('spawnRemediationWorkflow: no fix-task ids provided');
  }
  const parent = loadWorkflowById(db, parentWfId);
  if (!parent) {
    throw new Error(`spawnRemediationWorkflow: parent workflow ${parentWfId} not found`);
  }

  const childWfId = newWorkflowId();
  const t0TaskId = newTaskId();
  const gateId = newHitlGateId();
  const now = Date.now();
  const budgetPct = parseBudgetPct();
  const childBudgetCap = computeChildBudgetCap(db, parent, budgetPct);
  const autoApproved = shouldAutoApprove();

  // The child workflow inherits the parent's workspace + objective so the
  // executor produces consistent UI / persona context. Cost cap is the
  // computed slice of remaining parent budget.
  const childWorkflow: Workflow = {
    id: childWfId,
    workspace: parent.workspace,
    objective: `Remediation of ${parentWfId}: ${parent.objective}`,
    pattern_id: null,
    status: 'pending',
    started_at: null,
    completed_at: null,
    created_at: now,
    created_by: parent.created_by,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: childBudgetCap,
    max_duration_seconds: parent.max_duration_seconds,
    metadata: JSON.stringify({
      remediation: {
        parent_workflow_id: parentWfId,
        source_parent_task_id: opts.sourceTaskId,
        fix_task_ids: fixTaskIds,
        budget_pct_of_remaining: budgetPct,
        auto_approve: autoApproved,
      },
    }),
  };

  // The t0 task is a HITL gate that the child workflow runner will block
  // on. We use `cli_spawn` as the kind (any kind works — `hitl: true` is
  // what flips on `runHitlGate`). The kind has no executor side effects
  // because `runHitlGate` returns before the task body runs.
  const t0Task: Task = {
    id: t0TaskId,
    workflow_id: childWfId,
    name: 'Approve remediation',
    kind: 'cli_spawn',
    input_json: JSON.stringify({
      objective: `Remediation gate for parent workflow ${parentWfId}`,
      task_name: 'Approve remediation',
      workspace: parent.workspace,
      remediation: {
        parent_workflow_id: parentWfId,
        source_parent_task_id: opts.sourceTaskId,
        fix_task_count: fixTaskIds.length,
        budget_cap_usd: childBudgetCap,
      },
    }),
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 600,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: now,
    acceptance_criteria: `Operator approves the ${fixTaskIds.length} fix-task(s) before they run.`,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: true,
    execution_mode: 'ephemeral',
  };

  // Atomic block (Tier 0 — Wave 2 DB-A pattern): child workflow + t0 task +
  // reparented fix-tasks + parent linkage all commit together. A crash mid-
  // way leaves the parent workflow + parent task untouched, so the operator
  // can retry remediation by re-failing the gate.
  db.transaction(() => {
    insertWorkflow(db, childWorkflow);
    // Insert t0 directly via raw SQL because `insertTask` would re-emit
    // depends_on as an empty array (which it would, since t0 has none)
    // but we want consistency with the rest of the block.
    db.prepare(
      `INSERT INTO tasks
       (id, workflow_id, name, kind, input_json, output_json, status,
        depends_on_json, executor_hint, timeout_seconds, max_retries,
        retry_count, retry_policy, started_at, completed_at, created_at,
        acceptance_criteria, refine_count, max_refine, refine_feedback, model, hitl,
        execution_mode, tool_name, file_scope_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t0Task.id, t0Task.workflow_id, t0Task.name, t0Task.kind,
      t0Task.input_json, t0Task.output_json, t0Task.status,
      JSON.stringify(t0Task.depends_on),
      t0Task.executor_hint, t0Task.timeout_seconds, t0Task.max_retries,
      t0Task.retry_count, t0Task.retry_policy, t0Task.started_at,
      t0Task.completed_at, t0Task.created_at, t0Task.acceptance_criteria,
      t0Task.refine_count, t0Task.max_refine, t0Task.refine_feedback, t0Task.model,
      t0Task.hitl ? 1 : 0,
      t0Task.execution_mode ?? 'ephemeral',
      null,
      null,
    );

    // Move fix-tasks from the parent's task fan-out into the child.
    reparentFixTasksToChild(db, fixTaskIds, childWfId, t0TaskId);

    // FK linkage so the dashboard can resolve parent → child.
    linkRemediationToParent(db, childWfId, parentWfId);

    // Crosslink on the ORIGINAL parent task that produced the failing
    // review so the inspector can render "see remediation wf X" on the
    // failed task.
    setTaskRemediationLink(db, opts.sourceTaskId, childWfId);

    // Insert the HITL gate row. It is initially pending; if auto-approve
    // is enabled we resolve immediately INSIDE the same transaction so
    // the child runner sees the gate already approved when it loads.
    insertHitlGate(db, {
      id: gateId,
      workflow_id: childWfId,
      task_id: t0TaskId,
      gate_type: 'remediation',
      prompt: t0Task.name,
      context_json: JSON.stringify({
        remediation: {
          parent_workflow_id: parentWfId,
          source_parent_task_id: opts.sourceTaskId,
          fix_task_ids: fixTaskIds,
          budget_cap_usd: childBudgetCap,
        },
      }),
      channel: 'cli',
    });
    if (autoApproved) {
      resolveHitlGate(db, gateId, 'approved');
    }

    // Parent flips to awaiting_remediation. We don't write completed_at
    // because the workflow isn't done — only paused awaiting child outcome.
    setWorkflowStatus(db, parentWfId, 'awaiting_remediation');
  })();

  // Events fire OUTSIDE the transaction so a downstream subscriber error
  // doesn't roll back the linkage. Order matters for live UIs: parent
  // task first (the inspector listening to the parent task's stream sees
  // the remediation scheduled before the parent workflow goes into the
  // awaiting state).
  insertEvent(db, {
    workflow_id: parentWfId,
    task_id: opts.sourceTaskId,
    type: 'task_remediation_scheduled',
    payload: {
      child_workflow_id: childWfId,
      fix_task_ids: fixTaskIds,
      fix_task_count: fixTaskIds.length,
      hitl_gate_id: gateId,
      hitl_gate_task_id: t0TaskId,
      budget_cap_usd: childBudgetCap,
      budget_pct_of_remaining: budgetPct,
      auto_approved: autoApproved,
    },
  });
  insertEvent(db, {
    workflow_id: parentWfId,
    type: 'workflow_awaiting_remediation',
    payload: {
      child_workflow_id: childWfId,
      source_parent_task_id: opts.sourceTaskId,
      fix_task_count: fixTaskIds.length,
    },
  });
  // Symmetric event on the child for dashboards that subscribe to the
  // child's stream directly (no parent context in subscription scope).
  insertEvent(db, {
    workflow_id: childWfId,
    type: 'workflow_remediation_started',
    payload: {
      parent_workflow_id: parentWfId,
      source_parent_task_id: opts.sourceTaskId,
      fix_task_ids: fixTaskIds,
      budget_cap_usd: childBudgetCap,
      auto_approved: autoApproved,
    },
  });

  return {
    child_workflow_id: childWfId,
    fix_task_ids_scheduled: fixTaskIds,
    hitl_gate_id: gateId,
    hitl_gate_task_id: t0TaskId,
    budget_cap_usd: childBudgetCap,
    auto_approved: autoApproved,
  };
}

/**
 * Called when a child workflow finishes. Updates the parent's status
 * based on the child's outcome:
 *   - child completed → parent flips from 'awaiting_remediation' to
 *                       'completed' (if the parent has no further pending
 *                       tasks) — for now we simply mark parent completed
 *                       since the only way a parent enters
 *                       'awaiting_remediation' is by failing a quality
 *                       gate, which itself fails the parent task.
 *   - child failed    → parent flips to 'failed'.
 *
 * No-ops when the parent is not currently in 'awaiting_remediation' (e.g.
 * the operator cancelled it manually mid-remediation).
 *
 * Emits `workflow_remediation_completed` or `workflow_remediation_failed`
 * on the parent workflow.
 */
export function resolveParentAfterRemediation(
  db: Database.Database,
  parentWfId: string,
  childWfId: string,
  childOutcome: 'completed' | 'failed',
): void {
  const parent = loadWorkflowById(db, parentWfId);
  if (!parent) return;
  if (parent.status !== 'awaiting_remediation') return;

  // On child success the parent is considered completed because the child
  // cleared its fix-tasks under operator approval; on child failure the
  // parent fails too. The parent's task fan-out itself is already in
  // `failed` / `completed` state from the original loop — we don't
  // re-execute anything.
  const completed = childOutcome === 'completed';
  db.prepare(
    `UPDATE workflows SET status = ?, completed_at = ? WHERE id = ?`,
  ).run(completed ? 'completed' : 'failed', Date.now(), parentWfId);
  insertEvent(db, {
    workflow_id: parentWfId,
    type: completed ? 'workflow_remediation_completed' : 'workflow_remediation_failed',
    payload: { child_workflow_id: childWfId },
  });

  if (completed) {
    // Sweep the workflow_tasks: any tasks still in 'pending' (downstream
    // dependents of the failed task) stay pending and the operator can
    // resume the parent manually. We don't auto-resume because the parent
    // executor is no longer alive — see orchestrate.ts for the design.
    const pendingTasks = loadWorkflowTasks(db, parentWfId).filter(
      (t) => t.status === 'pending',
    );
    if (pendingTasks.length > 0) {
      insertEvent(db, {
        workflow_id: parentWfId,
        type: 'workflow_remediation_pending_tasks_remaining',
        payload: {
          pending_task_ids: pendingTasks.map((t) => t.id),
          pending_task_count: pendingTasks.length,
        },
      });
    }
  }
}
