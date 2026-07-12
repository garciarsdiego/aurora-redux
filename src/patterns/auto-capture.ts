// Week 3 / Task 2.3 — pattern auto-capture (D-H2.020).
//
// Called from the orchestrate.ts post-completion hook. Increments counters
// for an existing matching pattern; when 3+ successful runs share the
// same objective_shape and no auto-captured pattern exists yet, mints a
// new one so the next matching objective can short-circuit decomposition.
//
// Fail-safe: any DB error or unexpected state degrades silently. Pattern
// capture is a quality-of-life win, never path-critical.

import type Database from 'better-sqlite3';

import type { Pattern, Workflow } from '../types/index.js';
import {
  bumpPatternSuccess,
  findPatternByShape,
  insertEvent,
} from '../db/persist.js';
import { saveWorkflowAsPattern } from './store.js';
import { objectiveShape } from './shape.js';

const AUTO_CAPTURE_THRESHOLD = 3;
const AUTO_CAPTURE_NAME_PREFIX = 'auto:';

function sanitizeShapeForName(shape: string, maxLen = 60): string {
  const slug = shape
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.length <= maxLen ? slug : slug.slice(0, maxLen);
}

export interface AutoCaptureResult {
  outcome: 'bumped-existing' | 'auto-saved-new' | 'no-shape' | 'already-pattern' | 'matches-similar';
  patternId?: string;
  matchedShape?: string;
}

/**
 * Run after a workflow completes successfully. Bumps the existing pattern
 * counter when the shape matches and auto-saves a new pattern once the
 * threshold has been crossed and no auto-captured row exists yet.
 *
 * Returns an outcome enum so the orchestrate.ts hook can emit a single
 * `pattern_auto_capture` event with the reason.
 */
export function autoCaptureOnSuccess(
  db: Database.Database,
  workflow: Workflow,
  // Count of completed sibling workflows with the same shape (computed by
  // the caller from `workflows` table). Avoids us re-querying here.
  successfulSiblings: number,
): AutoCaptureResult {
  const shape = objectiveShape(workflow.objective);
  if (!shape) return { outcome: 'no-shape' };

  // If the workflow was already a pattern execution, skip — we don't want
  // to mint duplicates from the same source.
  if (workflow.pattern_id) return { outcome: 'already-pattern' };

  const existing = findPatternByShape(db, workflow.workspace, shape);
  if (existing) {
    bumpPatternSuccess(db, existing.id);
    return { outcome: 'bumped-existing', patternId: existing.id, matchedShape: shape };
  }

  // No pattern exists for this shape yet. Only auto-capture when enough
  // sibling workflows with the same shape have completed successfully.
  if (successfulSiblings < AUTO_CAPTURE_THRESHOLD) {
    return { outcome: 'matches-similar', matchedShape: shape };
  }

  // Mint a fresh auto-captured pattern based on this workflow.
  const slug = sanitizeShapeForName(shape) || 'pattern';
  const name = `${AUTO_CAPTURE_NAME_PREFIX}${slug}`;
  let pattern: Pattern;
  try {
    pattern = saveWorkflowAsPattern(db, workflow.id, name);
  } catch {
    // Most likely cause: UNIQUE(workspace, name) violation if another auto-
    // capture race already minted the row. Bail silently — the next
    // completion will find the row via findPatternByShape and bump it.
    return { outcome: 'matches-similar', matchedShape: shape };
  }
  pattern.source = 'auto-captured';
  pattern.objective_shape = shape;
  // Update the freshly-inserted row with the shape + source so
  // findPatternByShape finds it next time.
  db.prepare(
    `UPDATE patterns SET source = ?, objective_shape = ? WHERE id = ?`,
  ).run('auto-captured', shape, pattern.id);

  return { outcome: 'auto-saved-new', patternId: pattern.id, matchedShape: shape };
}

/**
 * Count of completed workflows in this workspace whose objective_shape
 * matches the target (excluding the just-completed workflow itself).
 * Used to drive the auto-capture threshold.
 */
export function countCompletedSiblingsWithShape(
  db: Database.Database,
  workspace: string,
  objective: string,
  excludeWorkflowId: string,
): number {
  const shape = objectiveShape(objective);
  if (!shape) return 0;
  // Pull recent completed workflows in the workspace and normalize on the
  // fly. We don't store objective_shape on the workflows table because it
  // would invalidate older rows; the cost of normalizing N strings is
  // negligible compared to the LLM cost of the workflows themselves.
  const rows = db
    .prepare(
      `SELECT id, objective FROM workflows
        WHERE workspace = ? AND status = 'completed' AND id != ?
        ORDER BY completed_at DESC NULLS LAST
        LIMIT 200`,
    )
    .all(workspace, excludeWorkflowId) as { id: string; objective: string }[];
  let count = 0;
  for (const row of rows) {
    if (objectiveShape(row.objective) === shape) count += 1;
  }
  return count;
}

/**
 * Combined entry-point used by orchestrate.ts: count siblings, run the
 * capture decision, emit a `pattern_auto_capture` event with the outcome
 * (or nothing when the shape is empty / workflow already used a pattern).
 */
export function runAutoCaptureHook(
  db: Database.Database,
  workflow: Workflow,
): AutoCaptureResult {
  try {
    const siblings = countCompletedSiblingsWithShape(
      db,
      workflow.workspace,
      workflow.objective,
      workflow.id,
    );
    const result = autoCaptureOnSuccess(db, workflow, siblings);
    if (result.outcome !== 'no-shape') {
      try {
        insertEvent(db, {
          workflow_id: workflow.id,
          task_id: null,
          type: 'pattern_auto_capture',
          payload: {
            outcome: result.outcome,
            pattern_id: result.patternId ?? null,
            matched_shape: result.matchedShape ?? null,
            siblings,
            threshold: AUTO_CAPTURE_THRESHOLD,
          },
        });
      } catch {
        // Audit-only; never block the workflow.
      }
    }
    return result;
  } catch {
    return { outcome: 'no-shape' };
  }
}
