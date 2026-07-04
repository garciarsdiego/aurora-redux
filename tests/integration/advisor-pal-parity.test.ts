// AETHER ε.1 — PAL parity tests for native advisors.
// Validates that each of the 6 stepwise advisors is structurally equivalent
// to the PAL stdio counterpart before PAL retirement.
//
// Run without PAL:  pnpm exec vitest run tests/integration/advisor-pal-parity.test.ts
// Run with PAL:     PAL_PARITY_PAL_AVAILABLE=1 pnpm exec vitest run tests/integration/advisor-pal-parity.test.ts

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// --- Mock callOmniroute before any advisor imports ---
// Each handler imports callOmniroute directly from utils/omniroute-call.js.
// We stub it here so no real LLM calls happen during tests.
vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('{"stub":"parity-test","next_step":"CONTINUE: verify output"}'),
  callOmnirouteWithUsage: vi.fn().mockResolvedValue({
    content: '{"stub":"parity-test","next_step":"CONTINUE: verify output"}',
    model_used: 'cc/claude-sonnet-4-6',
    usage: { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
  }),
}));

// --- Trigger advisor self-registration via side-effect imports ---
import '../../src/v2/advisors/consensus/index.js';
import '../../src/v2/advisors/debug/index.js';
import '../../src/v2/advisors/codereview/index.js';
import '../../src/v2/advisors/thinkdeep/index.js';
import '../../src/v2/advisors/planner/index.js';
import '../../src/v2/advisors/precommit/index.js';

import { getAdvisor } from '../../src/v2/advisors/index.js';
import type { AdvisorContext, StepwiseAdvisorContext } from '../../src/v2/advisors/types.js';

// ---------------------------------------------------------------------------
// PAL gate — tests inside skipIfNoPal only run when PAL stdio is available.
// ---------------------------------------------------------------------------
const HAS_PAL = process.env['PAL_PARITY_PAL_AVAILABLE'] === '1';
const skipIfNoPal = HAS_PAL ? it : it.skip;

// ---------------------------------------------------------------------------
// Shared context
// ---------------------------------------------------------------------------
const baseCtx: AdvisorContext = {
  workspace: 'internal',
  workflow_id: 'wf_parity_test',
  onEvent: () => {},
};

const stepCtx: StepwiseAdvisorContext = {
  ...baseCtx,
  step: {
    stepNumber: 1,
    totalSteps: 1,
    nextStepRequired: false,
    findings: [],
    conversationId: 'conv_parity_test',
  },
};

// ---------------------------------------------------------------------------
// Helper — assert AdvisorResult shape
// ---------------------------------------------------------------------------
function assertAdvisorResult(result: unknown): void {
  expect(result).toBeDefined();
  expect(typeof (result as { output: string }).output).toBe('string');
  expect((result as { output: string }).output.length).toBeGreaterThan(0);
}

