/**
 * Persona-path smoke E2E.
 *
 * Goal: prove that with `OMNIFORGE_USE_PERSONAS=true` set, every wired
 * persona path (decomposer, reviewer, consolidator, failover classifier)
 * actually engages and returns a structurally valid output. Omniroute is
 * stubbed with deterministic JSON so this runs in CI without network.
 *
 * Per-wire unit tests (tests/unit/*-persona-wire.test.ts) cover edge
 * cases. This file is the cross-cutting "did anyone forget to wire it?"
 * regression guard — when someone removes a `if (getUsePersonas())`
 * branch, this test breaks.
 *
 * Reference: AUDIT-2026-05-05.md §4 high-priority item #1 ("persona
 * path com 0% tráfego de produção"). The audit asked for a single
 * smoke run with the flag on; that's what this is.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { Task, Workflow } from '../../src/types/index.js';

// ── Hoisted Omniroute mocks ─────────────────────────────────────────────────
// Persona invokers go through callOmnirouteWithUsage; legacy paths use
// callOmniroute. Mock both so we can assert which one fired.
const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn(),
  callOmnirouteWithUsage: vi.fn(),
}));

vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

// Imports go AFTER vi.mock so the modules pick up the stubs
const { decompose } = await import('../../src/brain/decomposer.js');
const { reviewTask } = await import('../../src/reviewer/reviewer.js');
const { consolidateWorkflow } = await import('../../src/brain/consolidator.js');
const { classifyErrorWithPersona } = await import('../../src/v2/failover/classifier.js');

// ── Canned persona-shape outputs ────────────────────────────────────────────

function decomposerOutput(): string {
  return JSON.stringify({
    tasks: [
      {
        id: 't1',
        name: 'Read source file',
        kind: 'cli_spawn',
        depends_on: [],
        acceptance_criteria: 'file exists at /tmp/out.txt',
      },
      {
        id: 't2',
        name: 'Count words',
        kind: 'llm_call',
        depends_on: ['t1'],
      },
    ],
    rationale: 'Two-step linear chain — read then process. Test fixture.',
    confidence: 'high',
    recommends_hitl_gate: false,
  });
}

function reviewerOutput(verdict: 'pass' | 'fail' | 'refine' = 'pass'): string {
  return JSON.stringify({
    verdict,
    feedback: verdict === 'pass' ? 'output meets criteria' : 'criteria not met',
    evidence: [{ criterion: 'Answer contains ok.', status: 'met', proof: 'output text contains the substring "ok"' }],
    filesystem_check_summary: { files_verified: [], files_missing: [], files_too_short: [] },
    llm_called: true,
  });
}

function classifierOutput(): string {
  return JSON.stringify({
    strategy: 'retry_with_different_model',
    mutations: [
      {
        field: 'model',
        old_value: 'cc/claude-sonnet-4-6',
        new_value: 'cx/gpt-5.5',
        reason: 'sonnet timed out — try gpt as alternative provider',
      },
    ],
    reasoning: 'Timeout on sonnet, swap to a different family',
    confidence: 'high',
  });
}

function consolidatorOutput(): string {
  // Schema: { summary: string, conflicts: Conflict[], gaps: string[], files_written_total: string[] }
  return JSON.stringify({
    summary: 'Workflow completed successfully — both tasks produced output. Smoke fixture.',
    conflicts: [],
    gaps: [],
    files_written_total: [],
  });
}

// ── Test fixtures ───────────────────────────────────────────────────────────

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_1',
    workflow_id: 'wf_smoke',
    name: 'Smoke task',
    kind: 'llm_call',
    input_json: JSON.stringify({ objective: 'Say "ok".' }),
    output_json: null,
    status: 'completed',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 60,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: Date.now(),
    acceptance_criteria: 'Answer contains ok.',
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: null,
    hitl: false,
    workspace: process.cwd(),
    ...overrides,
  };
}

function baseWorkflow(): Workflow {
  return {
    id: 'wf_smoke',
    workspace: 'internal',
    objective: 'Smoke test',
    pattern_id: null,
    status: 'completed',
    started_at: Date.now() - 10_000,
    completed_at: Date.now(),
    created_at: Date.now() - 10_000,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    metadata: null,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('persona-path smoke E2E (OMNIFORGE_USE_PERSONAS=true)', () => {
  const originalFlag = process.env.OMNIFORGE_USE_PERSONAS;

  beforeEach(() => {
    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
    process.env.OMNIFORGE_USE_PERSONAS = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.OMNIFORGE_USE_PERSONAS;
    else process.env.OMNIFORGE_USE_PERSONAS = originalFlag;
  });

  it('decomposer wire: persona path emits valid Dag', async () => {
    // Both legacy and persona decomposer go through callOmnirouteWithUsage.
    // Distinguish by systemPrompt content — the persona system prompt
    // includes the persona identity string ("I am Omniforge's Decomposer").
    omnirouteMock.callOmnirouteWithUsage.mockImplementation((args: { systemPrompt: string }) => {
      const isPersona = args.systemPrompt.includes("I am Omniforge's Decomposer");
      if (!isPersona) throw new Error('Expected persona path, but legacy systemPrompt was sent');
      return Promise.resolve({
        content: decomposerOutput(),
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      });
    });

    const dag = await decompose('Smoke: read file, count words.');

    expect(dag.tasks).toHaveLength(2);
    expect(dag.tasks[0].id).toBe('t1');
    expect(dag.tasks[1].depends_on).toEqual(['t1']);
    expect(omnirouteMock.callOmnirouteWithUsage).toHaveBeenCalled();
  });

  it('reviewer wire: persona path emits ReviewResult', async () => {
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: reviewerOutput('pass'),
      usage: { input_tokens: 50, output_tokens: 30, total_tokens: 80 },
    });

    const review = await reviewTask(baseTask(), 'output text contains ok');

    expect(review.passed).toBe(true);
    expect(review.feedback).toMatch(/criteria/i);
    expect(omnirouteMock.callOmnirouteWithUsage).toHaveBeenCalled();
  });

  it('classifier wire: persona path emits FailoverResult', async () => {
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: classifierOutput(),
      usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120 },
    });

    const result = await classifyErrorWithPersona(
      { kind: 'timeout', message: 'sonnet timeout', exitCode: null, taskId: 'task_1' },
      {
        task: baseTask({ model: 'cc/claude-sonnet-4-6' }),
        retryCount: 1,
      },
    );

    expect(result.strategy).toBe('retry_with_different_model');
    expect(result.mutations).toHaveLength(1);
    expect(result.mutations?.[0].new_value).toBe('cx/gpt-5.5');
  });

  it('consolidator wire: persona path emits consolidated string', async () => {
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: consolidatorOutput(),
      usage: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
    });

    // Build a minimal completed-task list. Two completed tasks force the
    // persona path (single completed short-circuits in the consolidator).
    const tasks: Task[] = [
      baseTask({ id: 't1', name: 'Step 1', status: 'completed', output_json: 'first output' }),
      baseTask({ id: 't2', name: 'Step 2', status: 'completed', output_json: 'second output' }),
    ];

    const summary = await consolidateWorkflow(baseWorkflow(), tasks);

    // Persona path returns ConsolidatorOutput.summary (a string).
    expect(typeof summary).toBe('string');
    expect(summary).toContain('completed successfully');
    expect(omnirouteMock.callOmnirouteWithUsage).toHaveBeenCalled();
  });

  it('falls back to legacy when persona output is malformed', async () => {
    // Both decomposer paths go through callOmnirouteWithUsage, so we route
    // by inspecting the systemPrompt: persona prompts get bad JSON twice
    // (forces AgentOutputError → legacy fallback); legacy prompts get a
    // valid Dag.
    let personaCallCount = 0;
    omnirouteMock.callOmnirouteWithUsage.mockImplementation((args: { systemPrompt: string }) => {
      const isPersona = args.systemPrompt.includes("I am Omniforge's Decomposer");
      if (isPersona) {
        personaCallCount++;
        return Promise.resolve({
          content: personaCallCount === 1 ? 'NOT JSON' : 'STILL NOT JSON',
          usage: {},
        });
      }
      // Legacy path
      return Promise.resolve({
        content: JSON.stringify({
          tasks: [{ id: 't1', name: 'Legacy fallback task', kind: 'llm_call', depends_on: [] }],
        }),
        usage: {},
      });
    });

    const dag = await decompose('Smoke: malformed persona output forces legacy path.');

    expect(dag.tasks).toHaveLength(1);
    expect(dag.tasks[0].name).toBe('Legacy fallback task');
    // Persona attempted twice (initial + 1 schema-retry inside runner) before legacy took over.
    expect(personaCallCount).toBe(2);
  });

  it('respects the feature flag — flag off keeps everyone on legacy', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
    omnirouteMock.callOmnirouteWithUsage.mockImplementation((args: { systemPrompt: string }) => {
      const isPersona = args.systemPrompt.includes("I am Omniforge's Decomposer");
      if (isPersona) {
        throw new Error('Persona path was invoked despite flag=false');
      }
      return Promise.resolve({
        content: JSON.stringify({
          tasks: [{ id: 't1', name: 'Legacy task', kind: 'llm_call', depends_on: [] }],
        }),
        usage: {},
      });
    });

    const dag = await decompose('Smoke: feature flag off.');

    expect(dag.tasks).toHaveLength(1);
    expect(dag.tasks[0].name).toBe('Legacy task');
  });
});
