// PHASE-3 Tasks 3.2 + 3.3 — reflection store recorder + recaller.
//
// The recorder runs in the orchestrate.ts post-completion hook (between
// auto-capture and the final workflow_completed event) and writes a
// distilled record of the run. The recaller is consumed by the decomposer
// before composing the system prompt, and inserts a `## Past run lessons`
// block when prior reflections match the current objective.
//
// Fail-safe everywhere: any DB error degrades silently. Reflection is a
// quality-of-life improvement, never path-critical.

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

import type { Workflow, Task } from '../../types/index.js';
import { withSqliteRetrySync } from '../../db/sqlite-retry.js';
import { objectiveShape } from '../../patterns/shape.js';

export interface ReflectionRow {
  id: string;
  workspace: string;
  workflow_id: string;
  objective: string;
  objective_shape: string;
  outcome: 'success' | 'failure' | 'partial';
  plan_summary: string;
  lessons_learned: string;
  duration_ms: number;
  total_cost_usd: number | null;
  model_used: string | null;
  created_at: string;
}

/** Compact plan summary that captures the DAG shape without LLM output bulk. */
function buildPlanSummary(tasks: ReadonlyArray<Task>): string {
  const kindCounts: Record<string, number> = {};
  let hitlGates = 0;
  let refineLoops = 0;
  let failed = 0;
  for (const t of tasks) {
    kindCounts[t.kind] = (kindCounts[t.kind] ?? 0) + 1;
    if (t.hitl) hitlGates += 1;
    if ((t.refine_count ?? 0) > 0) refineLoops += 1;
    if (t.status === 'failed') failed += 1;
  }
  const parts = Object.entries(kindCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}=${count}`);
  return JSON.stringify({
    task_count: tasks.length,
    kinds: parts,
    hitl_gates: hitlGates,
    refine_loops: refineLoops,
    failed_tasks: failed,
  });
}

/**
 * Heuristic distillation of lessons from a workflow run. v0 is rule-based:
 * inspect terminal state + per-task statistics to emit a short bullet list.
 * Phase 4 can replace this with an LLM call (REVIEWER_MODEL) for richer
 * narrative summaries. The recorder must NEVER block workflow completion,
 * so we keep the cost predictable here.
 */
function distillLessons(workflow: Workflow, tasks: ReadonlyArray<Task>): string {
  const lines: string[] = [];
  const refined = tasks.filter((t) => (t.refine_count ?? 0) > 0);
  const failed = tasks.filter((t) => t.status === 'failed');
  const longRunning = tasks.filter((t) => {
    if (!t.started_at || !t.completed_at) return false;
    return t.completed_at - t.started_at > 60_000;
  });
  if (workflow.status === 'completed') {
    lines.push(`- Completed end-to-end in ${tasks.length} tasks.`);
  } else if (workflow.status === 'failed') {
    lines.push(`- Failed after ${tasks.length - failed.length}/${tasks.length} tasks.`);
    for (const t of failed.slice(0, 3)) {
      lines.push(`- Failure: ${t.name} (kind=${t.kind}). Review acceptance_criteria phrasing for sharper falsifiability.`);
    }
  }
  if (refined.length > 0) {
    lines.push(`- ${refined.length} task(s) needed refine loops. Consider tighter prompts upfront.`);
  }
  if (longRunning.length > 0) {
    const names = longRunning.slice(0, 2).map((t) => t.name).join('; ');
    lines.push(`- Long-running (>60s): ${names}. Consider parallelization or model swap.`);
  }
  if (lines.length === 0) {
    lines.push(`- Clean run with no refines, no failures, no slow tasks.`);
  }
  return lines.join('\n');
}

/**
 * PHASE-3 Task 3.2 — write a reflection row when a workflow completes.
 * Called from orchestrate.ts. Skips silently when the migration hasn't run
 * (older DBs) or any DB error occurs. Workflows that already ran from a
 * pattern still get a reflection — patterns reuse a DAG, but lessons
 * about *this run's* execution still matter.
 */
export function recordReflection(
  db: Database.Database,
  workflow: Workflow,
  tasks: ReadonlyArray<Task>,
  options: { totalCostUsd?: number | null; modelUsed?: string | null } = {},
): { ok: boolean; reason?: string; id?: string } {
  try {
    // Skip if the reflection_store table isn't there yet (migration 055
    // hasn't applied). Defensive — we don't want to crash workflows on a
    // DB upgrade gap.
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reflection_store'")
      .get();
    if (!tbl) return { ok: false, reason: 'migration_pending' };

    const shape = objectiveShape(workflow.objective);
    if (!shape) return { ok: false, reason: 'no_shape' };

    const outcome: ReflectionRow['outcome'] =
      workflow.status === 'completed'
        ? 'success'
        : workflow.status === 'failed'
          ? 'failure'
          : 'partial';
    const startedAt = workflow.started_at ?? Date.now();
    const completedAt = workflow.completed_at ?? Date.now();
    const duration = Math.max(0, completedAt - startedAt);

    const planSummary = buildPlanSummary(tasks);
    const lessons = distillLessons(workflow, tasks);
    const id = `rfl_${crypto.randomUUID()}`;

    withSqliteRetrySync(() =>
      db.prepare(
        `INSERT INTO reflection_store
         (id, workspace, workflow_id, objective, objective_shape, outcome,
          plan_summary, lessons_learned, duration_ms, total_cost_usd, model_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        workflow.workspace,
        workflow.id,
        workflow.objective,
        shape,
        outcome,
        planSummary,
        lessons,
        duration,
        options.totalCostUsd ?? null,
        options.modelUsed ?? null,
      ),
    );
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * PHASE-3 Task 3.3 — recall top-K reflections that match the current
 * objective. Uses FTS5 for keyword overlap then ranks by recency.
 * Empty result on any DB error (we never want to block decomposition).
 *
 * The decomposer's caller is expected to format the result via
 * `formatReflectionsForPrompt` before injecting into the system prompt.
 */
