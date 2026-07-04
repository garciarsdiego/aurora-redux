import { describe, expect, it } from 'vitest';
import { executeSwitch } from '../../src/brain/executor/step-executors/switch.js';
import type { DagTask } from '../../src/types/index.js';

function baseSwitchTask(overrides: Partial<DagTask> = {}): DagTask {
  return {
    id: 'switch-1',
    name: 'route',
    kind: 'switch',
    depends_on: [],
    switch_expression: 'state.status',
    switch_cases: { ready: 'next' },
    switch_default_step_id: 'fallback',
    ...overrides,
  };
}

describe('executeSwitch', () => {
  it('routes to the matching case using string comparison', async () => {
    const events: unknown[] = [];

    const result = await executeSwitch(
      baseSwitchTask({
        id: 'route-status',
        switch_expression: 'state.status',
        switch_cases: { approved: 'ship', rejected: 'revise' },
        switch_default_step_id: 'manual',
      }),
      { status: 'approved' },
      { emitEvent: async (event) => { events.push(event); } },
    );

    expect(result).toEqual({ next_step_id: 'ship', matched_case: 'approved' });
    expect(events).toEqual([
      {
        type: 'switch_decision',
        task_id: 'route-status',
        matched_case: 'approved',
        target_step_id: 'ship',
      },
    ]);
  });

  it('falls back to the default step when no case matches', async () => {
    const result = await executeSwitch(
      baseSwitchTask({
        switch_expression: 'state.priority',
        switch_cases: { high: 'escalate' },
        switch_default_step_id: 'normal',
      }),
      { priority: 'low' },
      {},
    );

    expect(result).toEqual({ next_step_id: 'normal', matched_case: null });
  });

  it('treats missing state keys as null and uses the default route', async () => {
    const result = await executeSwitch(
      baseSwitchTask({
        switch_expression: 'state.missing.key',
        switch_cases: { ready: 'next' },
        switch_default_step_id: null,
      }),
      {},
      {},
    );

    expect(result).toEqual({ next_step_id: null, matched_case: null });
  });

  it('coerces numeric expression results before matching case keys', async () => {
    const result = await executeSwitch(
      baseSwitchTask({
        switch_expression: 'state.score',
        switch_cases: { '2': 'two', '3': 'three' },
        switch_default_step_id: 'other',
      }),
      { score: 2 },
      {},
    );

    expect(result).toEqual({ next_step_id: 'two', matched_case: '2' });
  });
});
