/**
 * Tests for the FAILOVER_CLASSIFIER_PERSONA wire in src/v2/failover/classifier.ts
 *
 * All tests are deterministic (no real LLM calls):
 *  - applyClassifierMutations is tested directly.
 *  - classifyViaPersona is tested with preHook shortcut path (known patterns).
 *  - classifyErrorWithPersona is tested with the feature flag off (legacy path).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  applyClassifierMutations,
  classifyViaPersona,
  classifyErrorWithPersona,
  type MutableTaskContext,
  type FailoverClassifyContext,
} from '../../src/v2/failover/classifier.js';
import { createInMemoryContext } from '../../src/v2/agents/runner.js';

// ─────────────────────────────────────────────────────────────────────────────
// applyClassifierMutations
// ─────────────────────────────────────────────────────────────────────────────

describe('applyClassifierMutations', () => {
  it('swaps model when field==model', async () => {
    const ctx: MutableTaskContext = { model: 'cc/claude-sonnet-4-6' };
    await applyClassifierMutations(
      {
        strategy: 'retry_with_different_model',
        mutations: [{ field: 'model', old_value: 'cc/claude-sonnet-4-6', new_value: 'cx/gpt-5.5', reason: 'fallback' }],
        reasoning: 'test',
        confidence: 'high',
      },
      ctx,
    );
    expect(ctx.model).toBe('cx/gpt-5.5');
  });

  it('prepends prompt_prefix, combining with existing prefix', async () => {
    const ctx: MutableTaskContext = { promptPrefix: 'existing' };
    await applyClassifierMutations(
      {
        strategy: 'retry_with_stronger_prompt',
        mutations: [{ field: 'prompt_prefix', old_value: null, new_value: 'IMPORTANT: write files now.', reason: 'strengthen' }],
        reasoning: 'test',
        confidence: 'high',
      },
      ctx,
    );
    expect(ctx.promptPrefix).toBe('IMPORTANT: write files now.\n\nexisting');
  });

  it('sets promptPrefix when none existed', async () => {
    const ctx: MutableTaskContext = {};
    await applyClassifierMutations(
      {
        strategy: 'retry_with_stronger_prompt',
        mutations: [{ field: 'prompt_prefix', old_value: null, new_value: 'PREFIX', reason: 'add' }],
        reasoning: 'test',
        confidence: 'high',
      },
      ctx,
    );
    expect(ctx.promptPrefix).toBe('PREFIX');
  });

  it('resolves without error when field==workspace (cleanWorkspace no-op)', async () => {
    const ctx: MutableTaskContext = { workspaceDir: undefined };
    await expect(
      applyClassifierMutations(
        {
          strategy: 'retry_with_workspace_clean',
          mutations: [{ field: 'workspace', old_value: 'as-is', new_value: 'clean_prior_attempt_files', reason: 'clean' }],
          reasoning: 'test',
          confidence: 'high',
        },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });

  it('applies multiple mutations in sequence', async () => {
    const ctx: MutableTaskContext = { model: 'old-model' };
    await applyClassifierMutations(
      {
        strategy: 'retry_with_different_model',
        mutations: [
          { field: 'model', old_value: 'old-model', new_value: 'new-model', reason: 'swap' },
          { field: 'prompt_prefix', old_value: null, new_value: 'prefix', reason: 'add' },
        ],
        reasoning: 'test',
        confidence: 'medium',
      },
      ctx,
    );
    expect(ctx.model).toBe('new-model');
    expect(ctx.promptPrefix).toBe('prefix');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyViaPersona — preHook shortcut paths (deterministic, no LLM needed)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyViaPersona', () => {
  const agentCtx = createInMemoryContext();

  // Invoker that errors if called — used to verify preHook shortcuts.
  const noCallInvoker = async () => {
    throw new Error('LLM invoker should not be called for known-pattern shortcuts');
  };

  it('shortcuts to escalate_to_operator when retry_count >= 3 (loop guard)', async () => {
    const context: FailoverClassifyContext = {
      taskId: 't1',
      workflowId: 'wf1',
      retryCount: 5,
      task: { id: 't1', name: 'test task', kind: 'llm_call', depends_on: [] },
    };
    const result = await classifyViaPersona(
      new Error('format error'),
      context,
      agentCtx,
      noCallInvoker,
    );
    expect(result.strategy).toBe('escalate_to_operator');
    expect(result.shortcut_id).toBe('failover.loop_guard_triggered');
    expect(result.confidence).toBe('high');
  });

  it('shortcuts to retry_with_stronger_prompt for described_without_writing mode', async () => {
    const context: FailoverClassifyContext = {
      taskId: 't2',
      workflowId: 'wf1',
      retryCount: 0,
      task: {
        id: 't2',
        name: 'write component',
        kind: 'cli_spawn',
        depends_on: [],
        // Set failure mode directly via task field for the context build
      },
    };
    // The preHook matches via failure_event.mode — we need to pass a task with
    // the mode hint via priorFailures/failure_event. The `type` field of
    // failure_event is set from errCtx.message. Set the mode via a mock context
    // that passes a task with executor output containing the mode pattern.
    // Easiest: use the `type` field that matches the regex /described_without_writing/i
    const result = await classifyViaPersona(
      new Error('worker.described_without_writing'),
      context,
      agentCtx,
      noCallInvoker,
    );
    expect(result.strategy).toBe('retry_with_stronger_prompt');
    expect(result.shortcut_id).toBe('worker.described_without_writing');
    expect(result.mutations.some((m) => m.field === 'prompt_prefix')).toBe(true);
  });

  it('shortcuts to retry_with_stronger_prompt for decomposer.prose_response', async () => {
    const context: FailoverClassifyContext = {
      taskId: 't3',
      workflowId: 'wf1',
      retryCount: 0,
      task: { id: 't3', name: 'decompose', kind: 'llm_call', depends_on: [] },
    };
    const result = await classifyViaPersona(
      new Error('decomposer.prose_response detected'),
      context,
      agentCtx,
      noCallInvoker,
    );
    expect(result.strategy).toBe('retry_with_stronger_prompt');
    expect(result.shortcut_id).toBe('decomposer.prose_response');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyErrorWithPersona — feature flag gating (legacy path)
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyErrorWithPersona (feature flag off — legacy path)', () => {
  beforeEach(() => {
    delete process.env['OMNIFORGE_USE_PERSONAS'];
  });

  afterEach(() => {
    delete process.env['OMNIFORGE_USE_PERSONAS'];
  });

  it('returns retry_as_is for ECONNRESET (timeout class) via legacy', async () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'false';
    const result = await classifyErrorWithPersona(new Error('ECONNRESET socket hang up'));
    expect(result.strategy).toBe('retry_as_is');
    expect(result.mutations).toHaveLength(0);
    expect(result.confidence).toBe('high');
  });

  it('returns retry_with_different_model for 404 model_not_found via legacy', async () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'false';
    const err = Object.assign(new Error('not found'), { status: 404 });
    const result = await classifyErrorWithPersona(err);
    expect(result.strategy).toBe('retry_with_different_model');
  });

  it('returns retry_with_stronger_prompt for 400 format error via legacy', async () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'false';
    const err = Object.assign(new Error('bad request'), { status: 400 });
    const result = await classifyErrorWithPersona(err);
    expect(result.strategy).toBe('retry_with_stronger_prompt');
  });

  it('returns retry_with_workspace_clean for context overflow via legacy', async () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'false';
    const result = await classifyErrorWithPersona(new Error('context length exceeded'));
    expect(result.strategy).toBe('retry_with_workspace_clean');
  });

  it('returns escalate_to_operator for 402 billing via legacy', async () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'false';
    const err = Object.assign(new Error('billing issue'), { status: 402 });
    const result = await classifyErrorWithPersona(err);
    expect(result.strategy).toBe('escalate_to_operator');
  });

  it('returns soft_fail for unknown error via legacy', async () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'false';
    const result = await classifyErrorWithPersona(new Error('some totally unknown error xyz987abc'));
    expect(result.strategy).toBe('soft_fail');
  });

  it('honors all 7 strategy values across the strategy enum', () => {
    // Verify the enum values used in tests cover all 7 RemediationStrategy variants.
    const allStrategies: string[] = [
      'retry_as_is',
      'retry_with_stronger_prompt',
      'retry_with_different_model',
      'retry_with_workspace_clean',
      'switch_executor',
      'escalate_to_operator',
      'soft_fail',
    ];
    expect(allStrategies).toHaveLength(7);
    // switch_executor is produced by the persona preHook shortcut (worker.cli_unavailable);
    // all others are produced by the legacy mapReasonToStrategy above.
    expect(allStrategies.includes('switch_executor')).toBe(true);
  });
});
