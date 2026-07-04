import type Database from 'better-sqlite3';
import type { Task } from '../../../types/index.js';
import type { SelectorValue } from '../../../v2/contracts/apply-selectors.js';
import { insertEvent, setTaskFailed } from '../../../db/persist.js';
import { scanForInjection } from '../../../v2/injection-scan/index.js';
import { safeParseJson } from '../../../utils/safe-parse-json.js';
import {
  DEFAULT_COMPACTION_SETTINGS,
  maybeCompact,
} from '../../../v2/context-engine/compaction.js';
import {
  getCarryFromUpstreamMaxChars,
  getCarryFromUpstreamEnabled,
  getAutoCompactThreshold,
} from '../../../utils/config.js';
import { buildCarryFromUpstream } from '../../../v2/handoff/wire.js';
import { collectUpstreamArtifacts } from '../upstream.js';
import {
  assertWorkflowBudgetAllowsModelCall,
  assertGlobalBudgetAllowsModelCall,
} from '../../../v2/budget/control.js';
import { enforceWorkflowCostCapBeforeTask, estimateUpcomingCost } from '../cost-cap.js';
import { runHitlGate } from '../hitl-gate.js';

import { checkAborted } from './cancel.js';
import { emitContextCompactionEvent } from './context-packet.js';
import {
  dispatchToolCallPrep,
} from './dispatchers/index.js';

