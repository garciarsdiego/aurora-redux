/**
 * Decomposer persona regression tests.
 *
 * Each `it` block targets a specific failure mode listed in the RFC. The fake
 * invoker in this file lets us return arbitrary strings to the runner without
 * spinning up Omniroute — that keeps the suite hermetic and fast.
 */

import { describe, it, expect } from 'vitest';

import {
  DECOMPOSER_PERSONA,
  createInMemoryContext,
  hasCycle,
  pickAlternativeModel,
  renderSystemPrompt,
  runAgent,
  AgentRejectedError,
  AgentOutputError,
  type DecomposerInput,
  type DecomposerOutput,
} from '../../src/v2/agents/index.js';

const MIN_INPUT: DecomposerInput = {
  workspace: 'internal',
  objective: 'Implement Sidebar.tsx and MessageBubble.tsx components',
  available_models: [
    { model_id: 'cc/claude-sonnet-4-6', family: 'claude', provider: 'anthropic' },
    { model_id: 'cx/gpt-5.5', family: 'gpt', provider: 'openai' },
  ],
  available_clis: ['cli:claude-code', 'cli:codex'],
};

function fakeInvoker(responses: string[]): { invoke: (args: unknown) => Promise<string>; calls: number } {
  let i = 0;
  return {
    get calls() { return i; },
    async invoke() {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

const GOOD_DAG_OUTPUT = JSON.stringify({
  tasks: [
    {
      id: 't1',
      name: 'Implement Sidebar.tsx',
      kind: 'cli_spawn',
      executor_hint: 'cli:claude-code',
      model: 'cc/claude-sonnet-4-6',
      depends_on: [],
      acceptance_criteria: 'File src/components/Sidebar.tsx exists with default export Sidebar and >50 lines.',
      timeout_seconds: 600,
    },
    {
      id: 't2',
      name: 'Implement MessageBubble.tsx',
      kind: 'cli_spawn',
      executor_hint: 'cli:claude-code',
      model: 'cc/claude-sonnet-4-6',
      depends_on: [],
      acceptance_criteria: 'File src/components/MessageBubble.tsx exists, exports default function MessageBubble, imports react-markdown.',
      timeout_seconds: 600,
    },
  ],
  rationale: 'Two parallel file-creation tasks; no shared deps.',
  confidence: 'high',
  recommends_hitl_gate: false,
});

describe('DECOMPOSER_PERSONA — happy path', () => {
  it('parses and accepts a well-formed DAG', async () => {
    const ctx = createInMemoryContext();
    const inv = fakeInvoker([GOOD_DAG_OUTPUT]);
    const output = await runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, {
      invoke: inv.invoke,
      parseJson: true,
    });
    expect(output.tasks).toHaveLength(2);
    expect(output.confidence).toBe('high');
    expect(ctx.events.find((e) => e.event === 'agent_completed')).toBeTruthy();
  });
});

describe('DECOMPOSER_PERSONA — failure mode: prose preamble (decomposer.prose_response)', () => {
  it('strips ```json fences and still parses', async () => {
    const ctx = createInMemoryContext();
    const inv = fakeInvoker([
      '```json\n' + GOOD_DAG_OUTPUT + '\n```',
    ]);
    const output = await runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, {
      invoke: inv.invoke,
      parseJson: true,
    });
    expect(output.tasks).toHaveLength(2);
  });

  it('strips leading prose narration and still parses', async () => {
    const ctx = createInMemoryContext();
    const inv = fakeInvoker([
      "I'll decompose this into 2 parallel tasks for maximum parallelism:\n\n" + GOOD_DAG_OUTPUT,
    ]);
    const output = await runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, {
      invoke: inv.invoke,
      parseJson: true,
    });
    expect(output.tasks).toHaveLength(2);
  });

  it('retries once on broken JSON, succeeds on the second attempt', async () => {
    const ctx = createInMemoryContext();
    const inv = fakeInvoker([
      'this is not json at all',
      GOOD_DAG_OUTPUT,
    ]);
    const output = await runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, {
      invoke: inv.invoke,
      parseJson: true,
    });
    expect(output.tasks).toHaveLength(2);
    expect(inv.calls).toBe(2);
  });

  it('throws AgentOutputError when both attempts fail', async () => {
    const ctx = createInMemoryContext();
    const inv = fakeInvoker(['not json', 'still not json']);
    await expect(
      runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toBeInstanceOf(AgentOutputError);
  });
});

