// F-LIVE-18 — print step must auto-parse upstream llm_call outputs when
// the template descends into them (state.tX.key). llm_call writes a raw
// string into sharedState; without on-demand JSON parsing the template
// renders empty placeholders.

import { describe, it, expect } from 'vitest';
import { executePrint } from '../../src/brain/executor/step-executors/print.js';
import type { DagTask } from '../../src/types/index.js';

function printTask(template: string, outKey = 'rendered'): DagTask {
  return {
    id: 't2',
    name: 'Render',
    kind: 'print',
    depends_on: ['t1'],
    print_template: template,
    output_key: outKey,
  } as unknown as DagTask;
}

describe('print + F-LIVE-18 JSON descent', () => {
  it('parses a raw JSON-string upstream output on descent', () => {
    const state: Record<string, unknown> = {
      t1: '{"state_count": 50, "year": 1850}',
    };
    executePrint(printTask('US has {state.t1.state_count} states; CA joined in {state.t1.year}.'), state);
    expect(state.rendered).toBe('US has 50 states; CA joined in 1850.');
  });

  it('parses fenced JSON (```json ... ```) on descent', () => {
    const state: Record<string, unknown> = {
      t1: '```json\n{"state_count": 50, "year": 1850}\n```',
    };
    executePrint(printTask('Year {state.t1.year}.'), state);
    expect(state.rendered).toBe('Year 1850.');
  });

  it('still renders plain-string state.tX without descent', () => {
    const state: Record<string, unknown> = { t1: 'hello world' };
    executePrint(printTask('Upstream said: {state.t1}.'), state);
    expect(state.rendered).toBe('Upstream said: hello world.');
  });

  it('renders empty when descent fails on non-JSON string', () => {
    const state: Record<string, unknown> = { t1: 'not json at all' };
    executePrint(printTask('Value: {state.t1.field}.'), state);
    expect(state.rendered).toBe('Value: .');
  });

  it('works with already-parsed object upstream', () => {
    const state: Record<string, unknown> = { t1: { count: 42 } };
    executePrint(printTask('Count: {state.t1.count}.'), state);
    expect(state.rendered).toBe('Count: 42.');
  });

  it('accepts print_template under args (decomposer canonical shape)', () => {
    const state: Record<string, unknown> = { t1: '{"x":1}' };
    const task = {
      id: 't2',
      name: 'Render',
      kind: 'print',
      depends_on: ['t1'],
      args: { print_template: 'X is {state.t1.x}.', output_key: 'r' },
    } as unknown as DagTask;
    executePrint(task, state);
    expect(state.r).toBe('X is 1.');
  });
});
