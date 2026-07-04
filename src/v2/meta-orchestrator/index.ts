/**
 * Wave 3.F — Meta-Orchestrator for multi-agent workflows.
 *
 * Sprint 3 Implementation:
 * - Enhanced meta-orchestrator with consolidation logic integration
 * - Coordinates parallel execution of multiple workflows
 * - Synthesizes multi-agent results using consolidator persona
 * - Provides fallback when consolidation fails
 *
 * Key capabilities:
 *   - Parallel workflow execution with concurrency control
 *   - Integration with consolidation orchestrator for result synthesis
 *   - Structured outcome tracking (success/failure/conflicts/gaps)
 *   - Pluggable workflow runner for testability
 *
 * Architecture:
 *   - runMetaWorkflow: Main entry point for parallel execution
 *   - orchestrateConsolidation: Consolidates multi-agent results
 *   - Uses stream-fork dispatcher for efficient concurrency
 */

import { dispatchStreamFork } from '../../brain/executor/stream-fork-dispatcher.js';
import type { Dag, Workflow } from '../../types/index.js';
import {
  orchestrateConsolidation,
  type ConsolidationOrchestratorResult,
} from './consolidation-orchestrator.js';

export interface MetaWorkflowSpec {
  /** Unique-within-batch identifier — keys returned status maps. */
  readonly id: string;
  /** Workspace that scopes this child workflow. */
  readonly workspace: string;
  /** High-level objective text routed into the child's decomposer. */
  readonly objective: string;
  /**
   * Pre-built DAG. When present, the child workflow uses it directly
   * (skipping decompose). When absent, the runner is expected to plan
   * one from `objective` — the runner injection knows how.
   */
  readonly dag?: Dag;
  /** Forwarded as Workflow.pattern_id so runs trace back to a saved pattern. */
  readonly patternId?: string;
}

export interface MetaWorkflowChildOutcome {
  readonly id: string;
  readonly workflow_id: string | null;
  readonly status: 'completed' | 'failed' | 'cancelled';
  /**
   * Best-effort summary string (last task's output_json or similar). The
   * caller is free to populate; the stub only sets it on success when
   * the runner returned a Workflow with status === 'completed'.
   */
  readonly summary?: string;
  readonly error?: string;
  readonly duration_ms: number;
}

export interface MetaWorkflowResult {
  readonly children: readonly MetaWorkflowChildOutcome[];
  /** True when every child finished with status === 'completed'. */
  readonly all_succeeded: boolean;
  /** True when at least one child failed or was cancelled. */
  readonly any_failed: boolean;
  /** Wall-clock duration of the entire meta-run. */
  readonly total_duration_ms: number;
  /** Consolidation result if consolidation was enabled */
  readonly consolidation?: ConsolidationOrchestratorResult;
}

export type MetaWorkflowRunner = (spec: MetaWorkflowSpec) => Promise<Workflow>;

export interface RunMetaWorkflowOptions {
  /** Cap on concurrent child workflows. <= 0 = unlimited. Default 3. */
  readonly maxConcurrency?: number;
  /** Injected runner — daemon binds to executeWorkflow; tests stub. */
  readonly runWorkflow: MetaWorkflowRunner;
  /**
   * Optional progress hook so the dashboard / CLI can render a live tally
   * (`3 of 5 complete`) while the meta-run is in flight.
   */
  readonly onChildSettled?: (outcome: MetaWorkflowChildOutcome) => void;
  /**
   * Whether to run consolidation after all children complete.
   * Default: true.
   */
  readonly consolidate?: boolean;
  /**
   * Optional workspace root for file validation during consolidation.
   */
  readonly workspaceDir?: string;
}

interface PoolItem {
  readonly id: string;
  readonly spec: MetaWorkflowSpec;
}

