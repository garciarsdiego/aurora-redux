import { describe, expect, it } from 'vitest';
import { executeMerge } from '../../src/brain/executor/step-executors/merge.js';
import type { DagTask } from '../../src/types/index.js';

function baseMergeTask(overrides: Partial<DagTask> = {}): DagTask {
  return {
    id: 'merge-1',
    name: 'merge',
    kind: 'merge',
    depends_on: [],
    merge_strategy: 'list',
    merge_branch_outputs: ['a', 'b'],
    output_key: 'merged',
    ...overrides,
  };
}

describe('executeMerge', () => {
  it('list strategy concatenates array branch values and appends scalars', () => {
    const state: Record<string, unknown> = {
      a: [1, 2],
      b: 3,
      c: ['x'],
    };

    executeMerge(baseMergeTask({ merge_branch_outputs: ['a', 'b', 'c'] }), state);

    expect(state['merged']).toEqual([1, 2, 3, 'x']);
  });

  it('concat strategy joins branch outputs with blank lines', () => {
    const state: Record<string, unknown> = {
      intro: 'first',
      body: 'second',
      count: 3,
    };

    executeMerge(
      baseMergeTask({
        merge_strategy: 'concat',
        merge_branch_outputs: ['intro', 'body', 'count'],
      }),
      state,
    );

    expect(state['merged']).toBe('first\n\nsecond\n\n3');
  });

  it('dict strategy deep merges plain objects from left to right', () => {
    const state: Record<string, unknown> = {
      a: { user: { name: 'Example', roles: ['admin'] }, enabled: true },
      b: { user: { plan: 'pro' }, enabled: false },
      c: { meta: { source: 'test' } },
    };

    executeMerge(
      baseMergeTask({
        merge_strategy: 'dict',
        merge_branch_outputs: ['a', 'b', 'c'],
      }),
      state,
    );

    expect(state['merged']).toEqual({
      user: { name: 'Example', roles: ['admin'], plan: 'pro' },
      enabled: false,
      meta: { source: 'test' },
    });
  });

  it('requires output_key', () => {
    expect(() => executeMerge(baseMergeTask({ output_key: undefined }), {})).toThrow(/output_key/);
  });
});