// Pre-dispatch phase — everything that must run BEFORE we acquire a lease
// and enter the retry loop. Aggregates HITL gating, upstream-artifact
// collection, the carry-from-upstream wire, tool-policy approval, budget
// assertion, prompt-injection scan, and the workflow cost-cap check.
//
// Mutates `task.input_json` in-place to inject upstream artifacts and the
// carry block, matching the legacy behaviour. Throws on injection-block or
// budget-block to terminate the task before the lease is acquired.
export async function preDispatch(params: {
  db: Database.Database;
  task: Task;
  workflowId: string;
  workspace: string;
  objective: string;
  autoApprove: boolean;
  doHitl: (info: import('../../../hitl/cli.js').HitlPromptInfo) => Promise<'approve' | 'reject'>;
  allTasks?: Task[];
  forceHitlPrompt: boolean;
  taskCancelSignal: AbortSignal;
}): Promise<void> {
  const {
    db,
    task,
    workflowId: wfId,
    workspace,
    objective,
    autoApprove,
    doHitl,
    allTasks,
    forceHitlPrompt,
    taskCancelSignal,
  } = params;

  // HITL gate: pause and prompt for approval before executing if flagged.
  if (task.hitl) {
    await runHitlGate(db, task, wfId, workspace, objective, autoApprove, doHitl, allTasks, forceHitlPrompt);
  }
  checkAborted(taskCancelSignal, 'after_hitl_gate');

  // Inject outputs from upstream tasks so the executor sees them in the prompt.
  // Bloco 1.4: apply input_selectors if declared in task.input_json.
  const upstreamCtx = safeParseJson<Record<string, unknown>>(task.input_json, {
    db,
    workflowId: wfId,
    taskId: task.id,
    where: 'collect_upstream_input_json',
  }) ?? {};
  const upstreamSelectors = upstreamCtx['input_selectors'] as Record<string, SelectorValue> | undefined;
  const summarizedUpstreams = upstreamCtx['summarized_upstreams'] as Record<string, string> | undefined;
  const upstreamResult = await collectUpstreamArtifacts(db, task.depends_on, upstreamSelectors, summarizedUpstreams);
  if (upstreamResult) {
    const compactedUpstream = await maybeCompact(
      upstreamResult.content,
      [],
      // B6.3 perf-win: threshold lowered from 100K → configurable (default 50K)
      // so compaction fires proactively, before the worker prompt explodes.
      { ...DEFAULT_COMPACTION_SETTINGS, autoCompactThreshold: getAutoCompactThreshold() },
      task.model ?? DEFAULT_COMPACTION_SETTINGS.summarizationModel ?? 'unknown',
      `${wfId}_${task.id}_upstream_artifacts`,
      wfId,
    );
    emitContextCompactionEvent(
      db,
      wfId,
      task.id,
      'executor_upstream_artifacts',
      compactedUpstream,
    );
    task.input_json = JSON.stringify({
      ...upstreamCtx,
      upstream_artifacts: compactedUpstream.contextText,
    });
    for (const ev of upstreamResult.slicedEvents) {
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_input_sliced',
        payload: ev,
      });
    }
  }

  // Bounded carry — surface parsed_handoff sections from each direct parent
  // task into the next task's prompt as a compact carry block. Disable knob:
  // OMNIFORGE_DISABLE_CARRY_INJECTION=true falls back to legacy
  // upstream_artifacts only. See src/v2/handoff/wire.ts for shape.
  if (getCarryFromUpstreamEnabled() && task.depends_on.length > 0 && allTasks) {
    const parents = task.depends_on
      .map((depId) => allTasks.find((t) => t.id === depId))
      .filter((t): t is Task => t !== undefined && t.status === 'completed')
      .map((t) => ({ id: t.id, name: t.name, output_json: t.output_json }));

    if (parents.length > 0) {
      const carry = buildCarryFromUpstream(parents, getCarryFromUpstreamMaxChars());
      if (carry.text.length > 0) {
        const carryCtx = safeParseJson<Record<string, unknown>>(task.input_json, {
          db,
          workflowId: wfId,
          taskId: task.id,
          where: 'carry_from_upstream_inject',
        }) ?? {};
        task.input_json = JSON.stringify({
          ...carryCtx,
          carry_from_upstream: carry.text,
        });
        insertEvent(db, {
          workflow_id: wfId,
          task_id: task.id,
          type: 'task_carry_injected',
          payload: {
            total_chars: carry.totalChars,
            sources: carry.sources.map((s) => ({
              parent_task_id: s.parentTaskId,
              parent_name: s.parentName,
              chars: s.chars,
              truncated: s.truncated,
              truncated_sections: s.truncatedSections,
            })),
          },
        });
      }
    }
  }

  if (task.kind === 'tool_call') {
    await dispatchToolCallPrep({
      db,
      task,
      workflowId: wfId,
      workspace,
      objective,
      autoApprove,
      doHitl,
      allTasks,
      forceHitlPrompt,
    });
  }
  // Budget guards run before any model-spending dispatch. The aggregate (global)
  // ceiling must cover ALL model-spending kinds — cli_spawn cost lands in
  // model_calls via the omniroute cost-sync bridge, so an unattended cli_spawn
  // loop has to be gated too, not just llm_call (otherwise the ceiling is only a
  // soft backstop checked at the next llm_call). On a breach we mark the task
  // failed (mirroring the injection-block path below) so it isn't left dangling
  // in 'pending'. No-op unless the relevant budget env vars are set.
  if (task.kind === 'llm_call' || task.kind === 'cli_spawn' || task.kind === 'pal_call') {
    try {
      // Wave-1.5: fold the upcoming call's estimated cost into the budget guards
      // so a single expensive call can't overshoot the cap before enforcement
      // fires (forward-looking pre-reservation; estimate is 0 when none is set).
      const pendingCostUsd = estimateUpcomingCost(task, db, wfId);
      // Aurora-parity Wave 0: daily + all-time ceiling across all workflows.
      assertGlobalBudgetAllowsModelCall(db, wfId, task.id, Date.now(), pendingCostUsd);
      if (task.kind === 'llm_call') {
        assertWorkflowBudgetAllowsModelCall(db, wfId, task.id, pendingCostUsd);
      }
    } catch (err) {
      setTaskFailed(db, task.id);
      throw err;
    }
  }

  // Bloco 3.3+ — prompt injection scan. Default mode BLOCKS the task; opt-out via
  // INJECTION_SCAN_ENFORCE=false restores observability-only behaviour for debug.
  const injectionResult = scanForInjection(task.input_json ?? '');
  if (!injectionResult.safe) {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: task.id,
      type: 'task_injection_detected',
      payload: { score: injectionResult.score, flags: injectionResult.flags },
    });
    const enforce = process.env.INJECTION_SCAN_ENFORCE !== 'false';
    if (enforce) {
      setTaskFailed(db, task.id);
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'task_injection_blocked',
        payload: {
          score: injectionResult.score,
          threshold: 0.5,
          flags: injectionResult.flags.map((f) => f.pattern),
        },
      });
      throw new Error(
        `Task '${task.name}' blocked by injection scanner ` +
        `(score=${injectionResult.score.toFixed(2)} >= 0.5; flags: ${injectionResult.flags.map((f) => f.pattern).join(', ')})`,
      );
    }
    process.stderr.write(
      `[injection-scan] task '${task.name}' flagged (score=${injectionResult.score.toFixed(2)}) — INJECTION_SCAN_ENFORCE=false, executing anyway\n`,
    );
  }

  enforceWorkflowCostCapBeforeTask(db, task, wfId, allTasks);
}