/**
 * Run a list of workflow specs in parallel, return a structured outcome.
 * Errors do NOT short-circuit — every spec runs to completion (success
 * OR failure) so the caller sees the full picture. Use the returned
 * `any_failed` flag to decide whether to escalate.
 *
 * If consolidation is enabled (default), runs the consolidation orchestrator
 * to synthesize multi-agent results into a single coherent output.
 */
export async function runMetaWorkflow(
  specs: readonly MetaWorkflowSpec[],
  options: RunMetaWorkflowOptions,
): Promise<MetaWorkflowResult> {
  const start = Date.now();
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.id)) {
      throw new Error(`Duplicate meta-workflow spec id: ${s.id}`);
    }
    seen.add(s.id);
  }

  const outcomes = new Map<string, MetaWorkflowChildOutcome>();

  await dispatchStreamFork<PoolItem, string>({
    initialReady: specs.map((spec) => ({ id: spec.id, spec })),
    maxConcurrency: options.maxConcurrency ?? 3,
    run: async (item) => {
      const childStart = Date.now();
      try {
        const wf = await options.runWorkflow(item.spec);
        const status: MetaWorkflowChildOutcome['status'] =
          wf.status === 'completed' ? 'completed'
          : wf.status === 'cancelled' ? 'cancelled'
          : 'failed';
        const outcome: MetaWorkflowChildOutcome = {
          id: item.id,
          workflow_id: wf.id,
          status,
          duration_ms: Date.now() - childStart,
          ...(status === 'completed'
            ? { summary: extractSummary(wf) }
            : { error: extractError(wf) }),
        };
        outcomes.set(item.id, outcome);
      } catch (err) {
        outcomes.set(item.id, {
          id: item.id,
          workflow_id: null,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          duration_ms: Date.now() - childStart,
        });
      }
    },
    onComplete: (item) => {
      const outcome = outcomes.get(item.id);
      if (outcome) options.onChildSettled?.(outcome);
    },
    onError: (item) => {
      // dispatchStreamFork only surfaces an error when run() rejects,
      // but our runner never throws — we capture errors inline above.
      // This branch exists for completeness so a future change to run()
      // semantics doesn't silently lose the failure.
      const fallback: MetaWorkflowChildOutcome = {
        id: item.id,
        workflow_id: null,
        status: 'failed',
        error: 'unknown runner error',
        duration_ms: 0,
      };
      outcomes.set(item.id, fallback);
      options.onChildSettled?.(fallback);
    },
  });

  // Preserve submit order for the result so callers can correlate by index.
  const children = specs.map((s) =>
    outcomes.get(s.id) ?? {
      id: s.id,
      workflow_id: null,
      status: 'failed' as const,
      error: 'spec dropped by dispatcher',
      duration_ms: 0,
    },
  );

  const allSucceeded = children.every((c) => c.status === 'completed');
  const anyFailed = children.some((c) => c.status !== 'completed');

  // Run consolidation if enabled (default: true)
  let consolidation: ConsolidationOrchestratorResult | undefined;
  if (options.consolidate !== false) {
    // Use the first spec's objective as the meta-workflow objective
    const metaObjective = specs[0]?.objective ?? 'Multi-agent workflow';
    consolidation = await orchestrateConsolidation({
      workflow_id: `meta-${Date.now()}`,
      workflow_objective: metaObjective,
      child_outcomes: children,
      workspace_dir: options.workspaceDir,
    });
  }

  return {
    children,
    all_succeeded: allSucceeded,
    any_failed: anyFailed,
    total_duration_ms: Date.now() - start,
    consolidation,
  };
}

/**
 * Pull a one-line summary from the child workflow. Stub heuristic:
 * the workflow record itself doesn't carry an aggregate output text yet,
 * so we fall back to the objective + status. A future consolidator
 * persona will do real synthesis.
 */
function extractSummary(wf: Workflow): string {
  return `Workflow '${wf.objective ?? wf.id}' completed (id=${wf.id})`;
}

function extractError(wf: Workflow): string {
  return `Workflow '${wf.objective ?? wf.id}' ended with status=${wf.status}`;
}
