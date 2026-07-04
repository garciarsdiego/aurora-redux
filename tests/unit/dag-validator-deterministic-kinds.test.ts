// F-LIVE-1 — per-kind required-arg validator regression tests.
//
// The decomposer (especially Haiku) emits `print` / `transform` / `extract_json`
// tasks without the required template / expression / input_keys fields, and
// the runtime executor errors out opaquely. validateDag now catches this at
// plan time so the retry-with-feedback loop can fix it before HITL gates fire.

import { describe, it, expect } from 'vitest';
import { validateDag } from '../../src/brain/dag-validator.js';

function dagWith(tasks: unknown[]): { tasks: unknown[] } {
  return { tasks };
}

describe('validateDag — deterministic-kind args (F-LIVE-1)', () => {
  it('rejects a `print` task with no print_template (top-level or in args)', () => {
    const dag = dagWith([
      { id: 't0', name: 'Plan', kind: 'llm_call', depends_on: [], acceptance_criteria: 'plan exists and exit code equals 0', hitl: true },
      { id: 't1', name: 'Render output', kind: 'print', depends_on: ['t0'], acceptance_criteria: 'prints contain the literal token DONE' },
    ]);
    const result = validateDag(dag as Parameters<typeof validateDag>[0]);
    expect(result.valid).toBe(false);
    const issue = result.errors.find((e) => e.rule === 'deterministic-kind-args');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('print_template');
    expect(issue!.taskIds).toEqual(['t1']);
  });

  it('accepts a `print` task with print_template inside args', () => {
    const dag = dagWith([
      { id: 't0', name: 'Plan', kind: 'llm_call', depends_on: [], acceptance_criteria: 'plan exists and exit code equals 0', hitl: true },
      {
        id: 't1', name: 'Render', kind: 'print', depends_on: ['t0'],
        acceptance_criteria: 'output contains DONE token and exit code equals 0',
        args: { print_template: 'Result: {state.t0}', output_key: 'rendered' },
      },
    ]);
    const result = validateDag(dag as Parameters<typeof validateDag>[0]);
    expect(result.errors.filter((e) => e.rule === 'deterministic-kind-args')).toHaveLength(0);
  });

  it('rejects a `transform` task without transform_expression', () => {
    const dag = dagWith([
      { id: 't0', name: 'Plan', kind: 'llm_call', depends_on: [], acceptance_criteria: 'plan exists with exit code 0', hitl: true },
      { id: 't1', name: 'Transform', kind: 'transform', depends_on: ['t0'], acceptance_criteria: 'output is valid json and exit code equals 0' },
    ]);
    const result = validateDag(dag as Parameters<typeof validateDag>[0]);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.rule === 'deterministic-kind-args' && e.message.includes('transform_expression'))).toBe(true);
  });

  it('accepts top-level field placement (legacy decomposer output)', () => {
    const dag = dagWith([
      { id: 't0', name: 'Plan', kind: 'llm_call', depends_on: [], acceptance_criteria: 'plan exists with exit code 0', hitl: true },
      {
        id: 't1', name: 'Branch', kind: 'if_else', depends_on: ['t0'],
        acceptance_criteria: 'routes when condition is true returns valid json',
        if_condition: 'state.t0.value > 0',
        if_true_step_id: 't2',
        if_false_step_id: 't3',
      },
    ]);
    const result = validateDag(dag as Parameters<typeof validateDag>[0]);
    expect(result.errors.filter((e) => e.rule === 'deterministic-kind-args')).toHaveLength(0);
  });
});
