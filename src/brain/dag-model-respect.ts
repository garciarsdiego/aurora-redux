// Post-decompose validator: enforces operator-specified models against the
// decomposer's choices. The decomposer system prompt asks the LLM to preserve
// verbatim model strings from the objective, but the LLM may still drift
// (catalog matching, "closest match" instinct). This validator catches drift
// and overrides on the parsed DAG before execution starts.
//
// Example smoke test 2026-05-01 round 3 — without this, cx/gpt-5.5 silently
// became cx/gpt-5.4 and opencode-go/X lost its prefix. Required SQL UPDATE
// post-dispatch + 6 patches to restore the multi-CLI plan.

import type { Dag, DagTask } from '../types/index.js';

export interface ModelRespectFix {
  task_name: string;
  decomposer_chose: string | null | undefined;
  operator_intended: string;
}

/**
 * Parse the objective text for explicit `model: <id>` directives bound to a
 * task name. Recognized patterns (multi-line / loose):
 *   tN — cli:<X> (model: <model_id>) writes ...
 *   tN — cli:<X> writes ... model = <model_id>
 *   "cli:codex (model: cx/gpt-5.5)"
 *
 * Returns map { task_name → operator_intended_model } for tasks whose names
 * appear in the objective AND have an explicit model directive nearby.
 */
export function parseOperatorModels(objective: string): Map<string, string> {
  const out = new Map<string, string>();
  // Match patterns like "cli:<cli> (model: <id>)" or "(model: <id>)"
  // captured groups: full task line + the model id
  // We scan line by line so the line-anchor for the task name is the same
  // physical line as the model directive.
  const lines = objective.split(/\r?\n/);
  const modelDirective = /\(model\s*:\s*([^\s)]+)\s*\)/i;

  for (const line of lines) {
    const mModel = modelDirective.exec(line);
    if (!mModel) continue;
    const modelId = mModel[1];
    if (!modelId) continue;
    // Find a "Create X" / "Add X" / "Implement X" verb close to the model
    // directive — the task NAME is what the decomposer will use, and we want
    // to bind the model to it.
    const nameVerbs = /(?:Create|Add|Implement|Write|Build|Refactor|Update)\s+([^.]{4,80})/i;
    const mName = nameVerbs.exec(line);
    if (!mName) continue;
    const namePrefix = mName[1].trim().slice(0, 30);
    out.set(namePrefix.toLowerCase(), modelId);
  }
  return out;
}

/**
 * Walk the DAG and override task.model where the objective specified an
 * explicit model directive but the decomposer chose differently. Returns the
 * list of fixes applied so the caller can log them.
 *
 * Match heuristic: task.name starts (case-insensitive) with the operator's
 * Create/Add/Implement/... noun phrase. This is fuzzy by design — the
 * decomposer renames tasks freely, but the leading verb+object usually
 * survives. False negatives (no fix) are safe (decomposer's choice stands).
 * False positives (wrong fix) are unlikely given the 4-30 char prefix match.
 */
export function enforceOperatorModels(
  dag: Dag,
  objective: string,
): { dag: Dag; fixes: ModelRespectFix[] } {
  const operatorModels = parseOperatorModels(objective);
  if (operatorModels.size === 0) {
    return { dag, fixes: [] };
  }
  const fixes: ModelRespectFix[] = [];
  const newTasks: DagTask[] = dag.tasks.map((task) => {
    const taskName = (task.name ?? '').toLowerCase();
    for (const [namePrefix, intendedModel] of operatorModels) {
      if (taskName.startsWith(namePrefix.slice(0, 20))) {
        if (task.model !== intendedModel) {
          fixes.push({
            task_name: task.name ?? '(unnamed)',
            decomposer_chose: task.model,
            operator_intended: intendedModel,
          });
          return { ...task, model: intendedModel };
        }
      }
    }
    return task;
  });
  return { dag: { ...dag, tasks: newTasks }, fixes };
}
