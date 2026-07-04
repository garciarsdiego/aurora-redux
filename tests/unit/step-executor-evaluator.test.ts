import { describe, it, expect, vi } from 'vitest';
import { executeEvaluator } from '../../src/brain/executor/step-executors/evaluator.js';
import type { DagTask } from '../../src/types/index.js';

function makeTask(overrides: Partial<DagTask> = {}): DagTask {
  return {
    id: 'eval-1',
    name: 'Evaluator task',
    kind: 'evaluator',
    depends_on: [],
    acceptance_criteria: 'Routes correctly.',
    evaluator_prompt: 'Decide whether to escalate or resolve.',
    evaluator_route_map: {
      escalate: 'step-escalate',
      resolve: 'step-resolve',
    },
    input_keys: ['ticket'],
    ...overrides,
  } as unknown as DagTask;
}

/** Fake invoker that returns a fixed content string. */
function fakeInvoker(content: string) {
  return vi.fn().mockResolvedValue({ content });
}

describe('executeEvaluator', () => {
  it('parses JSON {"decision":"x"} format and routes correctly', async () => {
    const task = makeTask();
    const sharedState: Record<string, unknown> = { ticket: 'Server down' };
    const invoker = fakeInvoker('{"decision":"escalate","reasoning":"Critical issue"}');
    const events: Record<string, unknown>[] = [];

    const result = await executeEvaluator(task, sharedState, {
      invoker,
      emitEvent: (e) => { events.push(e); },
    });

    expect(result.decision).toBe('escalate');
    expect(result.target_step_id).toBe('step-escalate');
    expect(result.reasoning).toBe('Critical issue');
    expect(sharedState['_evaluator_decision_eval-1']).toBe('escalate');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'evaluator_decision',
      task_id: 'eval-1',
      decision: 'escalate',
      target_step_id: 'step-escalate',
    });
    expect(invoker).toHaveBeenCalledOnce();
  });

  it('parses <DECISION>label</DECISION> XML format', async () => {
    const task = makeTask();
    const sharedState: Record<string, unknown> = { ticket: 'Minor bug' };
    const invoker = fakeInvoker('After analysis: <DECISION>resolve</DECISION>');

    const result = await executeEvaluator(task, sharedState, { invoker });

    expect(result.decision).toBe('resolve');
    expect(result.target_step_id).toBe('step-resolve');
    expect(sharedState['_evaluator_decision_eval-1']).toBe('resolve');
  });

  it('parses plain trimmed label as fallback format', async () => {
    const task = makeTask();
    const sharedState: Record<string, unknown> = {};
    const invoker = fakeInvoker('  escalate  ');

    const result = await executeEvaluator(task, sharedState, { invoker });

    expect(result.decision).toBe('escalate');
    expect(result.target_step_id).toBe('step-escalate');
  });

  it('throws when LLM returns a decision not in route map', async () => {
    const task = makeTask();
    const sharedState: Record<string, unknown> = {};
    const invoker = fakeInvoker('{"decision":"unknown_label"}');

    await expect(
      executeEvaluator(task, sharedState, { invoker }),
    ).rejects.toThrow(/not in evaluator_route_map/);
  });

  it('throws when evaluator_route_map is empty', async () => {
    const task = makeTask({ evaluator_route_map: {} });
    const sharedState: Record<string, unknown> = {};
    const invoker = fakeInvoker('escalate');

    await expect(
      executeEvaluator(task, sharedState, { invoker }),
    ).rejects.toThrow(/evaluator_route_map is empty/);
  });

  it('only passes input_keys slice to invoker, not full sharedState', async () => {
    const task = makeTask({ input_keys: ['ticket'] });
    const sharedState: Record<string, unknown> = {
      ticket: 'Crash report',
      secret_internal: 'do not leak',
    };

    let capturedUserPrompt = '';
    const invoker = vi.fn().mockImplementation(async ({ userPrompt }: { userPrompt: string }) => {
      capturedUserPrompt = userPrompt;
      return { content: '{"decision":"resolve"}' };
    });

    await executeEvaluator(task, sharedState, { invoker });

    expect(capturedUserPrompt).toContain('ticket');
    expect(capturedUserPrompt).not.toContain('secret_internal');
  });

  it('handles nullable target_step_id (terminal route)', async () => {
    const task = makeTask({
      evaluator_route_map: { done: null, retry: 'step-retry' },
    });
    const sharedState: Record<string, unknown> = {};
    const invoker = fakeInvoker('done');

    const result = await executeEvaluator(task, sharedState, { invoker });

    expect(result.decision).toBe('done');
    expect(result.target_step_id).toBeNull();
  });
});
