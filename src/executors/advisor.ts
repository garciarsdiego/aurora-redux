// src/executors/advisor.ts
// In-process advisor dispatcher. Mirrors src/executors/pal.ts structure but
// routes to the native advisor registry instead of spawning a PAL subprocess.
//
// executor_hint format: "advisor:<name>"  e.g. "advisor:challenge"

import type { Task } from '../types/index.js';
import { getAdvisor } from '../v2/advisors/index.js';
import { safeParseJson } from '../utils/safe-parse-json.js';
// Side-effect import: triggers registerAdvisor(...) for all 15 advisors.
import '../v2/advisors/loader.js';

function resolveAdvisorName(hint: string | null | undefined): string | null {
  if (!hint?.startsWith('advisor:')) return null;
  return hint.slice('advisor:'.length).trim() || null;
}

function buildUserPrompt(task: Task): string {
  const lines: string[] = [`Task: ${task.name}`];
  if (task.acceptance_criteria) {
    lines.push(`Criteria: ${task.acceptance_criteria}`);
  }
  if (task.input_json) {
    // Wave 2 M1-W2-E (gap-closure 2026-05-12): silent JSON.parse replaced
    // by safeParseJson — runAdvisorTask does not own a db handle so the
    // event side-channel degrades to a silent null. Workflow context is
    // still threaded through for any future db-aware caller.
    const ctx = safeParseJson<Record<string, unknown>>(task.input_json, {
      where: 'advisor.buildUserPrompt',
      taskId: task.id,
      workflowId: task.workflow_id,
    });
    if (ctx && ctx['objective']) lines.push(`Context: ${ctx['objective']}`);
  }
  if (task.refine_feedback) {
    lines.push('', 'PREVIOUS ATTEMPT FEEDBACK:', task.refine_feedback);
  }
  lines.push('', 'Complete this task clearly and concisely.');
  return lines.join('\n');
}

export async function runAdvisorTask(task: Task, signal?: AbortSignal): Promise<string> {
  const name = resolveAdvisorName(task.executor_hint);
  if (!name) {
    throw new Error(
      `[advisor] executor_hint '${task.executor_hint ?? ''}' is not in 'advisor:<name>' format`,
    );
  }

  const advisor = getAdvisor(name);
  if (!advisor) {
    throw new Error(
      `[advisor] no advisor registered for name '${name}'. ` +
      `Ensure the advisor module is imported before this executor runs.`,
    );
  }

  // Wave 2 M1-W2-E (gap-closure 2026-05-12): IIFE-with-swallow replaced
  // with safeParseJson. Preserve the original semantics exactly:
  //   - input_json missing       → { prompt: buildUserPrompt(task) }
  //   - input_json parses         → the parsed value
  //   - input_json malformed      → {} (same as legacy)
  // The audit event differentiates a malformed payload from a legit empty
  // one so the operator sees a real parse failure in the timeline rather
  // than a mysteriously-empty arg block at the advisor.
  let args: unknown;
  if (task.input_json) {
    const parsed = safeParseJson<unknown>(task.input_json, {
      where: 'advisor.runAdvisorTask',
      taskId: task.id,
      workflowId: task.workflow_id,
    });
    args = parsed ?? {};
  } else {
    args = { prompt: buildUserPrompt(task) };
  }

  const result = await advisor.run(
    {
      workspace: task.workflow_id, // workflow_id used as workspace scope
      workflow_id: task.workflow_id,
      signal,
    },
    args,
  );

  return result.output;
}
