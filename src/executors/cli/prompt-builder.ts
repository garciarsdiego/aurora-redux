// =============================================================================
// prompt-builder.ts — assemble the textual prompt fed to a spawned CLI.
//
// Scope: takes a `Task` + its resolved `TaskExecutionContext` and builds the
// multi-section prompt that gets either piped to stdin or appended as the
// final positional argument (per `CliSpec.promptDelivery`).
//
// Sections layered in order:
//   1. Task name + (optional) persona transition prefix
//   2. cli-specific guidance (registry entry; e.g. Gemini gets a UTF-8 nudge)
//   3. acceptance criteria
//   4. EXECUTION_CONTEXT block (PROJECT_ROOT / CWD / OUTPUT_DIR + BASE_REF)
//   5. Upstream context (objective, upstream_artifacts, carry_from_upstream)
//   6. Previous-attempt refine feedback (only on retry)
//
// IMPORTANT — preserve the D34.5 / handoff-wire comment blocks. They pin the
// invariant "parallel/cascading tasks reinvent and diverge" without them.
// =============================================================================

import type { Task } from '../../types/index.js';
import type { TaskExecutionContext } from '../../utils/execution-context.js';
import { getCliGuidance } from '../../v2/model-guidance/registry.js';
import { getUsePersonas } from '../../utils/config.js';
import { getTransitionContextFromALS, formatTransitionPrefix } from '../../v2/agents/transition-context.js';
import { safeParseJson } from '../../utils/safe-parse-json.js';

export function buildPrompt(task: Task, executionContext: TaskExecutionContext | null): string {
  const lines: string[] = [`Task: ${task.name}`];
  const transition = getUsePersonas() ? getTransitionContextFromALS() : undefined;
  if (transition) {
    lines.push('', formatTransitionPrefix(transition));
  }
  const cliGuidance = getCliGuidance(task.executor_hint);
  if (cliGuidance) lines.push('', cliGuidance);
  if (task.acceptance_criteria) {
    lines.push(`Criteria: ${task.acceptance_criteria}`);
  }

  if (executionContext) {
    lines.push(
      '',
      'EXECUTION_CONTEXT:',
      `- PROJECT_ROOT: ${executionContext.project_root}`,
      `- CWD: ${executionContext.cwd}`,
      `- OUTPUT_DIR: ${executionContext.output_dir}`,
    );
    if (executionContext.base_ref) {
      lines.push(`- BASE_REF: ${executionContext.base_ref}`);
    }
    lines.push(
      'Treat PROJECT_ROOT as the canonical working codebase root for this task.',
      'Run repo-aware commands from CWD unless the task explicitly requires a deeper subdirectory.',
      "Write generated artifacts to OUTPUT_DIR. If the task edits source files, keep those edits under PROJECT_ROOT instead of guessing a different repo or run folder.",
      "When the task or criteria mentions 'workspaces/internal/runs/<wfId>/...' or any <wfId> placeholder, use OUTPUT_DIR — do NOT pick a different run directory from `ls`.",
    );
  }

  if (task.input_json) {
    // M2-A1 split lost the W2-E safeParseJson migration; re-apply.
    const ctx = safeParseJson<Record<string, unknown>>(task.input_json, {
      where: 'cli_prompt_builder',
      taskId: task.id,
    });
    if (ctx) {
      if (ctx['objective']) lines.push(`Context: ${String(ctx['objective'])}`);
      // D34.5 — include upstream artifacts so the CLI sees conventions from
      // dependency tasks (folder names, libs, type shapes already decided upstream).
      // Without this, parallel/cascading tasks reinvent and diverge.
      if (ctx['upstream_artifacts']) {
        lines.push(
          '',
          'UPSTREAM CONTEXT (outputs from dependency tasks — use these conventions, do not reinvent):',
          String(ctx['upstream_artifacts']),
        );
      }
      // Bounded carry — compact handoff sections (Summary/Artifacts/Risks/Next)
      // from each direct parent. Built by src/v2/handoff/wire.ts in run-task.ts.
      // Surfaced after upstream_artifacts so the worker sees the per-parent
      // structured handoff explicitly, not just the raw artifact dump.
      if (ctx['carry_from_upstream']) {
        lines.push(
          '',
          'CARRY FROM UPSTREAM (parsed handoff from each parent — use Summary, Artifacts, Risks, Next):',
          String(ctx['carry_from_upstream']),
        );
      }
    }
  }
  if (task.refine_feedback) {
    lines.push('', 'PREVIOUS ATTEMPT FEEDBACK:', task.refine_feedback);
  }

  lines.push('', 'Complete this task clearly and concisely.');
  return lines.join('\n');
}
