import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import { insertEvent } from '../../../db/persist.js';
import { getTaskQualityReviewMode } from '../../../utils/config.js';
import { enforceLightTaskQualityReview } from '../../../quality/task-reviewer.js';
import { createQualityFixTasks } from '../../../quality/fix-tasks.js';

/**
 * Runs the post-completion light quality review. When the gate flips a task
 * to needs_fixes / blocked in enforced mode, this helper creates the auto-fix
 * tasks (and optionally spawns a remediation workflow) BEFORE re-throwing
 * QualityGateFailedError so the executor unwinds with the source task in
 * failed state and the remediation row already enqueued.
 *
 * Returns the QualityReviewRow when the gate passes (legacy
 * `void qualityReviewResult` consumer treats the return as opaque).
 */
export async function runQualityGate(
  db: Database.Database,
  task: Task,
  wfId: string,
): Promise<import('../../../quality/types.js').QualityReviewRow | null> {
  const taskQualityReviewMode = getTaskQualityReviewMode();
  if (taskQualityReviewMode === 'off') return null;

  // Tier 0 Wave 3 (ITEM 0.6) — when the light quality gate fires
  // needs_fixes / blocked under enforced mode, enforceLightTaskQualityReview
  // throws QualityGateFailedError. Instead of letting the operator
  // re-prompt by hand, create a quality fix task BEFORE re-throwing so
  // the workflow itself enqueues the remediation. The original error
  // still propagates so the source task is marked failed.
  try {
    return await enforceLightTaskQualityReview(db, {
      workflowId: wfId,
      taskId: task.id,
      mode: taskQualityReviewMode,
    });
  } catch (gateErr) {
    const { QualityGateFailedError } = await import('../../../quality/task-reviewer.js');
    if (gateErr instanceof QualityGateFailedError) {
      try {
        const fixResult = createQualityFixTasks(db, gateErr.review);
        const fixIds = [
          ...fixResult.created.map((t) => t.id),
          ...fixResult.existing.map((t) => t.id),
        ];
        // QualityReviewRow stores issues as JSON; parse defensively so a
        // malformed payload cannot mask the original gate failure.
        let issuesCount = 0;
        try {
          const parsed = JSON.parse(gateErr.review.issues_json) as unknown;
          if (Array.isArray(parsed)) issuesCount = parsed.length;
        } catch { /* legacy / malformed — count stays 0 */ }
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_quality_gate_auto_fix_created',
          payload: {
            source_task_id: task.id,
            fix_task_ids: fixIds,
            fix_tasks_created: fixResult.created.length,
            fix_tasks_existing: fixResult.existing.length,
            issues_count: issuesCount,
            review_id: gateErr.review.id,
            review_outcome: gateErr.review.outcome,
          },
        });

        // W2 (2026-05-11): when auto-remediation is enabled, spawn a
        // child workflow whose DAG is [t0 HITL gate, ...fix-tasks].
        // Parent flips to 'awaiting_remediation' inside the spawn
        // helper. The original gate error STILL throws below so the
        // parent's failing task lands in `failed` and the executor
        // unwinds out of the current loop iteration — the child
        // workflow runs as an independent run owned by the daemon
        // (via the dashboard / MCP `run_workflow` codepath).
        //
        // When the feature flag is off (default), this whole block
        // is skipped so the legacy "operator scheduled this manually"
        // behaviour is preserved verbatim. The fix-task rows still
        // sit in DB; the operator can pick them up by hand.
        if (process.env.OMNIFORGE_AUTO_REMEDIATION === 'true' && fixIds.length > 0) {
          try {
            const { spawnRemediationWorkflow } = await import('../../../quality/remediation.js');
            spawnRemediationWorkflow(db, wfId, fixIds, { sourceTaskId: task.id });
          } catch (spawnErr) {
            // Spawn must NOT mask the original gate failure. Audit + fall
            // through to the existing throw so the operator can still see
            // the blocked task and the orphan fix-tasks in DB.
            insertEvent(db, {
              workflow_id: wfId,
              task_id: task.id,
              type: 'task_remediation_spawn_error',
              payload: {
                error: spawnErr instanceof Error ? spawnErr.message : String(spawnErr),
                review_id: gateErr.review.id,
              },
            });
          }
        }
      } catch (fixErr) {
        // Auto-fix creation must NOT mask the original gate failure.
        // Emit an audit event and continue throwing the gate error so
        // the operator still sees the blocked task.
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_quality_gate_auto_fix_error',
          payload: {
            error: fixErr instanceof Error ? fixErr.message : String(fixErr),
            review_id: gateErr.review.id,
          },
        });
      }
    }
    throw gateErr;
  }
}
