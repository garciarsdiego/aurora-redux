import { describe, it, expect } from 'vitest';
import {
  AgentEvaluationFramework,
  type AgentEvaluationConfig,
  type AgentEvaluator,
  type AgentType,
  type TestCase,
} from '../../src/v2/evals/agent-evaluation/framework.js';
import { DecomposerEvaluator } from '../../src/v2/evals/agent-evaluation/decomposer-evaluator.js';
import { PlannerEvaluator } from '../../src/v2/evals/agent-evaluation/planner-evaluator.js';
import { ReviewerEvaluator } from '../../src/v2/evals/agent-evaluation/reviewer-evaluator.js';
import { OrchestratorEvaluator } from '../../src/v2/evals/agent-evaluation/orchestrator-evaluator.js';

/**
 * INTEL-02 / STUB-01 regression test.
 *
 * Before the fix, AgentEvaluationFramework.initializeEvaluators() instantiated
 * four in-file STUB evaluator classes that always returned
 * { success: false, error: 'Not implemented' }. The fix imports the REAL
 * sibling evaluators (decomposer/planner/reviewer/orchestrator) and wires them
 * in. These tests assert the framework now uses the real evaluators.
 *
 * We drive the deterministic OrchestratorEvaluator path: it validates and
 * simulates a DAG entirely in-process (no LLM/network calls), so the assertions
 * are stable.
 */

const ORCHESTRATOR_TEST_CASE: TestCase = {
  id: 'orch-real-evaluator-smoke',
  agent: 'orchestrator',
  name: 'Two-task fan-out',
  description: 'A trivial DAG to exercise the real orchestrator evaluator.',
  input: {
    context: {},
    dag: {
      tasks: [
        {
          id: 't0',
          kind: 'llm_call',
          description: 'Plan the work',
          acceptance_criteria: 'A plan exists with at least two downstream tasks.',
          depends_on: [],
          hitl: true,
        },
        {
          id: 't1',
          kind: 'llm_call',
          description: 'Do branch A',
          acceptance_criteria: 'Branch A output contains a result.',
          depends_on: ['t0'],
        },
        {
          id: 't2',
          kind: 'llm_call',
          description: 'Do branch B',
          acceptance_criteria: 'Branch B output contains a result.',
          depends_on: ['t0'],
        },
      ],
    },
  },
  expectedOutput: {},
  complexity: 'simple',
  category: 'orchestration',
  tags: ['smoke'],
};

describe('AgentEvaluationFramework (INTEL-02: real evaluators wired)', () => {
  it('wires the real orchestrator evaluator (never returns "Not implemented")', async () => {
    const framework = new AgentEvaluationFramework();

    const config: AgentEvaluationConfig = {
      agent: 'orchestrator',
      model: 'cc/claude-sonnet-4-6',
      testCases: [ORCHESTRATOR_TEST_CASE],
    };

    const benchmark = await framework.evaluate(config);

    expect(benchmark.results).toHaveLength(1);
    const [result] = benchmark.results;

    // The deleted stub always set error === 'Not implemented'.
    expect(result.error).not.toBe('Not implemented');

    // INTEL-02 invariant: the real evaluator ran. The deleted stub ALWAYS set
    // error === 'Not implemented'; the real one does not. We deliberately do NOT
    // assert the exact output shape here — a synthetic DAG may not fully validate
    // — because the second test proves the real classes are wired (instanceof).
    // This case only guards that the stub signature is gone.
    expect(result).toBeDefined();
  });

  it('registers the real evaluator class for every agent type (no in-file stub)', () => {
    const framework = new AgentEvaluationFramework();

    // The `evaluators` map is private; reach into it for a structural assertion.
    // This is network-free and deterministic — no LLM calls are made.
    const evaluators = (
      framework as unknown as { evaluators: Map<AgentType, AgentEvaluator> }
    ).evaluators;

    expect(evaluators.get('decomposer')).toBeInstanceOf(DecomposerEvaluator);
    expect(evaluators.get('planner')).toBeInstanceOf(PlannerEvaluator);
    expect(evaluators.get('reviewer')).toBeInstanceOf(ReviewerEvaluator);
    expect(evaluators.get('orchestrator')).toBeInstanceOf(OrchestratorEvaluator);
  });
});
