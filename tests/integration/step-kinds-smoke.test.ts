/**
 * Step-kinds smoke E2E.
 *
 * Drives all 8 deterministic step kinds (transform, extract_json, print,
 * if_else, switch, loop, merge, evaluator) in a single composed pipeline,
 * passing a shared state object between them. Verifies each kind produces
 * the expected mutation/decision, and that they compose end-to-end without
 * dispatcher gaps.
 *
 * Why a smoke instead of relying on the per-kind unit tests: each unit test
 * proves the kind works in isolation, but they don't catch dispatcher
 * regressions (e.g. `executeTask` forgetting to wire a kind, sharedState
 * keys colliding across kinds, or loop's executeStep callback being
 * mis-wired). This file is the cross-cutting "did anyone forget to dispatch
 * one of them?" guard. AUDIT-2026-05-05.md §13 P0 #4.
 *
 * The evaluator step calls Omniroute under the hood (LLM routing) — we
 * stub it with a deterministic decision so the smoke runs in CI offline.
 */

import { describe, it, expect, vi } from 'vitest';

// Stub Omniroute BEFORE importing the executor that pulls it transitively.
const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn().mockResolvedValue('proceed'),
  callOmnirouteWithUsage: vi.fn().mockResolvedValue({
    content: 'proceed',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }),
}));
vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

const { executeTask } = await import('../../src/brain/executor/internal-utils.js');

import type { Task, DagTask } from '../../src/types/index.js';

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tk-smoke',
    workflow_id: 'wf-smoke',
    name: 'smoke',
    kind: 'transform',
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

