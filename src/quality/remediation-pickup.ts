/**
 * M1-W2 (Aurora dogfood-readiness, 2026-05-12): remediation child pickup loop.
 *
 * Wave 2 (2026-05-11) shipped `spawnRemediationWorkflow` behind the
 * `OMNIFORGE_AUTO_REMEDIATION` feature flag. The helper creates a child
 * workflow whose status is `pending` and parents it via `parent_workflow_id`,
 * but NOTHING scheduled the child for execution. Operator had to call
 * `run_workflow(child_id)` by hand, which made the feature unusable.
 *
 * This module closes the loop. At daemon startup (after migration 046's
 * `_daemon` sentinel row is in place), `pickupPendingRemediationWorkflows`
 * scans the DB for rows matching:
 *
 *     parent_workflow_id IS NOT NULL  AND  status = 'pending'
 *
 * and dispatches each one through `executeWorkflowInBackground` (the
 * extracted named export from `src/mcp/tools/run_workflow.ts`). The
 * dispatch is fire-and-forget — pickup returns immediately after launching
 * each child so daemon startup does not block on child execution. Errors
 * during dispatch are captured per-child and surfaced via stderr + the
 * `workflow_remediation_picked_up` audit event (with `error` field).
 *
 * Why startup-only (not periodic):
 *   - The W2 spawn already lives inside an in-process executor — when the
 *     daemon stays alive, the natural path is to dispatch the child via
 *     direct call from the spawn site. The pickup loop's job is solely
 *     CRASH RECOVERY: catch children orphaned by daemon kill between
 *     `INSERT pending child` and the in-process dispatch.
 *   - A periodic scan introduces double-dispatch risk (the same row could
 *     be picked up by both the live executor and a tick), and the
 *     additional complexity of a global Set across timer firings.
 *   - The trigger-orphan-retry sweep (Tier 0 Wave 4 0.4) follows the same
 *     "one-shot at startup" pattern for exactly the same reason; we keep
 *     consistency with that precedent.
 *
 * Idempotency:
 *   - The scan only matches `status = 'pending'`. As soon as the child is
 *     dispatched, `executeWorkflow` (via `continueWorkflowExecution`) flips
 *     its status to `executing`. A second invocation of
 *     `pickupPendingRemediationWorkflows` (e.g. test re-run) finds zero rows.
 *   - For belt-and-braces, the in-process Set `dispatchedThisInvocation`
 *     guards against a same-call double-pickup if the function is invoked
 *     re-entrantly from two daemons sharing a single DB (it shouldn't be,
 *     but the cost is one Set lookup).
 *
 * Sentinel workflow scope:
 *   - Audit events are emitted under `workflow_id = '_daemon'` (the
 *     sentinel row migration 046 supplies), matching the
 *     `daemon_recovery_sweep_completed` precedent.
 *   - Per-child events also fire under the child's own workflow_id so the
 *     dashboard timeline for that workflow shows the pickup.
 */
import type Database from 'better-sqlite3';
import { initDb } from '../db/client.js';
import { getDbPath } from '../utils/config.js';
import {
  insertEvent,
  loadWorkflowById,
  loadWorkflowTasks,
} from '../db/persist.js';
import { continueWorkflowExecution } from '../brain/executor/orchestrate.js';
import { redactContextText } from '../context/redaction.js';

export interface RemediationPickupResult {
  /** Number of pending remediation children successfully dispatched. */
  pickedUp: number;
  /** Number of pending children we attempted to dispatch but failed. */
  failed: number;
  /** Workflow ids dispatched in this call (for tests / observability). */
  dispatched: string[];
  /** Workflow ids that failed dispatch with their error messages. */
  errors: Array<{ workflow_id: string; error: string }>;
}

// In-process guard against same-call double-pickup. Cleared per daemon
// process (the module is imported fresh on each daemon start, so a restart
// naturally resets the set — exactly what we want for crash recovery).
const dispatchedThisInvocation = new Set<string>();

interface PendingChildRow {
  id: string;
  workspace: string;
  parent_workflow_id: string | null;
}

/**
 * Load pending remediation children. Only workflows with both:
 *   - `parent_workflow_id` not null
 *   - `status = 'pending'`
 * qualify. Tasks under the child are guaranteed to exist already (since
 * `spawnRemediationWorkflow` atomically inserts the workflow + t0 +
 * reparented fix-tasks in a single transaction — see migration 045 and
 * `src/quality/remediation.ts`).
 */
function listPendingRemediationChildren(db: Database.Database): PendingChildRow[] {
  return db
    .prepare(
      `SELECT id, workspace, parent_workflow_id
         FROM workflows
        WHERE parent_workflow_id IS NOT NULL
          AND status = 'pending'
        ORDER BY created_at ASC`,
    )
    .all() as PendingChildRow[];
}

/**
 * Dispatch a single child workflow. Opens a NEW DB handle for the child's
 * background lifetime (the caller's handle is dedicated to the scan and
 * will be closed when scanning completes). Errors are caught and surfaced
 * via the returned promise — they MUST NOT propagate to the caller because
 * one bad child should not abort pickup for the rest.
 */
