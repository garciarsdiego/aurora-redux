import { describe, it, expect } from 'vitest';
import { executePrint } from '../../src/brain/executor/step-executors/print.js';
import type { DagTask } from '../../src/types/index.js';

function makeTask(overrides: Partial<DagTask> = {}): DagTask {
  return {
    id: 'print-task',
    name: 'test',
    kind: 'print',
    output_key: 'result',
    print_template: '',
    ...overrides,
  } as unknown as DagTask;
}

describe('executePrint', () => {
  it('replaces a simple {state.key} placeholder', () => {
    const state: Record<string, unknown> = { name: 'Example' };
    executePrint(makeTask({ print_template: 'Hello, {state.name}!' }), state);
    expect(state['result']).toBe('Hello, Example!');
  });

  it('replaces nested {state.key.nested} placeholder', () => {
    const state: Record<string, unknown> = { user: { city: 'Lisbon' } };
    executePrint(makeTask({ print_template: 'City: {state.user.city}' }), state);
    expect(state['result']).toBe('City: Lisbon');
  });

  it('leaves unknown placeholders as empty string', () => {
    const state: Record<string, unknown> = {};
    executePrint(makeTask({ print_template: 'Value: {state.missing}' }), state);
    expect(state['result']).toBe('Value: ');
  });

  it('handles template with multiple placeholders', () => {
    const state: Record<string, unknown> = { first: 'Ada', last: 'Lovelace' };
    executePrint(
      makeTask({ print_template: '{state.first} {state.last} is awesome' }),
      state,
    );
    expect(state['result']).toBe('Ada Lovelace is awesome');
  });

  it('serializes non-string values as JSON', () => {
    const state: Record<string, unknown> = { count: 7 };
    executePrint(makeTask({ print_template: 'Count: {state.count}' }), state);
    expect(state['result']).toBe('Count: 7');
  });

  it('throws when print_template is missing', () => {
    const state: Record<string, unknown> = {};
    const task = makeTask({ print_template: undefined });
    expect(() => executePrint(task, state)).toThrow(/print_template/);
  });

  it('throws when output_key is missing', () => {
    const state: Record<string, unknown> = {};
    const task = makeTask({ output_key: undefined, print_template: 'hi' });
    expect(() => executePrint(task, state)).toThrow(/output_key/);
  });
});