export function recallReflections(
  db: Database.Database,
  workspace: string,
  objective: string,
  k = 3,
): ReflectionRow[] {
  try {
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='reflection_fts'")
      .get();
    if (!tbl) return [];

    // Build a sanitized FTS5 query from the objective: drop punctuation,
    // strip stopwords, OR-join the remaining tokens. FTS5's MATCH syntax
    // is finicky about reserved chars, so we keep it dead-simple.
    const tokens = objective
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (tokens.length === 0) return [];

    const query = tokens.slice(0, 12).map((t) => `"${t}"`).join(' OR ');

    const rows = db
      .prepare(
        `SELECT r.* FROM reflection_fts f
           JOIN reflection_store r ON r.rowid = f.rowid
          WHERE f.reflection_fts MATCH ? AND r.workspace = ?
          ORDER BY r.created_at DESC
          LIMIT ?`,
      )
      .all(query, workspace, k) as ReflectionRow[];
    return rows;
  } catch {
    return [];
  }
}

/**
 * Render recall results as a `## Past run lessons` markdown block, ready
 * to be appended to the decomposer system prompt. Returns empty string
 * when no matches — the decomposer caller can just concatenate
 * unconditionally.
 */
export function formatReflectionsForPrompt(reflections: ReadonlyArray<ReflectionRow>): string {
  if (reflections.length === 0) return '';
  const lines: string[] = [];
  lines.push('## Past run lessons (recall, max 3)');
  lines.push('Lessons distilled from prior workflows in this workspace that touched a similar objective. Apply them when shaping the new DAG; do NOT cite by id.');
  lines.push('');
  for (const r of reflections) {
    lines.push(`### Run ${r.workflow_id.slice(0, 16)} — ${r.outcome}`);
    lines.push(`Objective: ${r.objective.slice(0, 200)}`);
    lines.push(r.lessons_learned);
    lines.push('');
  }
  return lines.join('\n');
}