async function dispatchChildWorkflow(
  childWfId: string,
  parentWfId: string,
  scanDb: Database.Database,
): Promise<void> {
  // Re-load via the scan DB to confirm the workflow row + tasks still exist
  // and the status is still 'pending'. Defends against a race where another
  // dispatcher (operator hand-call) beat us to it.
  const child = loadWorkflowById(scanDb, childWfId);
  if (!child) {
    throw new Error(`remediation-pickup: child workflow ${childWfId} vanished before dispatch`);
  }
  if (child.status !== 'pending') {
    // Race: the operator or another dispatcher started this child between
    // our scan and the dispatch. No-op; emit a skip event so the audit
    // trail records the path taken.
    insertEvent(scanDb, {
      workflow_id: childWfId,
      type: 'workflow_remediation_picked_up',
      payload: {
        parent_workflow_id: parentWfId,
        skipped: true,
        reason: 'status_changed_during_pickup',
        observed_status: child.status,
      },
    });
    return;
  }
  const tasks = loadWorkflowTasks(scanDb, childWfId);
  if (tasks.length === 0) {
    throw new Error(
      `remediation-pickup: child workflow ${childWfId} has no tasks rows — refusing to dispatch`,
    );
  }

  // Open an independent DB handle so the child's background execution
  // does not race the scan handle's close. The handle lives for the
  // duration of the child workflow and is closed in the .finally below.
  const bgDb = initDb(getDbPath());

  // Emit the "picked up" event on the SCAN DB (before dispatch) so the
  // audit trail captures the decision even if the bgDb open fails. The
  // event uses the child's workflow id so the dashboard shows it in the
  // child's timeline.
  insertEvent(scanDb, {
    workflow_id: childWfId,
    type: 'workflow_remediation_picked_up',
    payload: {
      parent_workflow_id: parentWfId,
      workspace: child.workspace,
      task_count: tasks.length,
      dispatcher: 'daemon_startup_pickup',
    },
  });

  // Fire-and-forget. The pickup function returns once all dispatches are
  // launched — the actual child workflow execution runs in the background
  // alongside the daemon's main HTTP server loop. Errors during execution
  // are persisted via setWorkflowDone(failed) inside the executor itself
  // and via the catch below for safety.
  void continueWorkflowExecution(bgDb, child)
    .catch((err) => {
      const rawMsg = err instanceof Error ? err.message : String(err);
      // A4-style redaction: LLM errors can echo back prompt content
      // (which may include secrets). Same precedent as run_workflow.ts.
      const safeMsg = redactContextText(rawMsg).slice(0, 400);
      process.stderr.write(
        `[remediation-pickup] child workflow ${childWfId} failed: ${safeMsg}\n`,
      );
      try {
        insertEvent(bgDb, {
          workflow_id: childWfId,
          type: 'workflow_background_error',
          payload: {
            source: 'remediation_pickup',
            error: safeMsg,
          },
        });
      } catch {
        /* terminal — the stderr line is the audit */
      }
    })
    .finally(() => {
      try {
        bgDb.close();
      } catch (closeErr) {
        const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        process.stderr.write(
          `[remediation-pickup] bgDb.close failed for ${childWfId}: ${closeMsg}\n`,
        );
      }
    });
}

/**
 * Scan for pending remediation children and dispatch each. Safe to call
 * once per daemon startup. Returns a count of picked-up / failed children.
 *
 * Behaviour contract:
 *   - Returns synchronously after launching all dispatches (does not await
 *     child execution).
 *   - Emits one `workflow_remediation_picked_up` event per child (under
 *     the child's workflow_id).
 *   - No-op when there are zero pending children — returns
 *     `{ pickedUp: 0, failed: 0, dispatched: [], errors: [] }` cleanly.
 *   - Errors per child are captured in `errors[]`; the function never
 *     throws for a single-child failure.
 *
 * @param db Open DB handle used for scanning. Caller retains ownership of
 *           the handle's lifetime (do NOT close it inside this function).
 *           The function opens its own per-child DB handles for the
 *           background dispatch lifetime.
 */
export async function pickupPendingRemediationWorkflows(
  db: Database.Database,
): Promise<RemediationPickupResult> {
  const result: RemediationPickupResult = {
    pickedUp: 0,
    failed: 0,
    dispatched: [],
    errors: [],
  };

  const candidates = listPendingRemediationChildren(db);
  if (candidates.length === 0) {
    return result;
  }

  for (const row of candidates) {
    // Re-entrancy guard: if the same call ever loops over the same id
    // (won't happen with the current scan, but cheap insurance), skip.
    if (dispatchedThisInvocation.has(row.id)) continue;
    if (row.parent_workflow_id === null) continue; // SQL filter already excludes, defensive

    try {
      await dispatchChildWorkflow(row.id, row.parent_workflow_id, db);
      dispatchedThisInvocation.add(row.id);
      result.pickedUp += 1;
      result.dispatched.push(row.id);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.failed += 1;
      result.errors.push({ workflow_id: row.id, error: errMsg });
      process.stderr.write(
        `[remediation-pickup] failed to dispatch ${row.id}: ${errMsg}\n`,
      );
      try {
        insertEvent(db, {
          workflow_id: row.id,
          type: 'workflow_remediation_picked_up',
          payload: {
            parent_workflow_id: row.parent_workflow_id,
            dispatched: false,
            error: errMsg,
          },
        });
      } catch {
        /* observability fallback — stderr is the audit */
      }
    }
  }

  return result;
}

/**
 * Test-only helper to reset the in-process dispatched set. Production
 * callers must NEVER use this — it would re-enable double-dispatch of a
 * still-running child workflow in the same process.
 */
export function _resetDispatchedSetForTesting(): void {
  dispatchedThisInvocation.clear();
}
