import type { DagTask } from '../../../types/index.js';

export interface LoopCtx {
  executeStep?: (stepId: string, meta: {
    iteration: number;
    total: number;
    loopTaskId: string;
  }) => void | Promise<void>;
  emitEvent?: (payload: Record<string, unknown>) => void | Promise<void>;
}

export interface LoopResult {
  iterations: number;
  step_runs: number;
}

/**
 * Deterministic loop step: runs the declared body step ids `loop_count` times.
 *
 * Iteration metadata is 1-based because it is surfaced into workflow state for
 * templates/prompts, where "iteration 1 of 3" is the natural representation.
 */
export async function executeLoop(
  task: DagTask,
  sharedState: Record<string, unknown>,
  ctx: LoopCtx = {},
): Promise<LoopResult> {
  const rawLoopCount = task.loop_count;
  if (
    typeof rawLoopCount !== 'number' ||
    !Number.isInteger(rawLoopCount) ||
    rawLoopCount < 1 ||
    rawLoopCount > 50
  ) {
    throw new Error('loop: loop_count must be an integer between 1 and 50');
  }
  const loopCount = rawLoopCount;

  const stepIds = task.loop_step_ids ?? [];
  if (stepIds.length === 0) {
    throw new Error('loop: loop_step_ids must contain at least one step id');
  }

  if (!ctx.executeStep) {
    throw new Error('loop: executeStep callback is required to run loop_step_ids');
  }

  sharedState['_loop_total'] = loopCount;
  let stepRuns = 0;

  for (let iteration = 1; iteration <= loopCount; iteration += 1) {
    sharedState['_loop_current_iteration'] = iteration;

    await ctx.emitEvent?.({
      type: 'loop_iteration',
      task_id: task.id,
      iteration,
      total: loopCount,
    });

    for (const stepId of stepIds) {
      await ctx.executeStep(stepId, {
        iteration,
        total: loopCount,
        loopTaskId: task.id,
      });
      stepRuns += 1;
    }
  }

  return { iterations: loopCount, step_runs: stepRuns };
}
