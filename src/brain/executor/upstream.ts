import type Database from 'better-sqlite3';
import type { Task } from '../../types/index.js';
import type { ReviewOutcome } from '../../v2/reviewer/outcome.js';
import { applySelector, type SelectorValue } from '../../v2/contracts/apply-selectors.js';
import type { AgentMessage } from '../../v2/context-engine/types.js';
import { resolve as pathResolve, sep } from 'node:path';
import { insertEvent } from '../../db/persist.js';
import { loadArtifactsForTask, loadArtifactContent } from '../../artifacts/store.js';
import { safeParseJson } from '../../utils/safe-parse-json.js';
import { worktreeStatus, type WorktreeStatus } from '../../utils/git-worktree.js';
import type { UpstreamResult } from './types.js';

export interface CliTaskConfig {
  workspace?: string;
  read_only?: boolean;
  execution_context?: {
    worktree_root?: string;
    lineage?: { workspace?: string; workflow_id?: string };
  };
}

/**
 * Reconstruct the cli_spawn worktree root from the config persisted in
 * input_json (the executor materialises execution_context + workspace there).
 * Mirrors the default path in git-worktree.ts (data/worktrees/<ws>/<wfId>) when
 * an explicit worktree_root isn't recorded. Returns null when we can't tell.
 */
export function deriveWorktreeRoot(cfg: CliTaskConfig, wfId: string): string | null {
  const ec = cfg.execution_context;
  if (ec?.worktree_root) return pathResolve(ec.worktree_root);
  const workspace = cfg.workspace ?? ec?.lineage?.workspace;
  if (!workspace) return null;
  // workspace originates from the (LLM-authored) DAG input_json; defensively
  // confine the resolved path under data/worktrees so a traversal value
  // ("../../etc") can't point the git probe at an arbitrary directory.
  const base = pathResolve('data', 'worktrees');
  const resolved = pathResolve(base, workspace, wfId);
  return resolved.startsWith(`${base}${sep}`) ? resolved : null;
}

/**
 * Convenience: parse a task's input_json and derive its worktree root. Returns
 * null when input_json is absent/malformed or no worktree path can be derived.
 * Shared by the cli_spawn evidence grade and the Wave-1 precommit gate.
 */
export function deriveTaskWorktreeRoot(task: Task, wfId: string): string | null {
  const cfg = safeParseJson<CliTaskConfig>(task.input_json, {
    workflowId: wfId,
    taskId: task.id,
    where: 'derive_task_worktree_root',
  });
  if (!cfg) return null;
  return deriveWorktreeRoot(cfg, wfId);
}

/**
 * cli_spawn evidence-of-work grade (Aurora-parity Wave 0 / F-LIVE-5): a coding
 * cli_spawn that emits prose but writes ZERO files gets a soft_failure REVIEW
 * SIGNAL rather than hard_success.
 *
 * SCOPE OF THIS GRADE: emitBasicReviewOutcome only runs on the no-acceptance-
 * criteria path and records a `task_review_outcome` event — it is an AUDIT /
 * dashboard signal, NOT a hard gate. The task still completes; the signal makes
 * the "talked but didn't act" case visible to the operator (and to Wave-5
 * failure clustering). Tasks WITH acceptance_criteria go through the full
 * reviewer/refine loop instead, which is where blocking enforcement lives.
 *
 * Scoped conservatively to avoid false positives:
 *   - only when the task DECLARED file_scope (positive intent to modify files);
 *     analysis/exploration cli_spawn (no file_scope) is graded by output presence;
 *   - downgrades ONLY when a worktree positively exists and is clean; preserves
 *     hard_success when the worktree can't be inspected ('unavailable') or the
 *     task is marked read_only.
 *
 * KNOWN LIMITATIONS (acceptable for a conservative first cut; revisit with the
 * Wave-3 commit-per-task work):
 *   - worktreeStatus only sees UNCOMMITTED changes, so if an agent commits its
 *     work the worktree reads 'clean' (false soft_failure signal);
 *   - the worktree is per-WORKFLOW, not per-task, so a later task's grade
 *     reflects the aggregate dirty state, not its own delta.
 */
function gradeCliSpawnOutput(
  db: Database.Database,
  wfId: string,
  task: Task,
  output: string,
): ReviewOutcome {
  if (!output.trim() || output.trim() === '(empty output)') {
    return { outcome_type: 'soft_failure', confidence: 0, feedback: 'cli_spawn returned empty output', next_action: 'abort' };
  }
  const declaredFileScope = Array.isArray(task.file_scope) && task.file_scope.length > 0;
  if (!declaredFileScope) {
    // No declared intent to modify files (analysis / exploratory) → presence of
    // output is sufficient, matching the historic behaviour.
    return { outcome_type: 'hard_success', confidence: 1 };
  }
  const cfg = safeParseJson<CliTaskConfig>(task.input_json, {
    db,
    workflowId: wfId,
    taskId: task.id,
    where: 'cli_spawn_evidence_grade',
  }) ?? {};
  if (cfg.read_only === true) {
    return { outcome_type: 'hard_success', confidence: 1 };
  }
  const worktreeRoot = deriveWorktreeRoot(cfg, wfId);
  const status: WorktreeStatus = worktreeRoot ? worktreeStatus(worktreeRoot) : 'unavailable';
  if (status === 'clean') {
    return {
      outcome_type: 'soft_failure',
      confidence: 0,
      feedback:
        'cli_spawn declared file_scope but changed no files in its worktree — the agent likely described the work instead of doing it. If this task is intentionally read-only, set read_only: true on it.',
      next_action: 'refine',
    };
  }
  return { outcome_type: 'hard_success', confidence: 1 };
}

