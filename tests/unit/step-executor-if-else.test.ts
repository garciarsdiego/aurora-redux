import { describe, it, expect, vi } from 'vitest';
import { executeIfElse } from '../../src/brain/executor/step-executors/if_else.js';
import type { Task } from '../../src/types/index.js';

function makeTask(overrides: Partial<Task> & {
  if_condition?: string;
  if_true_step_id?: string;
  if_false_step_id?: string;
}): Task & { if_condition?: string; if_true_step_id?: string; if_false_step_id?: string } {
  return {
    id: 'task-1',
    workflow_id: 'wf-1',
    name: 'test-if',
    kind: 'if_else',
    input_json: null,
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
    ...overrides,
  };
}

const ctx = { workflowId: 'wf-1' };

describe('executeIfElse', () => {
  it('takes true branch when condition is truthy', async () => {
    const task = makeTask({
      if_condition: 'state.score >= 50',
      if_true_step_id: 'step-pass',
      if_false_step_id: 'step-fail',
    });
    const result = await executeIfElse(task, { score: 80 }, ctx);
    expect(result.decision).toBe('true');
    expect(result.next_step_id).toBe('step-pass');
  });

  it('takes false branch when condition is falsy', async () => {
    const task = makeTask({
      if_condition: 'state.score >= 50',
      if_true_step_id: 'step-pass',
      if_false_step_id: 'step-fail',
    });
    const result = await executeIfElse(task, { score: 20 }, ctx);
    expect(result.decision).toBe('false');
    expect(result.next_step_id).toBe('step-fail');
  });

  it('coerces missing key to false (null -> false)', async () => {
    const task = makeTask({
      if_condition: 'state.nonexistent',
      if_true_step_id: 'step-pass',
      if_false_step_id: 'step-fail',
    });
    const result = await executeIfElse(task, {}, ctx);
    expect(result.decision).toBe('false');
    expect(result.next_step_id).toBe('step-fail');
  });

  it('resolves dot-notation paths (state.user.active)', async () => {
    const task = makeTask({
      if_condition: 'state.user.active',
      if_true_step_id: 'step-active',
      if_false_step_id: 'step-inactive',
    });
    const result = await executeIfElse(task, { user: { active: true } }, ctx);
    expect(result.decision).toBe('true');
    expect(result.next_step_id).toBe('step-active');
  });

  it('emits if_decision event with correct fields', async () => {
    const emitEvent = vi.fn();
    const task = makeTask({
      id: 'task-42',
      if_condition: 'true',
      if_true_step_id: 'step-yes',
    });
    await executeIfElse(task, {}, { workflowId: 'wf-1', emitEvent });
    expect(emitEvent).toHaveBeenCalledWith({
      type: 'if_decision',
      task_id: 'task-42',
      decision: 'true',
      target_step_id: 'step-yes',
    });
  });

  it('treats eval errors as false (safe degradation)', async () => {
    const task = makeTask({
      if_condition: 'throw new Error("boom")',
      if_true_step_id: 'step-pass',
      if_false_step_id: 'step-fail',
    });
    const result = await executeIfElse(task, {}, ctx);
    expect(result.decision).toBe('false');
  });

  it('emits if_condition_eval_error before defaulting to false on a hard eval error (BRAIN-05)', async () => {
    const emitEvent = vi.fn();
    const task = makeTask({
      id: 'task-err',
      if_condition: 'throw new Error("boom")',
      if_true_step_id: 'step-pass',
      if_false_step_id: 'step-fail',
    });
    const result = await executeIfElse(task, {}, { workflowId: 'wf-1', emitEvent });
    expect(result.decision).toBe('false');
    expect(result.next_step_id).toBe('step-fail');
    // The eval-error observability event fires BEFORE the if_decision event.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'if_condition_eval_error',
        task_id: 'task-err',
        defaulted_decision: 'false',
      }),
    );
    const types = emitEvent.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types.indexOf('if_condition_eval_error')).toBeLessThan(types.indexOf('if_decision'));
  });

  it('emits vm_eval_soft_fail when the condition references an undefined symbol (DET-06)', async () => {
    const emitEvent = vi.fn();
    // `definitelyMissing` is not a state key, not a sandbox builtin → the VM
    // throws ReferenceError which is swallowed to null inside safe-vm-eval and
    // surfaced as a soft-fail event.
    const task = makeTask({
      id: 'task-soft',
      if_condition: 'definitelyMissing > 1',
      if_true_step_id: 'step-pass',
      if_false_step_id: 'step-fail',
    });
    const result = await executeIfElse(task, {}, { workflowId: 'wf-1', emitEvent });
    expect(result.decision).toBe('false');
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'vm_eval_soft_fail',
        task_id: 'task-soft',
        error_name: 'ReferenceError',
      }),
    );
  });

  it('does not throw when emitEvent is absent on an eval error', async () => {
    const task = makeTask({
      if_condition: 'throw new Error("boom")',
      if_false_step_id: 'step-fail',
    });
    // ctx has no emitEvent — the fail-safe guards must keep this from throwing.
    await expect(executeIfElse(task, {}, { workflowId: 'wf-1' })).resolves.toMatchObject({
      decision: 'false',
    });
  });
});