describe('step-kinds smoke E2E (8 deterministic kinds composed)', () => {
  it('runs the full pipeline: transform → extract_json → print → if_else → switch → loop → merge → evaluator', async () => {
    const sharedState: Record<string, unknown> = {
      score: 75,
      // Note: the current parseJsonFromString regex does not handle nested
      // arrays inside objects (greedy mismatch on `]` closing the inner
      // array before the outer `}`). Stick with a flat object here so this
      // smoke is robust to that known regex limitation.
      raw_payload: '{"label":"alpha","tier":"high"}',
      branch_a_output: 'A',
      branch_b_output: 'B',
      branch_c_output: 'C',
    };
    const ctx = { workflowId: 'wf-smoke' };

    // ── 1. transform: state.doubled = state.score * 2 ─────────────────────
    const transformTask = baseTask({
      id: 'tk-transform',
      kind: 'transform',
      // DagTask carries kind-specific fields directly.
    }) as Task & Partial<DagTask>;
    transformTask.transform_code = 'state.score * 2';
    transformTask.output_key = 'doubled';
    await executeTask(transformTask, { sharedState, workflowId: ctx.workflowId });
    expect(sharedState['doubled']).toBe(150);

    // ── 2. extract_json: parse state.raw_payload into state.parsed ────────
    const extractTask = baseTask({ id: 'tk-extract', kind: 'extract_json' }) as Task & Partial<DagTask>;
    extractTask.input_keys = ['raw_payload'];
    extractTask.output_key = 'parsed';
    await executeTask(extractTask, { sharedState, workflowId: ctx.workflowId });
    expect(sharedState['parsed']).toEqual({ label: 'alpha', tier: 'high' });

    // ── 3. print: render template into state.message ──────────────────────
    const printTask = baseTask({ id: 'tk-print', kind: 'print' }) as Task & Partial<DagTask>;
    printTask.print_template = 'Score is {state.score}, doubled is {state.doubled}, label is {state.parsed.label}';
    printTask.output_key = 'message';
    await executeTask(printTask, { sharedState, workflowId: ctx.workflowId });
    expect(sharedState['message']).toBe('Score is 75, doubled is 150, label is alpha');

    // ── 4. if_else: state.score >= 50 → high branch ──────────────────────
    const ifElseTask = baseTask({ id: 'tk-if', kind: 'if_else' }) as Task & Partial<DagTask>;
    ifElseTask.if_condition = 'state.score >= 50';
    ifElseTask.if_true_step_id = 'tk-high';
    ifElseTask.if_false_step_id = 'tk-low';
    const ifResult = JSON.parse(
      await executeTask(ifElseTask, { sharedState, workflowId: ctx.workflowId }),
    ) as { decision: string; next_step_id: string };
    expect(ifResult.decision).toBe('true');
    expect(ifResult.next_step_id).toBe('tk-high');

    // ── 5. switch: state.parsed.label maps to a case branch ──────────────
    const switchTask = baseTask({ id: 'tk-switch', kind: 'switch' }) as Task & Partial<DagTask>;
    switchTask.switch_expression = 'state.parsed.label';
    switchTask.switch_cases = { alpha: 'tk-alpha-branch', beta: 'tk-beta-branch' };
    switchTask.switch_default_step_id = 'tk-default';
    const switchResult = JSON.parse(
      await executeTask(switchTask, { sharedState, workflowId: ctx.workflowId }),
    ) as { matched_case: string; next_step_id: string };
    expect(switchResult.matched_case).toBe('alpha');
    expect(switchResult.next_step_id).toBe('tk-alpha-branch');

    // ── 6. loop: 3 iterations; executeStep callback counts each ──────────
    const loopTask = baseTask({ id: 'tk-loop', kind: 'loop' }) as Task & Partial<DagTask>;
    loopTask.loop_count = 3;
    loopTask.loop_step_ids = ['tk-body'];
    let loopBodyInvocations = 0;
    const loopExecuteStep = (stepId: string, meta: { iteration: number; total: number }): void => {
      loopBodyInvocations++;
      expect(stepId).toBe('tk-body');
      expect(meta.total).toBe(3);
      expect(meta.iteration).toBeLessThanOrEqual(3);
    };
    await executeTask(loopTask, {
      sharedState,
      workflowId: ctx.workflowId,
      executeStep: loopExecuteStep,
    });
    // executeStep is called once per body step per iteration → 1 body × 3 iters
    expect(loopBodyInvocations).toBe(3);

    // ── 7. merge: combine three branch outputs into a list ───────────────
    const mergeTask = baseTask({ id: 'tk-merge', kind: 'merge' }) as Task & Partial<DagTask>;
    mergeTask.merge_strategy = 'list';
    mergeTask.merge_branch_outputs = ['branch_a_output', 'branch_b_output', 'branch_c_output'];
    mergeTask.output_key = 'merged';
    await executeTask(mergeTask, { sharedState, workflowId: ctx.workflowId });
    expect(sharedState['merged']).toEqual(['A', 'B', 'C']);

    // ── 8. evaluator: LLM stub returns "proceed" → routed via map ─────────
    const evalTask = baseTask({ id: 'tk-eval', kind: 'evaluator' }) as Task & Partial<DagTask>;
    evalTask.evaluator_prompt = 'Should we proceed given the merged result? answer "proceed" or "abort".';
    evalTask.evaluator_route_map = { proceed: 'tk-finalize', abort: 'tk-cancel' };
    evalTask.input_keys = ['merged', 'message'];
    const evalResult = JSON.parse(
      await executeTask(evalTask, { sharedState, workflowId: ctx.workflowId }),
    ) as { decision: string; target_step_id: string };
    expect(evalResult.decision).toBe('proceed');
    expect(evalResult.target_step_id).toBe('tk-finalize');

    // Sanity: shared state has all the user-writable keys we explicitly produced.
    const stateKeys = Object.keys(sharedState);
    for (const required of [
      'branch_a_output',
      'branch_b_output',
      'branch_c_output',
      'doubled',
      'merged',
      'message',
      'parsed',
      'raw_payload',
      'score',
    ]) {
      expect(stateKeys).toContain(required);
    }
    // Loop + evaluator add internal book-keeping keys (prefixed with `_`).
    expect(stateKeys.some((k) => k.startsWith('_loop_'))).toBe(true);
    expect(stateKeys.some((k) => k.startsWith('_evaluator_'))).toBe(true);
  });

  it('switch falls through to default when no case matches', async () => {
    const sharedState = { tier: 'unknown' };
    const switchTask = baseTask({ id: 'tk-switch', kind: 'switch' }) as Task & Partial<DagTask>;
    switchTask.switch_expression = 'state.tier';
    switchTask.switch_cases = { gold: 's1', silver: 's2' };
    switchTask.switch_default_step_id = 's-default';
    const result = JSON.parse(
      await executeTask(switchTask, { sharedState, workflowId: 'wf-1' }),
    ) as { matched_case: string | null; next_step_id: string | null };
    expect(result.matched_case).toBeNull();
    expect(result.next_step_id).toBe('s-default');
  });

  it('if_else is robust against malformed conditions (returns safe decision)', async () => {
    const sharedState = { score: 50 };
    const ifElseTask = baseTask({ id: 'tk-if', kind: 'if_else' }) as Task & Partial<DagTask>;
    ifElseTask.if_condition = 'state.nonexistent.deep.path';
    ifElseTask.if_true_step_id = 'tk-true';
    ifElseTask.if_false_step_id = 'tk-false';
    const result = JSON.parse(
      await executeTask(ifElseTask, { sharedState, workflowId: 'wf-1' }),
    ) as { decision: string; next_step_id: string };
    // Falsy / undefined paths take the false branch (or 'error' branch, depending on impl).
    expect(['false', 'error']).toContain(result.decision);
  });
});
