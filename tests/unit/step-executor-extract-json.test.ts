import { describe, it, expect } from 'vitest';
import { executeExtractJson } from '../../src/brain/executor/step-executors/extract_json.js';
import type { DagTask } from '../../src/types/index.js';

function makeTask(overrides: Partial<DagTask> = {}): DagTask {
  return {
    id: 'test-task',
    name: 'test',
    kind: 'extract_json',
    input_keys: ['raw'],
    output_key: 'parsed',
    ...overrides,
  } as unknown as DagTask;
}

describe('executeExtractJson', () => {
  it('parses plain JSON object', () => {
    const state: Record<string, unknown> = { raw: '{"foo":"bar","n":42}' };
    executeExtractJson(makeTask(), state);
    expect(state['parsed']).toEqual({ foo: 'bar', n: 42 });
  });

  it('parses fenced ```json block', () => {
    const state: Record<string, unknown> = {
      raw: '```json\n{"hello":"world"}\n```',
    };
    executeExtractJson(makeTask(), state);
    expect(state['parsed']).toEqual({ hello: 'world' });
  });

  it('returns array when multiple JSON objects are found', () => {
    const state: Record<string, unknown> = {
      raw: '{"a":1} {"b":2}',
    };
    executeExtractJson(makeTask(), state);
    expect(state['parsed']).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('parses plain JSON array', () => {
    const state: Record<string, unknown> = { raw: '[1,2,3]' };
    executeExtractJson(makeTask(), state);
    expect(state['parsed']).toEqual([1, 2, 3]);
  });

  it('throws when input_keys[0] is missing from state', () => {
    const state: Record<string, unknown> = {};
    expect(() => executeExtractJson(makeTask(), state)).toThrow(/undefined/);
  });

  it('throws when no valid JSON is found', () => {
    const state: Record<string, unknown> = { raw: 'not json at all' };
    expect(() => executeExtractJson(makeTask(), state)).toThrow(/no valid JSON/);
  });

  it('throws when output_key is missing from task', () => {
    const state: Record<string, unknown> = { raw: '{}' };
    const task = makeTask({ output_key: undefined });
    expect(() => executeExtractJson(task, state)).toThrow(/output_key/);
  });
});
