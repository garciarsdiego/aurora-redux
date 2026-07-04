import { describe, expect, it } from 'vitest';
import { executeLoop } from '../../src/brain/executor/step-executors/loop.js';
import type { DagTask } from '../../src/types/index.js';

function baseLoopTask(overrides: Partial<DagTask> = {}): DagTask {
  return {
    id: 'loop-1',
    name: 'loop',
    kind: 'loop',
    depends_on: [],
    loop_count: 2,
    loop_step_ids: ['a', 'b'],
    ...overrides,
  };
}

describe('executeLoop', () => {
  it('runs loop_step_ids in order for each iteration', async () => {
    const calls: string[] = [];
    const state: Record<string, unknown> = {};

    await executeLoop(baseLoopTask(), state, {
      executeStep: async (stepId) => {
        calls.push(stepId);
      },
    });

    expect(calls).toEqual(['a', 'b', 'a', 'b']);
  });

  it('injects 1-based current iteration and total into sharedState', async () => {
    const snapshots: Array<[unknown, unknown]> = [];
    const state: Record<string, unknown> = {};

    await executeLoop(baseLoopTask({ loop_count: 3, loop_step_ids: ['body'] }), state, {
      executeStep: async () => {
        snapshots.push([state['_loop_current_iteration'], state['_loop_total']]);
      },
    });

    expect(snapshots).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(state['_loop_current_iteration']).toBe(3);
    expect(state['_loop_total']).toBe(3);
  });

  it('rejects loop tasks without a runnable body', async () => {
    await expect(
      executeLoop(baseLoopTask({ loop_step_ids: [] }), {}, { executeStep: async () => {} }),
    ).rejects.toThrow(/loop_step_ids/);
  });

  it('rejects loop body steps when no executor callback is provided', async () => {
    await expect(executeLoop(baseLoopTask(), {})).rejects.toThrow(/executeStep/);
  });
});
