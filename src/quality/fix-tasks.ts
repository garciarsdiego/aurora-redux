import type Database from 'better-sqlite3';
import {
  insertEvent,
  insertTask,
  loadWorkflowTasks,
  newTaskId,
} from '../db/persist.js';
import type { Task, TaskKind } from '../types/index.js';
import { parseQualityFixTasks } from './store.js';
import { safeParseJson } from './internal-utils.js';
import type { QualityReviewRow } from './types.js';

const ALLOWED_FIX_KINDS = new Set<TaskKind>([
  'llm_call',
  'cli_spawn',
  'pal_call',
  'tool_call',
  'if_else',
  'switch',
  'extract_json',
  'print',
  'loop',
  'merge',
  'transform',
  'evaluator',
]);

export interface CreateQualityFixTasksResult {
  created: Task[];
  existing: Task[];
}

function normalizeKind(kind: string): TaskKind {
  return ALLOWED_FIX_KINDS.has(kind as TaskKind) ? kind as TaskKind : 'cli_spawn';
}

function existingFixTasksForReview(
  db: Database.Database,
  workflowId: string,
  reviewId: string,
): Task[] {
  // Parse input_json and check quality_fix.source_review_id instead of a
  // substring match on the serialized JSON — the substring approach silently
  // broke deduplication if the JSON was ever re-serialized with different
  // spacing/key order (e.g. by a migration or UPDATE).
  return loadWorkflowTasks(db, workflowId).filter((task) => {
    const qualityFix = safeParseJson(task.input_json)['quality_fix'];
    return !!qualityFix
      && typeof qualityFix === 'object'
      && (qualityFix as Record<string, unknown>)['source_review_id'] === reviewId;
  });
}

function defaultDependsOn(tasks: Task[]): string[] {
  return tasks
    .filter((task) => task.status === 'completed' || task.status === 'failed' || task.status === 'skipped')
    .map((task) => task.id);
}

// Wave 2 security-review H2: keys an LLM-authored quality review must NOT
// be allowed to set via fix-task metadata, because the executor reads them
// from task.input_json and an LLM-supplied value would bypass the parent
// workflow's workspace/profile boundary at execution time.
const FORBIDDEN_METADATA_KEYS = new Set<string>([
  'workspace',
  'workspace_dir',
  'workspaceDir',
  'cwd',
  'profile',
  'execution_mode',
  'executionMode',
  'env',
  'environment',
]);

function sanitizeFixTaskMetadata(
  metadata: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (metadata === undefined || metadata === null || typeof metadata !== 'object') {
    return {};
  }
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function createQualityFixTasks(
  db: Database.Database,
  review: QualityReviewRow,
): CreateQualityFixTasksResult {
  const existing = existingFixTasksForReview(db, review.workflow_id, review.id);
  if (existing.length > 0) return { created: [], existing };

  const drafts = parseQualityFixTasks(review);
  if (drafts.length === 0) return { created: [], existing: [] };

  const workflowTasks = loadWorkflowTasks(db, review.workflow_id);
  const fallbackDependsOn = defaultDependsOn(workflowTasks);
  const now = Date.now();
  const created = drafts.map((draft, index): Task => {
    const kind = normalizeKind(draft.kind);
    const dependsOn = draft.dependsOn && draft.dependsOn.length > 0
      ? draft.dependsOn
      : fallbackDependsOn;
    return {
      id: newTaskId(),
      workflow_id: review.workflow_id,
      name: draft.title,
      kind,
      input_json: JSON.stringify({
        objective: draft.objective,
        quality_fix: {
          source: 'final_quality_reviewer',
          source_review_id: review.id,
          source_issue_index: index,
          review_outcome: review.outcome,
          // Wave 2 security-review H2: an LLM-authored review could smuggle
          // a `workspace` key (or other executor-honoured override) into
          // draft.metadata, bypassing the parent workflow's workspace
          // boundary when the fix task is run. Strip executor-targeting
          // keys here; the rest of the metadata stays for audit/debug.
          metadata: sanitizeFixTaskMetadata(draft.metadata),
        },
      }),
      output_json: null,
      status: 'pending',
      depends_on: dependsOn,
      executor_hint: kind === 'cli_spawn' ? 'cli:codex' : null,
      timeout_seconds: 300,
      max_retries: 3,
      retry_count: 0,
      retry_policy: 'exponential',
      started_at: null,
      completed_at: null,
      created_at: now + index,
      acceptance_criteria: draft.acceptanceCriteria,
      refine_count: 0,
      max_refine: 2,
      refine_feedback: null,
      model: null,
      hitl: false,
      execution_mode: 'ephemeral',
    };
  });

  for (const task of created) insertTask(db, task);
  insertEvent(db, {
    workflow_id: review.workflow_id,
    type: 'workflow_quality_fix_tasks_created',
    payload: {
      review_id: review.id,
      task_ids: created.map((task) => task.id),
      task_count: created.length,
      review_outcome: review.outcome,
    },
  });

  return { created, existing: [] };
}