export async function collectUpstreamArtifacts(
  db: Database.Database,
  dependsOn: string[],
  selectors?: Record<string, SelectorValue>,
  summarizedUpstreams?: Record<string, string>,
): Promise<UpstreamResult | null> {
  if (dependsOn.length === 0) return null;
  const parts: string[] = [];
  const slicedEvents: UpstreamResult['slicedEvents'] = [];

  for (const taskId of dependsOn) {
    const selector = selectors?.[taskId];

    // Bloco 1.5: prefer pre-computed summary unless caller opted into raw
    const precomputed = summarizedUpstreams?.[taskId];
    if (precomputed && selector !== 'raw_full') {
      parts.push(precomputed);
      continue;
    }

    const artifacts = await loadArtifactsForTask(db, taskId);
    for (const artifact of artifacts) {
      const content = await loadArtifactContent(artifact);
      if (!content) continue;
      if (selector && selector !== 'raw_full') {
        const { sliced, tokensBefore, tokensAfter } = applySelector(content, selector);
        parts.push(sliced);
        slicedEvents.push({ upstream_task_id: taskId, selector, tokensBefore, tokensAfter });
      } else {
        parts.push(content);
      }
    }
  }
  if (parts.length === 0) return null;
  return { content: parts.join('\n\n---\n\n'), slicedEvents };
}

export function emitBasicReviewOutcome(
  db: Database.Database,
  wfId: string,
  task: Task,
  output: string,
): void {
  let outcome: ReviewOutcome;

  switch (task.kind) {
    case 'tool_call': {
      let success = false;
      try {
        const parsed = JSON.parse(output) as { success?: unknown };
        success = parsed.success === true;
      } catch { /* malformed JSON → treat as failure */ }
      outcome = success
        ? { outcome_type: 'hard_success', confidence: 1 }
        : { outcome_type: 'soft_failure', confidence: 0, feedback: 'ToolResult.success was false or output malformed', next_action: 'abort' };
      break;
    }
    case 'pal_call': {
      const empty = !output.trim() || output.trim() === '(empty output)';
      outcome = empty
        ? { outcome_type: 'soft_failure', confidence: 0, feedback: 'pal_call returned empty output', next_action: 'abort' }
        : { outcome_type: 'hard_success', confidence: 1 };
      break;
    }
    case 'cli_spawn': {
      outcome = gradeCliSpawnOutput(db, wfId, task, output);
      break;
    }
    default: {
      const empty = !output.trim();
      outcome = empty
        ? { outcome_type: 'soft_failure', confidence: 0, feedback: 'llm_call returned empty output', next_action: 'abort' }
        : { outcome_type: 'hard_success', confidence: 1 };
      break;
    }
  }

  insertEvent(db, {
    workflow_id: wfId,
    task_id: task.id,
    type: 'task_review_outcome',
    payload: outcome,
  });
}

// Minimal message list for context compaction (Bloco 1.1).
// Bloco 1.4 (typed contracts) will refine with full inter-task payloads.
//
// Optional `db` + `workflowId` are accepted so a malformed input_json shows
// up in the audit timeline. The historic call sites do not have a workflow
// context (the function is invoked from compaction-on-failover, which
// doesn't thread it through), so the audit emission degrades to a silent
// null in that case — preserving the existing fallback semantics.
export function buildMessagesFromTask(
  task: Task,
  db?: Database.Database,
  workflowId?: string,
): AgentMessage[] {
  const input = safeParseJson<Record<string, unknown>>(task.input_json, {
    where: 'build_messages_from_task',
    taskId: task.id,
    ...(db ? { db } : {}),
    ...(workflowId ? { workflowId } : {}),
  }) ?? {};

  const messages: AgentMessage[] = [
    {
      id: 'task-context',
      role: 'system',
      content: `Task: ${task.name}\nAcceptance criteria: ${task.acceptance_criteria ?? 'none'}`,
    },
    {
      id: 'task-objective',
      role: 'user',
      content: typeof input['objective'] === 'string' ? input['objective'] : JSON.stringify(input),
    },
  ];

  if (input['upstream_artifacts']) {
    messages.push({
      id: 'upstream-context',
      role: 'assistant',
      content: `Upstream context: ${JSON.stringify(input['upstream_artifacts'])}`,
    });
  }

  return messages;
}