describe('DECOMPOSER_PERSONA — failure mode: invalid_model', () => {
  it('rejects when picked model is not in catalog', async () => {
    const ctx = createInMemoryContext();
    const badOutput = JSON.stringify({
      tasks: [
        {
          id: 't1',
          name: 'Implement Sidebar.tsx',
          kind: 'cli_spawn',
          executor_hint: 'cli:claude-code',
          model: 'cc/claude-3.5-sonnet', // NOT in catalog
          depends_on: [],
          acceptance_criteria: 'File src/Sidebar.tsx exists with export default Sidebar.',
          timeout_seconds: 600,
        },
      ],
      rationale: 'one task',
      confidence: 'high',
      recommends_hitl_gate: false,
    });
    const inv = fakeInvoker([badOutput]);
    await expect(
      runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'decomposer.invalid_model',
    });
  });
});

describe('DECOMPOSER_PERSONA — failure mode: combined_task_names', () => {
  it('rejects combined task names', async () => {
    const ctx = createInMemoryContext();
    const badOutput = JSON.stringify({
      tasks: [
        {
          id: 't1',
          name: 'Implement Sidebar then MessageBubble subsequently Header',
          kind: 'cli_spawn',
          executor_hint: 'cli:claude-code',
          model: 'cc/claude-sonnet-4-6',
          depends_on: [],
          acceptance_criteria: 'Files src/Sidebar.tsx and src/MessageBubble.tsx exist.',
          timeout_seconds: 600,
        },
      ],
      rationale: 'one task',
      confidence: 'high',
      recommends_hitl_gate: false,
    });
    const inv = fakeInvoker([badOutput]);
    await expect(
      runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'decomposer.combined_task_names',
    });
  });
});

