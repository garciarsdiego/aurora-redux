/**
 * Wave 3.F: tests for runMetaWorkflow stub.
 *
 * Covers:
 *   - Spec ids are preserved in the result, in submit order.
 *   - Concurrency cap is honoured (Promise.race over the in-flight pool).
 *   - Mixed success/failure across children → all_succeeded=false,
 *     any_failed=true, every child still recorded.
 *   - Runner that throws is treated as a failed child (not a meta-run abort).
 *   - Duplicate spec ids throw before scheduling — caller bug, not silent.
 *   - onChildSettled fires once per child, with the same outcome shape
 *     the result.children entry will carry.
 */

import { describe, expect, it } from 'vitest';

import {
  runMetaWorkflow,
  type MetaWorkflowChildOutcome,
  type MetaWorkflowSpec,
  type MetaWorkflowRunner,
} from '../../src/v2/meta-orchestrator/index.js';
import type { Workflow } from '../../src/types/index.js';

function makeWorkflow(
  id: string,
  status: Workflow['status'],
  objective = `obj-${id}`,
): Workflow {
  return {
    id,
    workspace: 'internal' as Workflow['workspace'],
    objective,
    pattern_id: null,
    status,
    started_at: 0,
    completed_at: null,
    created_at: 0,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    metadata: null,
  };
}

function spec(id: string, objective = `obj-${id}`): MetaWorkflowSpec {
  return { id, workspace: 'internal', objective };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runMetaWorkflow', () => {
  it('returns outcomes in submit order, even when completion order differs', async () => {
    const finishOrder: string[] = [];
    const runWorkflow: MetaWorkflowRunner = async (s) => {
      const dur = s.id === 'a' ? 30 : s.id === 'b' ? 5 : 15;
      await delay(dur);
      finishOrder.push(s.id);
      return makeWorkflow(`wf_${s.id}`, 'completed');
    };

    const result = await runMetaWorkflow(
      [spec('a'), spec('b'), spec('c')],
      { runWorkflow, maxConcurrency: 0 },
    );

    expect(result.children.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(result.all_succeeded).toBe(true);
    expect(result.any_failed).toBe(false);
    // Sanity check that the actual completion order was different from submit:
    expect(finishOrder).toEqual(['b', 'c', 'a']);
  });

  it('honours maxConcurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const runWorkflow: MetaWorkflowRunner = async (s) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(20);
      inFlight--;
      return makeWorkflow(`wf_${s.id}`, 'completed');
    };
    await runMetaWorkflow(
      [spec('a'), spec('b'), spec('c'), spec('d'), spec('e')],
      { runWorkflow, maxConcurrency: 2 },
    );
    expect(peak).toBe(2);
  });

  it('marks failed / cancelled children correctly without aborting siblings', async () => {
    const runWorkflow: MetaWorkflowRunner = async (s) => {
      if (s.id === 'a') return makeWorkflow('wf_a', 'completed');
      if (s.id === 'b') return makeWorkflow('wf_b', 'failed');
      if (s.id === 'c') return makeWorkflow('wf_c', 'cancelled');
      return makeWorkflow('wf_d', 'completed');
    };

    const result = await runMetaWorkflow(
      [spec('a'), spec('b'), spec('c'), spec('d')],
      { runWorkflow, maxConcurrency: 0 },
    );
    expect(result.children.find((c) => c.id === 'a')?.status).toBe('completed');
    expect(result.children.find((c) => c.id === 'b')?.status).toBe('failed');
    expect(result.children.find((c) => c.id === 'c')?.status).toBe('cancelled');
    expect(result.children.find((c) => c.id === 'd')?.status).toBe('completed');
    expect(result.all_succeeded).toBe(false);
    expect(result.any_failed).toBe(true);
  });

  it('captures runner exceptions as failed children', async () => {
    const runWorkflow: MetaWorkflowRunner = async (s) => {
      if (s.id === 'b') throw new Error('boom');
      return makeWorkflow(`wf_${s.id}`, 'completed');
    };
    const result = await runMetaWorkflow(
      [spec('a'), spec('b'), spec('c')],
      { runWorkflow, maxConcurrency: 0 },
    );
    const failed = result.children.find((c) => c.id === 'b');
    expect(failed?.status).toBe('failed');
    expect(failed?.workflow_id).toBeNull();
    expect(failed?.error).toContain('boom');
    expect(result.all_succeeded).toBe(false);
    // Siblings still completed.
    expect(result.children.filter((c) => c.status === 'completed')).toHaveLength(2);
  });

  it('throws on duplicate spec ids (caller bug, not silent dedup)', async () => {
    const runWorkflow: MetaWorkflowRunner = async (s) =>
      makeWorkflow(`wf_${s.id}`, 'completed');
    await expect(
      runMetaWorkflow(
        [spec('a'), spec('a')],
        { runWorkflow, maxConcurrency: 0 },
      ),
    ).rejects.toThrow(/Duplicate meta-workflow spec id/);
  });

  it('fires onChildSettled exactly once per child with matching shape', async () => {
    const settled: MetaWorkflowChildOutcome[] = [];
    const runWorkflow: MetaWorkflowRunner = async (s) =>
      makeWorkflow(`wf_${s.id}`, s.id === 'b' ? 'failed' : 'completed');
    const result = await runMetaWorkflow(
      [spec('a'), spec('b'), spec('c')],
      {
        runWorkflow,
        maxConcurrency: 0,
        onChildSettled: (o) => settled.push(o),
      },
    );
    expect(settled).toHaveLength(3);
    for (const o of settled) {
      const fromResult = result.children.find((c) => c.id === o.id);
      expect(fromResult?.status).toBe(o.status);
      expect(fromResult?.workflow_id).toBe(o.workflow_id);
    }
  });

  it('returns total_duration_ms covering the entire run', async () => {
    const runWorkflow: MetaWorkflowRunner = async (s) => {
      await delay(15);
      return makeWorkflow(`wf_${s.id}`, 'completed');
    };
    const result = await runMetaWorkflow(
      [spec('a'), spec('b')],
      { runWorkflow, maxConcurrency: 0 },
    );
    // Both ran in parallel. Keep the upper bound loose enough for loaded CI/Windows runs.
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(10);
    expect(result.total_duration_ms).toBeLessThan(250);
  });

  it('returns instantly when given an empty spec list', async () => {
    const runWorkflow: MetaWorkflowRunner = async () =>
      Promise.reject(new Error('should not be called'));
    const result = await runMetaWorkflow([], { runWorkflow, maxConcurrency: 0 });
    expect(result.children).toEqual([]);
    expect(result.all_succeeded).toBe(true); // every() over [] is true
    expect(result.any_failed).toBe(false);
  });
});
