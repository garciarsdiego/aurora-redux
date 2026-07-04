/**
 * BRAIN-01 — deterministic state seam, end-to-end through executeWorkflow.
 *
 * Proves that deterministic step kinds (extract_json -> if_else -> print) run
 * against REAL upstream state — not the empty {} they saw before BRAIN-01 wired
 * a per-workflow sharedState into the default executeTask dispatch wrapper.
 *
 * This is NOT a hand-seeded unit harness: it drives the full executeWorkflow
 * materialisation path (DAG ids -> runtime UUIDs, input_json stamping, the
 * runTaskLoop reseed-each-tick). Only the Omniroute transport is stubbed so the
 * single llm_call producer emits deterministic JSON offline; the reviewer and
 * consolidator are stubbed to keep the test self-contained (the same pattern as
 * tests/unit/executor.test.ts) — neither touches the deterministic dispatch
 * path under test.
 *
 * The loop re-dispatch case (BRAIN-02) is intentionally OMITTED — that work is
 * deferred; the loop case keeps its existing no-op executeStep fallback.
 *
 * DB + Omniroute-mock setup mirror the established integration/unit tests:
 *   - initDb(':memory:')               (tests/unit/executor.test.ts)
 *   - vi.hoisted + vi.mock omniroute   (tests/integration/step-kinds-smoke.test.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub Omniroute BEFORE importing the executor that pulls it transitively.
// runOmniRouteTask uses callOmnirouteWithUsage; we mock both exports so any
// transitive caller stays offline.
const omnirouteMock = vi.hoisted(() => ({
  callOmniroute: vi.fn(),
  callOmnirouteWithUsage: vi.fn(),
}));
vi.mock('../../src/utils/omniroute-call.js', () => omnirouteMock);

import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import { loadWorkflowTasks } from '../../src/db/persist.js';
import type { Dag, Task, ReviewResult } from '../../src/types/index.js';

// Stub review + consolidate so the run is deterministic and offline. These do
// NOT replace executeTaskFn — the deterministic kinds still flow through the
// real executeTask dispatch (and thus the BRAIN-01 sharedState seam).
const stubConsolidate = async (): Promise<string> => 'stub consolidated output';
const stubReview = async (): Promise<ReviewResult> => ({ score: 1, feedback: 'ok', passed: true });

describe('orchestrate deterministic state seam (BRAIN-01) — end-to-end', () => {
  beforeEach(() => {
    omnirouteMock.callOmniroute.mockReset();
    omnirouteMock.callOmnirouteWithUsage.mockReset();
    // t1 (llm_call) returns JSON describing US state facts.
    omnirouteMock.callOmnirouteWithUsage.mockResolvedValue({
      content: '{"state_count": 50, "year": 1850}',
      usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 },
    });
    omnirouteMock.callOmniroute.mockResolvedValue('{"state_count": 50, "year": 1850}');
  });

  it('extract_json -> if_else -> print renders REAL upstream values (not empty {})', async () => {
    const db = initDb(':memory:');

    const dag: Dag = {
      tasks: [
        {
          id: 't1', name: 'Lookup facts', kind: 'llm_call', depends_on: [],
          model: 'cx/stub',
          acceptance_criteria: 'returns state_count and year as JSON',
        },
        {
          id: 't2', name: 'Parse facts', kind: 'extract_json', depends_on: ['t1'],
          input_keys: ['t1'], output_key: 'facts',
          acceptance_criteria: 'writes facts object',
        },
        {
          id: 't3', name: 'Branch on count', kind: 'if_else', depends_on: ['t2'],
          if_condition: 'state.facts.state_count >= 50',
          if_true_step_id: 't4', if_false_step_id: 't5',
          acceptance_criteria: 'routes by count',
        },
        {
          id: 't4', name: 'Render answer', kind: 'print', depends_on: ['t3'],
          print_template: 'US has {state.facts.state_count} states; CA joined {state.facts.year}.',
          output_key: 'final_answer',
          acceptance_criteria: 'renders count and year',
        },
        {
          id: 't5', name: 'Fallback', kind: 'print', depends_on: ['t3'],
          print_template: 'insufficient data', output_key: 'final_answer',
          acceptance_criteria: 'fallback branch',
        },
      ],
    } as unknown as Dag;

    const wf = await executeWorkflow(db, dag, 'internal', 'state facts', {
      autoApprove: true,
      quotaGuardMode: 'off',
      consolidateFn: stubConsolidate,
      reviewFn: stubReview,
    });
    expect(wf.status).toBe('completed');

    const tasks = loadWorkflowTasks(db, wf.id);
    const byName = (n: string): Task => tasks.find((t) => t.name === n)!;

    // if_else took the TRUE branch (state.facts.state_count >= 50) -> t4 ran.
    const ifTask = byName('Branch on count');
    expect((JSON.parse(ifTask.output_json!) as { decision: string }).decision).toBe('true');

    // The FALSE branch (t5) was routing-skipped, proving the condition saw real state.
    expect(byName('Fallback').status).toBe('skipped');

    // print rendered real upstream values — the whole point of the fix.
    const printTask = byName('Render answer');
    expect(printTask.status).toBe('completed');
    expect(printTask.output_json).toContain('US has 50 states');
    expect(printTask.output_json).toContain('CA joined 1850');
    // Regression guard: NOT the empty-{} render.
    expect(printTask.output_json).not.toContain('US has  states');

    db.close();
  });
});
