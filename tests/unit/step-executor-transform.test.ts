import { describe, it, expect } from 'vitest';
import { executeTransform } from '../../src/brain/executor/step-executors/transform.js';
import type { DagTask } from '../../src/types/index.js';

function baseTransformTask(overrides: Partial<DagTask> = {}): DagTask {
  return {
    id: 't1',
    name: 'transform',
    kind: 'transform',
    depends_on: [],
    output_key: 'out',
    transform_code: 'state.nums',
    ...overrides,
  };
}

describe('executeTransform', () => {
  it('filter: keeps active items', () => {
    const state: Record<string, unknown> = {
      items: [{ id: 1, active: true }, { id: 2, active: false }, { id: 3, active: true }],
    };
    executeTransform(
      baseTransformTask({
        transform_code: 'state.items.filter(i => i.active)',
        output_key: 'filtered',
      }),
      state,
    );
    expect(state['filtered']).toEqual([
      { id: 1, active: true },
      { id: 3, active: true },
    ]);
  });

  it('map: doubles numbers', () => {
    const state: Record<string, unknown> = { nums: [1, 2, 3] };
    executeTransform(
      baseTransformTask({
        transform_code: 'state.nums.map(n => n * 2)',
        output_key: 'doubled',
      }),
      state,
    );
    expect(state['doubled']).toEqual([2, 4, 6]);
  });

  it('reduce: sums numbers', () => {
    const state: Record<string, unknown> = { nums: [10, 20, 5] };
    executeTransform(
      baseTransformTask({
        transform_code: 'state.nums.reduce((a, b) => a + b, 0)',
        output_key: 'sum',
      }),
      state,
    );
    expect(state['sum']).toBe(35);
  });

  it('missing-key: nullish coalescing default', () => {
    const state: Record<string, unknown> = { present: 'ok' };
    executeTransform(
      baseTransformTask({
        transform_code: 'state.missing ?? "default"',
        output_key: 'val',
      }),
      state,
    );
    expect(state['val']).toBe('default');
  });

  it('arrow-form transform_code is supported', () => {
    const state: Record<string, unknown> = { x: 7 };
    executeTransform(
      baseTransformTask({
        transform_code: 'state => state.x + 1',
        output_key: 'y',
      }),
      state,
    );
    expect(state['y']).toBe(8);
  });

  it('rejects code longer than 2000 chars', () => {
    const state: Record<string, unknown> = {};
    expect(() =>
      executeTransform(
        baseTransformTask({
          transform_code: 'x'.repeat(2001),
          output_key: 'o',
        }),
        state,
      ),
    ).toThrow(/exceeds 2000/);
  });
});
