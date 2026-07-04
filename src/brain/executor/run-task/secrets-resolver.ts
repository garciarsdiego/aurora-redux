import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import { insertEvent } from '../../../db/persist.js';
import { resolveSecrets } from '../../../mcp/routes/dashboard-secrets.js';
import { scanForInjection } from '../../../v2/injection-scan/index.js';

export function resolveTaskSecrets(
  task: Task,
  workspace: string,
  db: Database.Database,
  workflowId?: string,
): void {
  if (!workspace) return;
  if (task.input_json) {
    task.input_json = resolveSecrets(task.input_json, workspace, db);
  }
  if (task.name) {
    task.name = resolveSecrets(task.name, workspace, db);
  }
  if (task.acceptance_criteria) {
    task.acceptance_criteria = resolveSecrets(task.acceptance_criteria, workspace, db);
  }
  if (task.refine_feedback) {
    task.refine_feedback = resolveSecrets(task.refine_feedback, workspace, db);
    // M1-W1-B (A7) — refine_feedback is LLM-authored (reviewer output piped
    // back into the worker prompt). Scan it for injection patterns the same
    // way we scan task.input_json above. Without this, a hostile reviewer
    // (or a poisoned upstream task whose output flowed into the reviewer's
    // own prompt) could smuggle directives into the worker turn.
    //
    // The scan honors INJECTION_SCAN_ENFORCE (default true): on enforce we
    // emit `task_injection_blocked` + drop the feedback BEFORE the worker
    // ever sees it (re-throwing would also work, but dropping is the less
    // intrusive default — the next refine attempt simply runs without the
    // tainted feedback, preserving forward progress).
    const refineScan = scanForInjection(task.refine_feedback);
    if (!refineScan.safe) {
      if (workflowId) {
        try {
          insertEvent(db, {
            workflow_id: workflowId,
            task_id: task.id,
            type: 'task_injection_detected',
            payload: {
              score: refineScan.score,
              flags: refineScan.flags,
              site: 'refine_feedback',
            },
          });
        } catch { /* observability is best-effort */ }
      }
      const enforce = process.env.INJECTION_SCAN_ENFORCE !== 'false';
      if (enforce) {
        if (workflowId) {
          try {
            insertEvent(db, {
              workflow_id: workflowId,
              task_id: task.id,
              type: 'task_injection_blocked',
              payload: {
                score: refineScan.score,
                threshold: 0.5,
                flags: refineScan.flags.map((f) => f.pattern),
                site: 'refine_feedback',
              },
            });
          } catch { /* observability is best-effort */ }
        }
        // Drop the tainted feedback so the worker's next turn proceeds
        // without it. Preserves forward progress while preventing the
        // injection payload from reaching the LLM prompt.
        task.refine_feedback = null;
      } else {
        process.stderr.write(
          `[injection-scan] refine_feedback for task '${task.name}' flagged (score=${refineScan.score.toFixed(2)}) — INJECTION_SCAN_ENFORCE=false, passing through anyway\n`,
        );
      }
    }
  }
}