describe('DECOMPOSER_PERSONA — failure mode: vague_acceptance', () => {
  it('rejects acceptance without concrete keywords', async () => {
    const ctx = createInMemoryContext();
    const badOutput = JSON.stringify({
      tasks: [
        {
          id: 't1',
          name: 'Build Sidebar',
          kind: 'cli_spawn',
          executor_hint: 'cli:claude-code',
          model: 'cc/claude-sonnet-4-6',
          depends_on: [],
          acceptance_criteria: 'It should be implemented well',
          timeout_seconds: 600,
        },
      ],
      rationale: 'one task',
      confidence: 'high',
      recommends_hitl_gate: false,
    });
    const inv = fakeInvoker([badOutput]);
    await expect(
      runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toMatchObject({
      name: 'AgentRejectedError',
      mode: 'decomposer.vague_acceptance',
    });
  });
});

describe('DECOMPOSER_PERSONA — failure mode: cyclic_dag', () => {
  it('rejects DAGs containing cycles', async () => {
    const ctx = createInMemoryContext();
    const cyclicOutput = JSON.stringify({
      tasks: [
        {
          id: 't1',
          name: 'Build A',
          kind: 'cli_spawn',
          executor_hint: 'cli:claude-code',
          model: 'cc/claude-sonnet-4-6',
          depends_on: ['t2'],
          acceptance_criteria: 'File a.ts exists with export default A.',
          timeout_seconds: 600,
        },
        {
          id: 't2',
          name: 'Build B',
          kind: 'cli_spawn',
          executor_hint: 'cli:claude-code',
          model: 'cc/claude-sonnet-4-6',
          depends_on: ['t1'],
          acceptance_criteria: 'File b.ts exists with export default B.',
          timeout_seconds: 600,
        },
      ],
      rationale: 'cyclic',
      confidence: 'high',
      recommends_hitl_gate: false,
    });
    const inv = fakeInvoker([cyclicOutput]);
    await expect(
      runAgent(DECOMPOSER_PERSONA, MIN_INPUT, ctx, { invoke: inv.invoke, parseJson: true }),
    ).rejects.toBeInstanceOf(AgentRejectedError);
  });

  it('hasCycle returns false on linear DAGs', () => {
    const linear = [
      { id: 't1', name: 'A', kind: 'cli_spawn' as const, depends_on: [] },
      { id: 't2', name: 'B', kind: 'cli_spawn' as const, depends_on: ['t1'] },
      { id: 't3', name: 'C', kind: 'cli_spawn' as const, depends_on: ['t2'] },
    ];
    expect(hasCycle(linear)).toBe(false);
  });

  it('hasCycle returns true on self-loop', () => {
    const selfLoop = [
      { id: 't1', name: 'A', kind: 'cli_spawn' as const, depends_on: ['t1'] },
    ];
    expect(hasCycle(selfLoop)).toBe(true);
  });
});

describe('DECOMPOSER_PERSONA — preHook truncates oversized objectives', () => {
  it('caps objective at 20K chars', async () => {
    const huge = 'x'.repeat(25_000);
    const ctx = createInMemoryContext();
    const inv = fakeInvoker([GOOD_DAG_OUTPUT]);
    const output = await runAgent(
      DECOMPOSER_PERSONA,
      { ...MIN_INPUT, objective: huge },
      ctx,
      { invoke: inv.invoke, parseJson: true },
    );
    // M1-W3-D (theater cleanup): GOOD_DAG_OUTPUT defines EXACTLY 2 tasks
    // (t1, t2). Pin the count + the task ids so the fake-invoker contract
    // is anchored — any regression in runAgent that drops tasks or reorders
    // them now surfaces here.
    expect(output.tasks).toHaveLength(2);
    expect(output.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(output.tasks.map((t) => t.name)).toEqual([
      'Implement Sidebar.tsx',
      'Implement MessageBubble.tsx',
    ]);
    expect(ctx.warnings.some((w) => /truncated/i.test(w))).toBe(true);
  });
});

describe('pickAlternativeModel', () => {
  it('returns a different family when current is known', () => {
    const catalog = [
      { model_id: 'cc/claude-sonnet-4-6', family: 'claude' },
      { model_id: 'cx/gpt-5.5', family: 'gpt' },
      { model_id: 'cc/claude-haiku-4-5', family: 'claude' },
    ];
    const alt = pickAlternativeModel('cc/claude-sonnet-4-6', catalog);
    expect(alt).toBe('cx/gpt-5.5');
  });

  it('falls back to any other model if no different-family option exists', () => {
    const catalog = [
      { model_id: 'cc/claude-sonnet-4-6', family: 'claude' },
      { model_id: 'cc/claude-haiku-4-5', family: 'claude' },
    ];
    const alt = pickAlternativeModel('cc/claude-sonnet-4-6', catalog);
    expect(alt).toBe('cc/claude-haiku-4-5');
  });
});

describe('renderSystemPrompt', () => {
  it('interpolates persona identity, mission, hard rules', () => {
    const prompt = renderSystemPrompt(DECOMPOSER_PERSONA, MIN_INPUT);
    expect(prompt).toContain('Omniforge Decomposer');
    expect(prompt).toContain('Convert any operator objective');
    // Universal rules + persona rules
    expect(prompt).toContain('Stay in your lane');
    expect(prompt).toContain('JSON only');
    // Catalog interpolation (json formatter)
    expect(prompt).toContain('cc/claude-sonnet-4-6');
    // CLIs joined
    expect(prompt).toContain('cli:claude-code, cli:codex');
  });
});