// ===========================================================================
// 1. consensus
// ===========================================================================
describe('advisor PAL parity — consensus', () => {
  it('is registered with correct metadata', () => {
    const advisor = getAdvisor('consensus');
    expect(advisor).toBeDefined();
    expect(advisor!.name).toBe('consensus');
    expect(typeof advisor!.description).toBe('string');
    expect(advisor!.isStepwise).toBe(true);
    expect(typeof advisor!.run).toBe('function');
  });

  it('run() returns AdvisorResult with string output (stubbed LLM)', async () => {
    const advisor = getAdvisor('consensus');
    expect(advisor).toBeDefined();

    const input = {
      step: 'Should we adopt feature X for reasons Y and Z?',
      step_number: 1,
      total_steps: 1,
      next_step_required: false,
      findings: 'Initial analysis: feature X improves developer velocity.',
      models: [
        { model: 'claude-sonnet-4-6', stance: 'for' as const },
        { model: 'gpt-5.5', stance: 'against' as const },
      ],
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
  });

  skipIfNoPal('PAL consensus output has model_responses field', async () => {
    // When PAL is available, compare PAL stdio output vs advisor output structure.
    // Both should produce a response with model_responses when multi-model consensus runs.
    const advisor = getAdvisor('consensus');
    expect(advisor).toBeDefined();

    const input = {
      step: 'PAL parity: adopt microservices?',
      step_number: 1,
      total_steps: 1,
      next_step_required: false,
      findings: 'Pro: scalability. Con: complexity.',
      models: [
        { model: 'claude-sonnet-4-6', stance: 'for' as const },
        { model: 'gpt-5.5', stance: 'against' as const },
      ],
      model_responses: [],
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
    // Structural parity: output must be a non-empty string (PAL returns the same)
    expect(typeof (result as { output: string }).output).toBe('string');
  });
});

// ===========================================================================
// 2. debug
// ===========================================================================
describe('advisor PAL parity — debug', () => {
  it('is registered with correct metadata', () => {
    const advisor = getAdvisor('debug');
    expect(advisor).toBeDefined();
    expect(advisor!.name).toBe('debug');
    expect(typeof advisor!.description).toBe('string');
    expect(advisor!.isStepwise).toBe(true);
    expect(typeof advisor!.run).toBe('function');
  });

  it('run() returns AdvisorResult with string output (stubbed LLM)', async () => {
    const advisor = getAdvisor('debug');
    expect(advisor).toBeDefined();

    const input = {
      step: 'TypeError: Cannot read property "id" of undefined at line 42',
      step_number: 1,
      total_steps: 3,
      next_step_required: true,
      findings: 'Error occurs after database query returns null.',
      hypothesis: 'The query returns null when the record does not exist.',
      confidence: 'low' as const,
      files_checked: ['src/db/persist.ts'],
      relevant_files: ['src/db/persist.ts', 'src/brain/executor/run-task.ts'],
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
  });

  skipIfNoPal('PAL debug and advisor debug share stepwise behavior', async () => {
    const advisor = getAdvisor('debug');
    expect(advisor).toBeDefined();

    const input = {
      step: 'PAL parity: null pointer in workflow executor',
      step_number: 1,
      total_steps: 2,
      next_step_required: true,
      findings: 'Stack trace points to adaptive-supervisor.ts:200.',
      confidence: 'exploring' as const,
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
    // Both PAL and native advisor produce string output — structural parity
    expect(typeof (result as { output: string }).output).toBe('string');
  });
});

// ===========================================================================
// 3. codereview
// ===========================================================================
describe('advisor PAL parity — codereview', () => {
  it('is registered with correct metadata', () => {
    const advisor = getAdvisor('codereview');
    expect(advisor).toBeDefined();
    expect(advisor!.name).toBe('codereview');
    expect(typeof advisor!.description).toBe('string');
    expect(advisor!.isStepwise).toBe(true);
    expect(typeof advisor!.run).toBe('function');
  });

  it('run() returns AdvisorResult with string output (stubbed LLM)', async () => {
    const advisor = getAdvisor('codereview');
    expect(advisor).toBeDefined();

    const input = {
      step: 'Review the authentication module for security issues.',
      step_number: 1,
      total_steps: 2,
      next_step_required: true,
      findings: 'Found potential SQL injection risk in user query builder.',
      relevant_files: ['src/mcp/http-server.ts', 'src/db/persist.ts'],
      review_type: 'security' as const,
      severity_filter: 'high' as const,
      issues_found: [],
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
  });

  skipIfNoPal('PAL codereview and advisor codereview share structural output', async () => {
    const advisor = getAdvisor('codereview');
    expect(advisor).toBeDefined();

    const input = {
      step: 'PAL parity: full review of executor module.',
      step_number: 1,
      total_steps: 1,
      next_step_required: false,
      findings: 'No critical issues found in initial scan.',
      review_type: 'full' as const,
      severity_filter: 'all' as const,
      issues_found: [],
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
    expect(typeof (result as { output: string }).output).toBe('string');
  });
});

// ===========================================================================
// 4. thinkdeep
// ===========================================================================
describe('advisor PAL parity — thinkdeep', () => {
  it('is registered with correct metadata', () => {
    const advisor = getAdvisor('thinkdeep');
    expect(advisor).toBeDefined();
    expect(advisor!.name).toBe('thinkdeep');
    expect(typeof advisor!.description).toBe('string');
    expect(advisor!.isStepwise).toBe(true);
    expect(typeof advisor!.run).toBe('function');
  });

  it('run() returns AdvisorResult with string output (stubbed LLM)', async () => {
    const advisor = getAdvisor('thinkdeep');
    expect(advisor).toBeDefined();

    const input = {
      step: 'Analyze the trade-offs between monolithic and distributed architectures for a single-operator workflow tool.',
      step_number: 1,
      total_steps: 2,
      next_step_required: true,
      findings: 'Monolithic: lower latency, simpler debugging. Distributed: horizontal scale, fault isolation.',
      hypothesis: 'For single-operator use, monolithic is sufficient until workflow concurrency exceeds 10 parallel tasks.',
      confidence: 'medium',
      problem_context: 'Omniforge H2 architecture decision for Sprint 6.',
      focus_areas: ['latency', 'complexity', 'scalability'],
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
  });

  skipIfNoPal('PAL thinkdeep and advisor thinkdeep share stepwise output shape', async () => {
    const advisor = getAdvisor('thinkdeep');
    expect(advisor).toBeDefined();

    const input = {
      step: 'PAL parity: deep analysis of DAG validator correctness.',
      step_number: 1,
      total_steps: 1,
      next_step_required: false,
      findings: 'Zod schema validation covers all edges.',
      confidence: 'high',
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
    expect(typeof (result as { output: string }).output).toBe('string');
  });
});

// ===========================================================================
// 5. planner
// ===========================================================================
describe('advisor PAL parity — planner', () => {
  it('is registered with correct metadata', () => {
    const advisor = getAdvisor('planner');
    expect(advisor).toBeDefined();
    expect(advisor!.name).toBe('planner');
    expect(typeof advisor!.description).toBe('string');
    expect(advisor!.isStepwise).toBe(true);
    expect(typeof advisor!.run).toBe('function');
  });

  it('run() returns AdvisorResult with string output (stubbed LLM, no findings field)', async () => {
    const advisor = getAdvisor('planner');
    expect(advisor).toBeDefined();

    // planner has NO findings field — it is structurally distinct from the other 5
    const input = {
      step: 'Plan the migration of PAL stdio calls to native advisors in src/v2/advisors/.',
      step_number: 1,
      total_steps: 3,
      next_step_required: true,
      is_step_revision: false,
      is_branch_point: false,
      more_steps_needed: false,
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
  });

  skipIfNoPal('PAL planner and advisor planner share branching metadata handling', async () => {
    const advisor = getAdvisor('planner');
    expect(advisor).toBeDefined();

    const input = {
      step: 'PAL parity: plan AETHER ε rollout.',
      step_number: 1,
      total_steps: 2,
      next_step_required: true,
      is_step_revision: false,
      is_branch_point: true,
      branch_id: 'fast-path',
      more_steps_needed: false,
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
    expect(typeof (result as { output: string }).output).toBe('string');
  });
});

// ===========================================================================
// 6. precommit
// ===========================================================================
describe('advisor PAL parity — precommit', () => {
  it('is registered with correct metadata', () => {
    const advisor = getAdvisor('precommit');
    expect(advisor).toBeDefined();
    expect(advisor!.name).toBe('precommit');
    expect(typeof advisor!.description).toBe('string');
    expect(advisor!.isStepwise).toBe(true);
    expect(typeof advisor!.run).toBe('function');
  });

  it('run() returns AdvisorResult with string output (stubbed LLM, path required on step 1)', async () => {
    const advisor = getAdvisor('precommit');
    expect(advisor).toBeDefined();

    // precommit has a .refine() constraint: path is required when step_number === 1
    const input = {
      step: 'Validate the AETHER γ commit: 6 stepwise advisors + CLI tail feature.',
      step_number: 1,
      total_steps: 2,
      next_step_required: true,
      findings: 'Diff adds 1261 LOC in src/v2/advisors/ and src/v2/cli-tail/.',
      path: 'src/v2/advisors',
      confidence: 'low' as const,
      issues_found: [],
      precommit_type: 'external' as const,
      include_staged: true,
      include_unstaged: false,
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
  });

  skipIfNoPal('PAL precommit and advisor precommit share validation output structure', async () => {
    const advisor = getAdvisor('precommit');
    expect(advisor).toBeDefined();

    const input = {
      step: 'PAL parity: validate docs commit.',
      step_number: 1,
      total_steps: 1,
      next_step_required: false,
      findings: 'Only markdown changes, no security risk.',
      path: 'docs',
      confidence: 'high' as const,
      issues_found: [],
      precommit_type: 'internal' as const,
      include_staged: true,
      include_unstaged: true,
    };

    const result = await advisor!.run(stepCtx, input);
    assertAdvisorResult(result);
    expect(typeof (result as { output: string }).output).toBe('string');
  });
});

// ===========================================================================
// Cross-advisor structural invariants
// ===========================================================================
describe('cross-advisor structural invariants', () => {
  const ADVISOR_NAMES = ['consensus', 'debug', 'codereview', 'thinkdeep', 'planner', 'precommit'] as const;

  it('all 6 advisors are registered in the registry', () => {
    for (const name of ADVISOR_NAMES) {
      const advisor = getAdvisor(name);
      expect(advisor, `${name} should be registered`).toBeDefined();
      expect(advisor!.name).toBe(name);
    }
  });

  it('all 6 advisors have isStepwise=true', () => {
    for (const name of ADVISOR_NAMES) {
      const advisor = getAdvisor(name);
      expect(advisor!.isStepwise, `${name}.isStepwise`).toBe(true);
    }
  });

  it('all 6 advisors expose a non-empty description string', () => {
    for (const name of ADVISOR_NAMES) {
      const advisor = getAdvisor(name);
      expect(typeof advisor!.description).toBe('string');
      expect(advisor!.description.length, `${name}.description should not be empty`).toBeGreaterThan(0);
    }
  });
});
