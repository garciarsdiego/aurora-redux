import type Database from 'better-sqlite3';
import type { Dag, DagTask, Workflow, Task, TaskStatus } from '../../types/index.js';
import {
  newWorkflowId,
  newTaskId,
  insertWorkflow,
  insertTask,
  insertEvent,
  setWorkflowDone,
  setTaskPending,
  setTaskCompleted,
  setTaskFailed,
  setTaskSkipped,
  loadWorkflowTasks,
} from '../../db/persist.js';
import { promptApproval } from '../../hitl/cli.js';
import { reviewTask } from '../../reviewer/reviewer.js';
import { consolidateWorkflow } from '../consolidator.js';
import {
  checkQuota,
  costReport,
  bestComboForTask,
  syncWorkflowCostsOnCompletion,
} from '../../v2/omniroute-bridge/index.js';
import {
  getRefineCostPerCallUsd,
  getMaxRefineTimeMs,
  getQuotaGuardMode,
  getAdaptiveMaxIterations,
  getMaxParallelTasks,
  getFinalQualityReviewMode,
} from '../../utils/config.js';
import type { TaskLoopOpts, ExecuteWorkflowOpts } from './types.js';
import { pathsOverlap } from '../../v2/scheduling/file-scope.js';
import { executeTask, sleep } from './internal-utils.js';
import { executeTaskWithRetry } from './run-task.js';
import { detectFanoutUpstreams, runAutoSummaryTask } from './auto-summary.js';
import { runConsolidation, runFinalValidationStep } from './consolidation.js';
import { runAdaptiveSupervisor } from './adaptive-supervisor.js';
import { clearWorkflowCostReservations } from './cost-cap.js';
import type { SubagentEvent } from './adaptive-supervisor.types.js';
import { buildTaskExecutionContext } from '../../utils/execution-context.js';
import { runAutoCaptureHook } from '../../patterns/auto-capture.js';
import { recordReflection } from '../../v2/reflection/store.js';
import { loadWorkspaceProfile } from '../../utils/workspace-profile.js';
import { startTraceSpan, endTraceSpan, spanContextStorage } from '../../v2/observability/tracing.js';
import { waitForWorkflowControlCheckpoint } from '../../db/workflow-control.js';
import { safeEnsureWorkflowContext } from '../../context/workflow-adapter.js';
import { safeEnsureWorkflowWorkGraph } from '../../context/work-graph.js';
import { enforceFinalQualityReview } from '../../quality/final-reviewer.js';
import { resolveParentAfterRemediation } from '../../quality/remediation.js';
import { safeParseJson } from '../../utils/safe-parse-json.js';
import {
  notifyWorkflowCompleted,
  notifyWorkflowFailed,
} from '../../mcp/notification-service.js';

const ROUTING_KINDS = new Set(['if_else', 'switch', 'evaluator'] as const);

// WIRE-04 — fire-and-forget, fully fail-safe wrapper around the notification
// service. The notification WRITE side (bell / inbox panel) reads the
// `notifications` table; nothing wrote to it before this wiring. This helper
// MUST NOT throw into the orchestration path and MUST NOT block workflow
// completion, so the async createNotification is dispatched without await.
// On failure, LOG to stderr (observable in the daemon log) rather than
// insertEvent — appending a workflow event after the terminal
// workflow_completed would break the "completed is the last event" invariant
// (and pollute the lifecycle stream).
function fireWorkflowNotification(
  kind: 'completed' | 'failed',
  wfId: string,
  objective: string,
  error = '',
): void {
  try {
    const dispatched = kind === 'completed'
      ? notifyWorkflowCompleted(wfId, objective)
      : notifyWorkflowFailed(wfId, objective, error);
    void dispatched.catch((err) => {
      process.stderr.write(
        `[notification] workflow_${kind} dispatch failed for ${wfId}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    });
  } catch (err) {
    process.stderr.write(
      `[notification] workflow_${kind} dispatch threw synchronously for ${wfId}: ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function shouldInjectExecutionPlan(task: { name: string; acceptance_criteria?: string | null }): boolean {
  const combined = `${task.name}\n${task.acceptance_criteria ?? ''}`.toLowerCase();
  return combined.includes('execution plan') || (
    combined.includes('plan lists') &&
    combined.includes('subsequent tasks') &&
    combined.includes('deliverable')
  );
}

function buildExecutionPlanInput(
  dag: Dag,
  idMap: Map<string, string>,
  currentDagTaskId: string,
): Record<string, unknown> {
  return {
    current_task_id: currentDagTaskId,
    current_runtime_task_id: idMap.get(currentDagTaskId) ?? currentDagTaskId,
    tasks: dag.tasks.map((task) => ({
      id: task.id,
      runtime_task_id: idMap.get(task.id) ?? task.id,
      name: task.name,
      kind: task.kind,
      depends_on: task.depends_on,
      deliverable: task.output_summary ?? task.acceptance_criteria ?? task.name,
      acceptance_criteria: task.acceptance_criteria ?? null,
    })),
  };
}

/**
 * After routing tasks (if_else / switch / evaluator) complete, their output JSON
 * contains a `next_step_id` field that identifies which branch to execute.
 * Any pending task that (a) depends directly on a completed routing task and
 * (b) is NOT the chosen `next_step_id` target should be skipped so the DAG
 * does not deadlock.
 */
function applyRoutingSkips(
  db: Database.Database,
  tasks: Task[],
  completedIds: Set<string>,
  wfId: string,
): void {
  for (const task of tasks) {
    if (!ROUTING_KINDS.has(task.kind as 'if_else' | 'switch' | 'evaluator')) continue;
    if (task.status !== 'completed' || !task.output_json) continue;

    let nextStepId: string | null = null;
    try {
      const parsed = JSON.parse(task.output_json) as Record<string, unknown>;
      nextStepId = typeof parsed['next_step_id'] === 'string' ? parsed['next_step_id'] : null;
    } catch {
      continue;
    }

    // Skip any pending task that only depends on this routing task
    // (and no other incomplete tasks) and is not the chosen branch.
    for (const candidate of tasks) {
      if (candidate.status !== 'pending') continue;
      if (!candidate.depends_on.includes(task.id)) continue;
      if (nextStepId !== null && candidate.id === nextStepId) continue;

      // Only skip if ALL deps are completed (otherwise it may have other blockers).
      const allDepsComplete = candidate.depends_on.every((depId) => completedIds.has(depId) || depId === task.id);
      if (!allDepsComplete) continue;

      setTaskSkipped(db, candidate.id, JSON.stringify({ skip_reason: 'routing_branch_not_selected', routing_task_id: task.id }));
      candidate.status = 'skipped';
      completedIds.add(candidate.id);
      insertEvent(db, {
        workflow_id: wfId,
        task_id: candidate.id,
        type: 'task_routing_skipped',
        payload: { routing_task_id: task.id, next_step_id: nextStepId },
      });
    }
  }
}

/**
 * BRAIN-01 — serialize a DAG task's deterministic step-kind configuration into
 * the object that becomes input_json, remapping any branch/body id references
 * from DAG ids to runtime UUIDs.
 *
 * The runtime `Task` interface (and the `tasks` table) carry NO dedicated
 * columns for print_template / if_condition / loop_step_ids / input_keys / etc.
 * They survive only via input_json, from which
 * hydrateDeterministicArgsFromInputJson (internal-utils.ts) restores them onto
 * the Task before a deterministic-kind dispatch. Without this, every
 * deterministic step materialised through executeWorkflow would read undefined
 * config and produce empty/garbage output.
 *
 * Id-bearing fields (if/switch/evaluator branch targets, loop bodies) reference
 * other DAG tasks by their DAG id. They are remapped through idMap so that the
 * routing-skip comparison (`candidate.id === next_step_id` in applyRoutingSkips)
 * and any id-based lookup resolve against the materialised runtime task rows.
 * `state.*` placeholders and input_keys deliberately stay DAG-id keyed because
 * sharedState is seeded by DAG id (seedSharedStateFromCompleted), matching the
 * decomposer's {state.t1.*} contract.
 */
function buildDeterministicStepConfig(
  dagTask: DagTask,
  idMap: Map<string, string>,
): Record<string, unknown> {
  const remapId = (id: string | null | undefined): string | null | undefined =>
    typeof id === 'string' ? (idMap.get(id) ?? id) : id;
  const out: Record<string, unknown> = {};

  // ── if_else ──────────────────────────────────────────────────────────────
  if (dagTask.if_condition !== undefined) out['if_condition'] = dagTask.if_condition;
  if (dagTask.if_true_step_id !== undefined) out['if_true_step_id'] = remapId(dagTask.if_true_step_id);
  if (dagTask.if_false_step_id !== undefined) out['if_false_step_id'] = remapId(dagTask.if_false_step_id);

  // ── switch ─────────────────────────────────────────────────────────────--
  if (dagTask.switch_expression !== undefined) out['switch_expression'] = dagTask.switch_expression;
  if (dagTask.switch_cases !== undefined) {
    out['switch_cases'] = Object.fromEntries(
      Object.entries(dagTask.switch_cases).map(([k, v]) => [k, remapId(v) ?? null]),
    );
  }
  if (dagTask.switch_default_step_id !== undefined) {
    out['switch_default_step_id'] = remapId(dagTask.switch_default_step_id) ?? null;
  }

  // ── loop ───────────────────────────────────────────────────────────────--
  if (dagTask.loop_count !== undefined) out['loop_count'] = dagTask.loop_count;
  if (dagTask.loop_step_ids !== undefined) {
    out['loop_step_ids'] = dagTask.loop_step_ids.map((id) => remapId(id) ?? id);
  }

  // ── merge ──────────────────────────────────────────────────────────────--
  if (dagTask.merge_strategy !== undefined) out['merge_strategy'] = dagTask.merge_strategy;
  // merge_branch_outputs are sharedState keys (DAG ids / output_keys), not task ids.
  if (dagTask.merge_branch_outputs !== undefined) out['merge_branch_outputs'] = dagTask.merge_branch_outputs;

  // ── transform / print ──────────────────────────────────────────────────--
  if (dagTask.transform_code !== undefined) out['transform_code'] = dagTask.transform_code;
  if (dagTask.print_template !== undefined) out['print_template'] = dagTask.print_template;

  // ── evaluator ──────────────────────────────────────────────────────────--
  if (dagTask.evaluator_prompt !== undefined) out['evaluator_prompt'] = dagTask.evaluator_prompt;
  if (dagTask.evaluator_route_map !== undefined) {
    out['evaluator_route_map'] = Object.fromEntries(
      Object.entries(dagTask.evaluator_route_map).map(([k, v]) => [k, remapId(v) ?? null]),
    );
  }

  // ── shared (extract_json / evaluator / transform read input_keys; many write output_key) ──
  // input_keys are sharedState keys (DAG ids / output_keys), not task ids.
  if (dagTask.input_keys !== undefined) out['input_keys'] = dagTask.input_keys;
  if (dagTask.output_key !== undefined) out['output_key'] = dagTask.output_key;
  if (dagTask.state_schema !== undefined) out['state_schema'] = dagTask.state_schema;

  return out;
}

// Internal helper: fan out a SubagentEvent to the caller's hook and the events table.
// Errors are swallowed so the supervisor loop is never interrupted by observability failures.
async function doOnSubagentEvent(
  db: Database.Database,
  event: SubagentEvent,
  wfId: string,
  opts: TaskLoopOpts,
): Promise<void> {
  try {
    await opts.onSubagentEvent?.(event);
  } catch { /* observability hook errors must not propagate */ }

  const taskId = 'taskId' in event ? event.taskId : null;
  try {
    insertEvent(db, {
      workflow_id: wfId,
      task_id: taskId,
      type: event.type,
      payload: event,
    });
  } catch { /* DB errors must not propagate */ }
}

// Loop phase (a) — select the ready candidates, order them workload-first,
// filter file-scope overlaps and apply the parallelism cap. Pure move out of
// runTaskLoop; behaviour (including the deadlock throw and the
// workflow_parallelism_limited events) is unchanged.
function selectReadyBatch(
  db: Database.Database,
  wfId: string,
  pending: Task[],
  completedIds: Set<string>,
  maxParallelTasks: number,
): Task[] {
  // All tasks whose dependencies are satisfied form the ready candidates.
  // A runtime cap can intentionally throttle the fan-out without changing
  // DAG semantics; the next loop picks up the remaining ready tasks.
  const readyCandidates = pending.filter((t) =>
    t.depends_on.every((dep) => completedIds.has(dep)),
  );

  if (readyCandidates.length === 0) {
    setWorkflowDone(db, wfId, 'failed');
    throw new Error(`Cycle or unsatisfiable dependency in workflow ${wfId}`);
  }

  // OTIMIZAÇÃO 3: Workload-aware scheduling - priorizar tasks mais longas primeiro
  // Isso maximiza o paralelismo executando tasks longas em paralelo com tasks curtas
  const sortedReadyCandidates = [...readyCandidates].sort((a, b) => {
    const timeoutA = a.timeout_seconds || 300; // Default 5 min
    const timeoutB = b.timeout_seconds || 300;
    return timeoutB - timeoutA; // Decrescente: tasks mais longas primeiro
  });

  // File-scope overlap guard (Fusion Tier 1 T1.2):
  // When multiple ready candidates declare file_scope, avoid scheduling two
  // that touch the same paths concurrently. Walk candidates in order; once a
  // task is accepted into the batch, collect its scope and skip any later
  // candidate that overlaps it. Deferred candidates remain pending and are
  // picked up on the next loop iteration after the current batch settles.
  const activeScopes: Array<string[]> = [];
  const fileScopeFiltered: typeof readyCandidates = [];
  const fileScopeDeferred: typeof readyCandidates = [];
  for (const candidate of sortedReadyCandidates) { // OTIMIZAÇÃO 3: Usar sorted
    const scope = candidate.file_scope ?? [];
    if (scope.length > 0 && activeScopes.some((s) => pathsOverlap(scope, s))) {
      fileScopeDeferred.push(candidate);
    } else {
      fileScopeFiltered.push(candidate);
      if (scope.length > 0) activeScopes.push(scope);
    }
  }

  // If every ready candidate was file-scope deferred, run the first deferred task to
  // guarantee forward progress and prevent an infinite spin (no completions → same
  // candidate set next tick).
  const cappedCandidates = fileScopeFiltered.length > 0
    ? fileScopeFiltered
    : fileScopeDeferred.slice(0, 1);
  const readyBatch = maxParallelTasks > 0
    ? cappedCandidates.slice(0, maxParallelTasks)
    : cappedCandidates;

  if (fileScopeDeferred.length > 0) {
    insertEvent(db, {
      workflow_id: wfId,
      type: 'workflow_parallelism_limited',
      payload: {
        limit: maxParallelTasks,
        ready_count: readyCandidates.length,
        scheduled_count: readyBatch.length,
        file_scope_deferred: fileScopeDeferred.map((t) => t.id),
      },
    });
  } else if (maxParallelTasks > 0 && readyCandidates.length > readyBatch.length) {
    insertEvent(db, {
      workflow_id: wfId,
      type: 'workflow_parallelism_limited',
      payload: {
        limit: maxParallelTasks,
        ready_count: readyCandidates.length,
        scheduled_count: readyBatch.length,
      },
    });
  }

  return readyBatch;
}

// Loop phase (b) — Bloco 1.5: detect fan-out upstreams that qualify for
// auto-summary and inject the summaries into each dependent's input_json.
// Pure move out of runTaskLoop.
async function injectFanoutAutoSummaries(
  db: Database.Database,
  tasks: Task[],
  readyBatch: Task[],
  wfId: string,
  ws: string,
  doExecute: (task: Task, signal?: AbortSignal) => Promise<string>,
  doSleep: (ms: number) => Promise<void>,
): Promise<void> {
  const completedTasks = tasks.filter(t => t.status === 'completed');
  const fanoutUpstreams = detectFanoutUpstreams(readyBatch, completedTasks);
  for (const upstreamId of fanoutUpstreams) {
    const upstream = completedTasks.find(t => t.id === upstreamId)!;
    const dependents = readyBatch.filter(t => t.depends_on.includes(upstreamId));
    insertEvent(db, {
      workflow_id: wfId,
      task_id: upstream.id,
      type: 'task_auto_summary_injected',
      payload: {
        upstream_task_id: upstreamId,
        dependent_task_ids: dependents.map(t => t.id),
        upstream_output_length: upstream.output_json?.length ?? 0,
      },
    });
    const summaryText = await runAutoSummaryTask(
      db, upstream, dependents, wfId, ws, doExecute, doSleep,
    );
    insertEvent(db, {
      workflow_id: wfId,
      task_id: upstream.id,
      type: 'task_auto_summary_completed',
      payload: { upstream_task_id: upstreamId, summary_length: summaryText.length },
    });
    for (const dep of dependents) {
      const depCtx = safeParseJson<Record<string, unknown>>(dep.input_json, {
        db,
        workflowId: wfId,
        taskId: dep.id,
        where: 'auto_summary_merge_summarized_upstreams',
      }) ?? {};
      const existing = (depCtx['summarized_upstreams'] ?? {}) as Record<string, string>;
      dep.input_json = JSON.stringify({
        ...depCtx,
        summarized_upstreams: { ...existing, [upstreamId]: summaryText },
      });
    }
  }
}

// Loop phase (d) — adaptive path: a single supervisor call drives all adaptive
// tasks in the batch, and its outcomes are mapped to PromiseSettledResult so
// the rest of the loop (completedIds += success, throw on first rejection)
// treats them uniformly with the ephemeral results. Pure move out of
// runTaskLoop.
async function runAdaptiveBatch(
  db: Database.Database,
  adaptiveBatch: Task[],
  wfId: string,
  opts: TaskLoopOpts,
): Promise<PromiseSettledResult<void>[]> {
  let adaptiveResults: PromiseSettledResult<void>[] = [];
  if (adaptiveBatch.length === 0) return adaptiveResults;

  try {
    const supervisorResult = await runAdaptiveSupervisor(db, adaptiveBatch, {
      workflowId: wfId,
      workspace: opts.workspace ?? '',
      maxIterations: opts.adaptiveMaxIterations ?? getAdaptiveMaxIterations(),
      executeTurnFn: opts.adaptiveExecuteTurnFn,
      onSubagentEvent: (event: SubagentEvent) => doOnSubagentEvent(db, event, wfId, opts),
    });

    // R-MED-1 fix: this push loop is INSIDE the try so a mid-loop throw can
    // not produce a partially-populated array that the catch block then
    // doubles. Either we fully populate, or catch resets to a clean fail.
    for (const task of adaptiveBatch) {
      const outcome = supervisorResult.outcomes.get(task.id);
      if (outcome === undefined || outcome.status === 'ok') {
        const resultText = outcome?.resultText ?? '(empty adaptive output)';
        setTaskCompleted(db, task.id, resultText);
        task.status = 'completed';
        task.output_json = resultText;
        adaptiveResults.push({ status: 'fulfilled', value: undefined });
      } else {
        setTaskFailed(db, task.id);
        task.status = 'failed';
        adaptiveResults.push({
          status: 'rejected',
          reason: new Error(`Adaptive task '${task.name}' failed: ${outcome.errorMsg ?? outcome.status}`),
        });
      }
    }
  } catch (err) {
    // Whole-supervisor failure (or a throw inside the outcome-mapping loop
    // above). Reset adaptiveResults to guarantee the array length matches
    // adaptiveBatch.length so the readyBatch.map indexing stays valid.
    adaptiveResults = [];
    for (const task of adaptiveBatch) {
      setTaskFailed(db, task.id);
      task.status = 'failed';
      insertEvent(db, {
        workflow_id: wfId,
        task_id: task.id,
        type: 'adaptive_supervisor_error',
        payload: { error: (err as Error).message },
      });
      adaptiveResults.push({ status: 'rejected', reason: err as Error });
    }
  }
  return adaptiveResults;
}

// Exported for unit-testing retry and parallelism directly.
export async function runTaskLoop(
  db: Database.Database,
  tasks: Task[],
  wfId: string,
  completedIds: Set<string>,
  opts: TaskLoopOpts = {},
): Promise<void> {
  const ws = opts.workspace ?? '';
  const objective = opts.objective ?? '';
  const workflowSpanId = opts.workflowSpanId;

  // BRAIN-01 — single per-workflow shared state for deterministic step kinds.
  // The decomposer references upstream outputs by DAG task id ({state.t1.x},
  // input_keys:["t1"], merge_branch_outputs:["t1"]), so this object is keyed by
  // DAG id -> that task's output, PLUS whatever output_key each step writes.
  // The same reference is reused for the whole loop so step writes accumulate.
  const sharedState: Record<string, unknown> = opts.sharedState ?? {};

  // Recover the DAG id stamped onto each runtime task's input_json (EDIT 2a).
  // Falls back to the runtime UUID when the stamp is absent (legacy rows /
  // direct test tasks) so the call is always safe.
  const dagIdOf = (task: Task): string => {
    if (!task.input_json) return task.id;
    try {
      const parsed = JSON.parse(task.input_json) as { dag_task_id?: unknown };
      return typeof parsed.dag_task_id === 'string' ? parsed.dag_task_id : task.id;
    } catch {
      return task.id;
    }
  };

  // Parse a completed task's output into a value usable by deterministic steps.
  // llm_call outputs are raw strings; we keep the raw string under state[dagId]
  // (so {state.t1} renders verbatim and print.ts's on-demand JSON descent still
  // works for {state.t1.field}). extract_json / transform consumers that need a
  // parsed object call their own parser. This mirrors print.ts:maybeParseJson
  // semantics WITHOUT pre-parsing, preserving F-LIVE-18 behaviour.
  const seedSharedStateFromCompleted = (): void => {
    for (const t of tasks) {
      if (t.status !== 'completed' || t.output_json === null || t.output_json === undefined) continue;
      // Completed-task output is refreshed under its DAG id every tick, so an
      // output_key collision with a deterministic-step write (author error) is
      // resolved in favour of the completed output.
      sharedState[dagIdOf(t)] = t.output_json;
    }
  };

  // Default executeTask wraps streaming events through opts.onEvent so cli_spawn
  // and llm_call (with stream_output=true) emit cli_tool_call /
  // task_streaming_chunk events live. Test-provided executeTaskFn keeps the
  // simpler (task, signal) shape — onEvent fires only via the default path.
  //
  // BRAIN-01 — sharedState + workflowId are now threaded so deterministic kinds
  // run against real upstream state. (The loop executeStep re-dispatch callback
  // is BRAIN-02 and is intentionally deferred; the loop case keeps the no-op
  // executeStep fallback in internal-utils.ts.)
  const dispatchDeterministic = (task: Task, signal?: AbortSignal): Promise<string> =>
    executeTask(task, {
      ...(signal !== undefined ? { signal } : {}),
      ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
      sharedState,
      workflowId: wfId,
      // Aurora-parity Wave 2 — db lets executeTask read remaining budget headroom
      // for the opt-in cost router (no-op unless OMNIFORGE_COST_ROUTER + a cap).
      db,
    });

  const doExecute = opts.executeTaskFn ?? dispatchDeterministic;
  const doSleep = opts.sleepFn ?? sleep;
  // MÉDIO-4 (revisão adversarial 2026-07-04): envolve o reviewer num span
  // context com ledgerSource='reviewer' para que o chokepoint LLM grave a
  // linha dele em model_calls (e abra trace spans llm_call:*). O run() do
  // AsyncLocalStorage aninha e restaura o contexto anterior ao retornar, então
  // o retry-loop do executor (que abre o próprio contexto SEM ledgerSource)
  // não é afetado — sem double-count por construção.
  const baseReview = opts.reviewFn ?? reviewTask;
  const doReview: typeof baseReview = (task, output, ctx) =>
    spanContextStorage.run(
      { db, parentSpanId: null, workflowId: wfId, ledgerSource: 'reviewer' },
      () => baseReview(task, output, ctx),
    );
  const refineCostPerCallUsd = opts.refineCostPerCallUsd ?? getRefineCostPerCallUsd();
  const refineTimeoutMs = opts.refineTimeoutMs ?? getMaxRefineTimeMs();
  const doHitl = opts.hitlFn ?? promptApproval;
  const forceHitlPrompt = opts.hitlFn !== undefined;
  const autoApprove = opts.autoApprove ?? false;
  const doBestCombo = opts.bestComboFn ?? bestComboForTask;
  const doOnEvent = opts.onEvent ?? (() => {});

  while (true) {
    await waitForWorkflowControlCheckpoint(db, wfId, {
      pollMs: opts.controlPollMs,
      sleep: doSleep,
    });

    const pending = tasks.filter((t) => t.status === 'pending');
    if (pending.length === 0) break;

    // BRAIN-01 — refresh sharedState with every completed upstream output
    // (keyed by DAG id) before scheduling this batch. Idempotent; runs each
    // tick so a task that completed in a prior batch is visible to a
    // deterministic step scheduled in this one.
    seedSharedStateFromCompleted();

    // Phase (a) — ready-candidate selection + workload ordering + file-scope
    // guard + parallelism cap (see selectReadyBatch above).
    const readyBatch = selectReadyBatch(
      db,
      wfId,
      pending,
      completedIds,
      opts.maxParallelTasks ?? getMaxParallelTasks(),
    );

    // Phase (b) — Bloco 1.5: auto-summary injection for fan-out upstreams.
    await injectFanoutAutoSummaries(db, tasks, readyBatch, wfId, ws, doExecute, doSleep);

    // Execute the entire batch in parallel; collect all outcomes before continuing
    await doOnEvent({
      type: 'batch_started',
      workflow_id: wfId,
      payload: { tasks: readyBatch.map((t) => t.name), total: tasks.length, completed: completedIds.size },
    });

    // FASE 1B Bloco A.2 — split batch by execution_mode.
    const ephemeralBatch = readyBatch.filter((t) => (t.execution_mode ?? 'ephemeral') === 'ephemeral');
    const adaptiveBatch = readyBatch.filter((t) => t.execution_mode === 'adaptive');

    // PARALLELISM NOTE (B6.2 audit, 2026-05-05):
    // Within a batch, all ephemeral tasks run concurrently via
    // Promise.allSettled. Operator caps the fan-out via
    // OMNIFORGE_MAX_PARALLEL_TASKS (default 0 = unlimited). The DAG topology
    // determines max concurrency — sequential chains (each task depends on
    // the previous) reduce to one ready task per iteration regardless of
    // this setting.
    //
    // Future opportunity (P2): "stream-fork" dispatch — when a task in the
    // current batch finishes early, immediately recompute the ready set and
    // launch newly-ready dependents WITHOUT waiting for the slowest task in
    // the batch. Today the loop waits for Promise.allSettled to resolve all
    // batch members before iterating, so a 60s task in a batch with a 5s
    // task delays the 5s task's dependents by 55s. Stream-fork would change
    //
    // Wave 3.D status: an adoption-ready scheduler module ships in
    // src/brain/executor/stream-fork-dispatcher.ts (with full unit
    // coverage in tests/unit/stream-fork-dispatcher.test.ts). Switching
    // this loop over to it is gated on a dedicated session that can run
    // end-to-end smokes against the live executor — the algorithm itself
    // is no longer the blocker.
    // this loop into a continuation-passing scheduler. Skipped for now —
    // out-of-scope refactor, current batched parallelism is "good enough"
    // for typical 5-15 task DAGs.
    //
    // Ephemeral path — wraps each task with start/complete/failed events
    // so live consumers (CLI printer, Telegram) can show per-task progress
    // without polling the DB. tasks (full workflow DAG) is forwarded so the
    // t0 plan-gate prompt can render the entire DAG for operator review
    // (H11 plan gate UX).
    const ephemeralResults = await Promise.allSettled(
      ephemeralBatch.map(async (task) => {
        const startMs = Date.now();
        await doOnEvent({
          type: 'task_started',
          workflow_id: wfId,
          payload: {
            task_name: task.name,
            kind: task.kind,
            model: task.model,
            completed: completedIds.size,
            total: tasks.length,
          },
        });
        try {
          await executeTaskWithRetry(db, task, wfId, ws, objective, doExecute, doSleep, doReview, refineCostPerCallUsd, refineTimeoutMs, doHitl, autoApprove, doBestCombo, tasks, workflowSpanId, forceHitlPrompt);
          await doOnEvent({
            type: 'task_completed',
            workflow_id: wfId,
            payload: {
              task_name: task.name,
              duration_ms: Date.now() - startMs,
              completed: completedIds.size + 1, // optimistic — incremented after Promise.allSettled
              total: tasks.length,
            },
          });
        } catch (err) {
          await doOnEvent({
            type: 'task_failed',
            workflow_id: wfId,
            payload: {
              task_name: task.name,
              error: err instanceof Error ? err.message : String(err),
              duration_ms: Date.now() - startMs,
              completed: completedIds.size,
              total: tasks.length,
            },
          });
          throw err;
        }
      }),
    );

    // Phase (d) — adaptive path: single supervisor call drives all adaptive
    // tasks in this batch, outcomes mapped to PromiseSettledResult (see
    // runAdaptiveBatch above).
    const adaptiveResults = await runAdaptiveBatch(db, adaptiveBatch, wfId, opts);

    // Combine results back into the readyBatch order so the existing
    // completedIds/failure logic continues to work.
    const results: PromiseSettledResult<void>[] = readyBatch.map((task) => {
      const ephIdx = ephemeralBatch.indexOf(task);
      if (ephIdx >= 0) return ephemeralResults[ephIdx]!;
      const adapIdx = adaptiveBatch.indexOf(task);
      return adaptiveResults[adapIdx]!;
    });

    // Add all successes to completedIds before checking for failures
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') completedIds.add(readyBatch[i].id);
    });

    // Respect next_step_id from routing tasks — skip pending tasks on
    // branches that were not selected by if_else / switch / evaluator.
    applyRoutingSkips(db, tasks, completedIds, wfId);

    const justCompleted = results
      .map((r, i) => (r.status === 'fulfilled' ? readyBatch[i]!.name : null))
      .filter((n): n is string => n !== null);
    await doOnEvent({
      type: 'batch_completed',
      workflow_id: wfId,
      payload: {
        completed_tasks: justCompleted,
        remaining: tasks.length - completedIds.size,
        total: tasks.length,
      },
    });

    const firstFailureIdx = results.findIndex((r) => r.status === 'rejected');
    if (firstFailureIdx !== -1) {
      const failedTask = readyBatch[firstFailureIdx];
      const cause = (results[firstFailureIdx] as PromiseRejectedResult).reason as Error;
      // Tier 0 Wave 3 (ITEM 0.2) — if the rejection came from a cancel
      // signal, the workflow status is already 'cancelled' (set by
      // requestWorkflowControl / broadcastCancelToWorkflow). Do NOT downgrade
      // it to 'failed' here, or the operator-visible state regresses.
      const isAbort = (cause as Error & { name?: string })?.name === 'AbortError'
        || /\bcancel(led|led)?\b/i.test(cause?.message ?? '')
        || /canceled by operator/i.test(cause?.message ?? '');
      if (!isAbort) {
        setWorkflowDone(db, wfId, 'failed');
      }
      const wrapped = new Error(
        isAbort
          ? `Task '${failedTask.name}' [${failedTask.id}] cancelled: ${cause.message}`
          : `Task '${failedTask.name}' [${failedTask.id}] falhou: ${cause.message}`,
      );
      wrapped.cause = cause;
      if (isAbort) (wrapped as Error & { name: string }).name = 'AbortError';
      throw wrapped;
    }
  }
}

export async function executeWorkflow(
  db: Database.Database,
  dag: Dag,
  workspace: string,
  objective = '',
  opts: ExecuteWorkflowOpts = {},
): Promise<Workflow> {
  const now = Date.now();
  const wfId = opts.pre_workflow_id ?? newWorkflowId();

  const idMap = new Map<string, string>();
  for (const dagTask of dag.tasks) {
    idMap.set(dagTask.id, newTaskId());
  }

  const workflow: Workflow = {
    id: wfId,
    workspace,
    objective,
    pattern_id: opts.pattern_id ?? null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: opts.max_total_cost_usd ?? null,
    max_duration_seconds: opts.max_duration_seconds ?? null,
    metadata: null,
  };
  // pre_workflow_id branch deferred until tasks are built so the whole insert
  // (workflow row + tasks) lands atomically — see db.transaction below.
  // safeEnsureWorkflowContext + startTraceSpan also deferred below because
  // their writes carry FK refs to workflows(id); they would fail with
  // "FOREIGN KEY constraint failed" if invoked before the workflow row is
  // visible.

  const workspaceProfile = loadWorkspaceProfile(workspace);
  const softwareTarget = workspaceProfile?.software_target ?? null;

  const tasks: Task[] = dag.tasks.map((dagTask) => ({
    id: idMap.get(dagTask.id)!,
    workflow_id: wfId,
    name: dagTask.name,
    kind: dagTask.kind,
    input_json: JSON.stringify({
      objective,
      task_name: dagTask.name,
      workspace,
      // BRAIN-01 — durable DAG-id stamp so deterministic step kinds can be
      // re-keyed to the {state.t1.*} contract the decomposer emits, on both
      // fresh runs and resume (loadWorkflowTasks preserves input_json).
      dag_task_id: dagTask.id,
      // Remap selector keys from DAG-level IDs to the final UUID task IDs
      ...(dagTask.input_selectors ? {
        input_selectors: Object.fromEntries(
          Object.entries(dagTask.input_selectors).map(([k, v]) => [idMap.get(k) ?? k, v]),
        ),
      } : {}),
      ...(dagTask.output_summary ? { output_summary: dagTask.output_summary } : {}),
      ...(dagTask.model_route ? { model_route: dagTask.model_route } : {}),
      ...(shouldInjectExecutionPlan(dagTask)
        ? { execution_plan: buildExecutionPlanInput(dag, idMap, dagTask.id) }
        : {}),
      ...(dagTask.tool_name ? { tool_name: dagTask.tool_name } : {}),
      ...(dagTask.args ? { args: dagTask.args } : {}),
      ...(dagTask.tool_policy ? { tool_policy: dagTask.tool_policy } : {}),
      // BRAIN-01 — persist deterministic step-kind config into input_json so
      // hydrateDeterministicArgsFromInputJson (internal-utils.ts) can restore
      // print_template / if_condition / loop_step_ids / input_keys / etc. on the
      // runtime Task (the Task interface + tasks table carry no dedicated
      // columns for these). Branch-id references (if/switch/evaluator targets,
      // loop bodies) are DAG ids in the source DAG; remap them to runtime UUIDs
      // so the applyRoutingSkips comparison (candidate.id === next_step_id) and
      // any id-based body lookup resolve against the materialised task rows.
      ...buildDeterministicStepConfig(dagTask, idMap),
      ...(dagTask.kind === 'cli_spawn'
        ? {
          execution_context: buildTaskExecutionContext({
            workspace,
            workflowId: wfId,
            taskId: idMap.get(dagTask.id)!,
          }, softwareTarget ? {
            project_root: softwareTarget.project_root,
            cwd: softwareTarget.cwd,
            base_ref: softwareTarget.base_ref,
          } : undefined),
        }
        : {}),
      ...(dagTask.estimated_cost_usd !== undefined
        ? { estimated_cost_usd: dagTask.estimated_cost_usd }
        : {}),
      // Aurora-parity Wave 0 (F-LIVE-5): persist read_only so emitBasicReviewOutcome
      // can skip the "changed no files" soft_failure grade for analysis cli_spawn tasks.
      ...(dagTask.read_only !== undefined ? { read_only: dagTask.read_only } : {}),
      // Aurora-parity Wave 0 (WS3): persist the per-task tool allowlist so the
      // tool_call executor can auto-deny out-of-scope tools.
      ...(dagTask.allowed_tools !== undefined ? { allowed_tools: dagTask.allowed_tools } : {}),
      // FASE C (Visual Reviewer) item 3 — the Task interface + tasks table
      // carry no dedicated columns for reviewer_profile/canvasRegionChecks/
      // interactionChecks (same "no dedicated column" situation as the
      // deterministic step-kind config above), so persist them into
      // input_json. The quality gate (runQualityGate) reads them back via
      // JSON.parse(task.input_json) when reviewer_profile === 'visual'.
      ...(dagTask.reviewer_profile ? { reviewer_profile: dagTask.reviewer_profile } : {}),
      ...(dagTask.canvasRegionChecks ? { canvasRegionChecks: dagTask.canvasRegionChecks } : {}),
      ...(dagTask.interactionChecks ? { interactionChecks: dagTask.interactionChecks } : {}),
    }),
    output_json: null,
    status: 'pending' as TaskStatus,
    depends_on: dagTask.depends_on.map((dep) => idMap.get(dep)!),
    executor_hint: dagTask.executor_hint ?? null,
    timeout_seconds: dagTask.timeout_seconds ?? 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: now,
    acceptance_criteria: dagTask.acceptance_criteria ?? null,
    refine_count: 0,
    max_refine: 2,
    refine_feedback: null,
    model: dagTask.model ?? null,
    model_route: dagTask.model_route,
    hitl: dagTask.hitl ?? false,
    tool_name: dagTask.tool_name ?? null,
    tool_policy: dagTask.tool_policy,
    workspace,
    // FASE C (Visual Reviewer) item 3/4 — materialise reviewer_profile onto
    // the in-memory Task too (mirrors execution_mode below) so same-process
    // consumers (the quality gate) can read task.reviewer_profile directly
    // without needing to re-parse input_json. Not persisted as its own DB
    // column — reload-from-DB paths still recover it from input_json.
    reviewer_profile: dagTask.reviewer_profile,
    // FASE 1B Bloco A.2 — materialise execution_mode; default to 'ephemeral' for back-compat.
    execution_mode: dagTask.execution_mode ?? 'ephemeral',
    file_scope: dagTask.file_scope,
  }));

  // Tier 0 — Wave 2 DB-A: workflow row + all task rows must be visible
  // together or not at all. A crash mid-loop previously left the workflow
  // committed but tasks missing (or partial), causing executeWorkflow's
  // resume path to deadlock on dependencies it can't see. db.transaction
  // wraps both the conditional workflow insert (skipped when caller
  // pre-created the row via plan_workflow → run_workflow) and the entire
  // task fan-out into a single atomic commit.
  db.transaction(() => {
    if (!opts.pre_workflow_id) insertWorkflow(db, workflow);
    for (const task of tasks) {
      insertTask(db, task);
    }
  })();

  // Post-transaction: writes that carry FK refs to workflows(id) must come
  // after the workflow row is visible. (Tier 0 — Wave 2 DB-A regression fix.)
  safeEnsureWorkflowContext(db, { workspace, runId: wfId, objective });

  let workflowSpanId: string | undefined;
  try {
    const wfSpan = startTraceSpan(db, {
      workflowId: wfId,
      name: 'workflow',
      kind: 'workflow',
      attributes: { objective, workspace },
    });
    workflowSpanId = wfSpan.id;
  } catch { /* tracing must not break execution */ }

  safeEnsureWorkflowWorkGraph(db, {
    workspace,
    runId: wfId,
    objective,
    tasks: tasks.map((task) => ({
      id: task.id,
      name: task.name,
      kind: task.kind,
      dependsOn: task.depends_on,
    })),
  });

  insertEvent(db, { workflow_id: wfId, type: 'workflow_started' });
  if (opts.onEvent) {
    await opts.onEvent({
      type: 'workflow_started',
      workflow_id: wfId,
      payload: { tasks: tasks.map((t) => t.name), total: tasks.length },
    });
  }

  // Cost guard is opt-in for this single-operator tool. The older fail-closed
  // behavior made local dogfooding fail before any task ran when Omniroute quota
  // was not configured.
  const quotaGuardMode = opts.quotaGuardMode ?? getQuotaGuardMode();
  if (tasks.length > 5 && quotaGuardMode !== 'off') {
    const doCheckQuota = opts.checkQuotaFn ?? checkQuota;
    const quotaResult = await doCheckQuota(workspace);
    if (!quotaResult.ok) {
      insertEvent(db, {
        workflow_id: wfId,
        type: 'workflow_quota_check_unavailable',
        payload: { guard_mode: quotaGuardMode, workspace, error: quotaResult.error ?? 'unknown' },
      });
    }
    if (quotaResult.data && !quotaResult.data.allowed) {
      insertEvent(db, {
        workflow_id: wfId,
        type: quotaGuardMode === 'enforce' ? 'workflow_quota_blocked' : 'workflow_quota_warning',
        payload: { remaining_pct: quotaResult.data.remaining_pct, guard_mode: quotaGuardMode, workspace },
      });
      if (quotaGuardMode === 'enforce') {
        setWorkflowDone(db, wfId, 'failed');
        throw new Error(
          `Workflow blocked: quota not allowed (${quotaResult.data.remaining_pct}% remaining)`,
        );
      }
    }
  }

  // Workflow-level wall-clock timeout. When max_duration_seconds is set, race
  // the entire task loop + validation + consolidation against a deadline. On
  // timeout the workflow is marked failed and a workflow_timeout event is
  // emitted; any task already in flight completes but no new tasks are picked up.
  const maxDurationSeconds = opts.max_duration_seconds ?? null;
  let workflowTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const coreExecution = async () => {
    await runTaskLoop(db, tasks, wfId, new Set<string>(), { ...opts, workspace, objective, workflowSpanId });
    // D35 — Final validation step. Runs AFTER tasks complete, BEFORE consolidator.
    await runFinalValidationStep(db, workflow, objective);
    // MÉDIO-4: ledgerSource='consolidator' → o chokepoint grava as chamadas
    // LLM do consolidator (incl. o MAP step de OPP-C1) em model_calls.
    await spanContextStorage.run(
      { db, parentSpanId: null, workflowId: wfId, ledgerSource: 'consolidator' },
      () => runConsolidation(db, workflow, tasks, opts.consolidateFn ?? consolidateWorkflow),
    );
    const finalQualityReviewMode = getFinalQualityReviewMode();
    if (finalQualityReviewMode !== 'off') {
      await enforceFinalQualityReview(db, {
        workflowId: wfId,
        mode: finalQualityReviewMode,
      });
    }
  };

  try {
    if (maxDurationSeconds !== null && maxDurationSeconds > 0) {
      const timeoutRejection = new Promise<never>((_, reject) => {
        workflowTimeoutHandle = setTimeout(() => {
          reject(new Error(`WORKFLOW_TIMEOUT:${maxDurationSeconds}`));
        }, maxDurationSeconds * 1000);
      });
      try {
        await Promise.race([coreExecution(), timeoutRejection]);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('WORKFLOW_TIMEOUT:')) {
          insertEvent(db, {
            workflow_id: wfId,
            type: 'workflow_timeout',
            payload: { max_duration_seconds: maxDurationSeconds },
          });
          setWorkflowDone(db, wfId, 'failed');
          if (workflowTimeoutHandle !== null) clearTimeout(workflowTimeoutHandle);
          throw new Error(`Workflow ${wfId} exceeded wall-clock limit of ${maxDurationSeconds}s (WORKFLOW_TIMEOUT)`);
        }
        throw err;
      } finally {
        if (workflowTimeoutHandle !== null) clearTimeout(workflowTimeoutHandle);
      }
    } else {
      await coreExecution();
    }
  } catch (err) {
    // WIRE-04 — any failure that throws out of the task loop / consolidation /
    // timeout race marks the workflow failed (already done at the throw site
    // via setWorkflowDone). Surface a single dashboard notification here, then
    // rethrow unchanged so the caller's error handling is untouched. Aborts
    // (operator cancel) are NOT a failure for notification purposes — the
    // workflow status is 'cancelled', not 'failed', so skip the bell.
    const isAbort = (err as Error & { name?: string })?.name === 'AbortError'
      || /\bcancel(?:l)?ed\b/i.test((err as Error)?.message ?? '')
      || /canceled by operator/i.test((err as Error)?.message ?? '');
    if (!isAbort) {
      fireWorkflowNotification(
        'failed',
        wfId,
        objective,
        err instanceof Error ? err.message : String(err),
      );

      // INTEL-05 — record a reflection on the FAILURE branch too. Failure
      // lessons (which task failed, where the plan was too vague) are the most
      // valuable for the decomposer's next attempt, yet were previously dropped
      // because recordReflection only ran on success. Fail-safe: never masks or
      // delays the rethrow of the original error. Reads tasks fresh from the DB
      // so per-task final statuses (failed / skipped) feed distillLessons.
      try {
        const failedTasksFinal = loadWorkflowTasks(db, wfId);
        recordReflection(
          db,
          { ...workflow, status: 'failed', completed_at: Date.now() },
          failedTasksFinal,
        );
      } catch (reflErr) {
        // No terminal workflow_completed event has been emitted on this branch,
        // so an audit event is safe to append.
        try {
          insertEvent(db, {
            workflow_id: wfId,
            type: 'workflow_reflection_record_error',
            payload: {
              outcome: 'failure',
              error: reflErr instanceof Error ? reflErr.message : String(reflErr),
            },
          });
        } catch {
          /* observability failure must not mask the original error rethrow */
        }
      }
    }
    // Release any in-process cost reservations for this terminated workflow so a
    // long-lived daemon never accumulates stale reservations across runs (BRAIN-04).
    clearWorkflowCostReservations(wfId);
    throw err;
  }

  const completedAt = Date.now();
  setWorkflowDone(db, wfId, 'completed');

  // Week 3 / Task 2.3 — pattern auto-capture hook. Runs BEFORE the
  // `workflow_completed` event so that audit-only side-effect events
  // don't end up after the canonical lifecycle terminator (which
  // existing tests assert is the last event for the workflow).
  try {
    runAutoCaptureHook(db, { ...workflow, status: 'completed', completed_at: completedAt });
  } catch (err) {
    // BRAIN-09 — no silent swallow. This runs BEFORE the terminal
    // workflow_completed event, so an audit event is safe to append here.
    insertEvent(db, {
      workflow_id: wfId,
      type: 'workflow_auto_capture_error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Week 4 / Task 3.2 — reflection recorder. Writes a distilled lessons
  // record so the decomposer can recall it on a future similar
  // objective. Fail-safe: never blocks workflow completion. Reads the
  // task list fresh from the DB so it picks up final status/refine_count
  // mutations from the run. Total cost is captured into the ledger later
  // (Bloco 3.1) — the recorder doesn't need it for recall, just lessons.
  try {
    const completedTasksFinal = loadWorkflowTasks(db, wfId);
    recordReflection(
      db,
      { ...workflow, status: 'completed', completed_at: completedAt },
      completedTasksFinal,
    );
  } catch (err) {
    // BRAIN-09 — no silent swallow. Runs before the terminal workflow_completed
    // event, so an audit event is safe here. recordReflection is itself
    // fail-safe (returns {ok:false}); this catch covers loadWorkflowTasks too.
    insertEvent(db, {
      workflow_id: wfId,
      type: 'workflow_reflection_record_error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  insertEvent(db, { workflow_id: wfId, type: 'workflow_completed' });
  if (opts.onEvent) {
    await opts.onEvent({
      type: 'workflow_completed',
      workflow_id: wfId,
      payload: { total: tasks.length },
    });
  }

  // WIRE-04 — surface a dashboard notification on successful completion.
  // Fail-safe: dispatched fire-and-forget so a notification-service failure
  // never blocks or masks the workflow result.
  fireWorkflowNotification('completed', wfId, objective);

  // W2 (2026-05-11): if this workflow has a parent (i.e. it's a
  // remediation child), flip the parent's status now that we resolved
  // successfully. Errors here MUST NOT mask the child's completion —
  // the helper is no-op when there's no parent and audit-logs all
  // failures into the events table.
  try {
    const completedWf = db
      .prepare(`SELECT parent_workflow_id FROM workflows WHERE id = ?`)
      .get(wfId) as { parent_workflow_id: string | null } | undefined;
    if (completedWf?.parent_workflow_id) {
      resolveParentAfterRemediation(db, completedWf.parent_workflow_id, wfId, 'completed');
    }
  } catch (err) {
    insertEvent(db, {
      workflow_id: wfId,
      type: 'workflow_remediation_resolve_error',
      payload: { error: err instanceof Error ? err.message : String(err) },
    });
  }

  // Bloco 3.1 — persist Omniroute cost report.
  const doCostReport = opts.costReportFn ?? costReport;
  const costResult = await doCostReport(wfId);
  if (costResult.ok && costResult.data && costResult.data.total_usd > 0) {
    try {
      db.prepare('UPDATE workflows SET total_cost_usd = ? WHERE id = ?').run(
        costResult.data.total_usd,
        wfId,
      );
    } catch (err) {
      // INTEL-05 — no silent swallow on the cost-sync path. This runs AFTER the
      // terminal workflow_completed event, so appending a workflow event would
      // break the "completed is the last event" invariant — log to stderr
      // (observable in the daemon log) instead. Fail-safe: never rethrows.
      process.stderr.write(
        `[cost-sync] workflow_cost_sync_error: failed to persist total_cost_usd for ${wfId}: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (workflowSpanId) {
    try {
      endTraceSpan(db, workflowSpanId, {
        status: 'ok',
        attributes: {
          task_count: tasks.length,
          duration_ms: completedAt - now,
          total_cost_usd: costResult.ok && costResult.data ? costResult.data.total_usd : null,
        },
      });
    } catch { /* tracing must not break execution */ }
  }

  // BRAIN-04 — workflow finished successfully; drop any residual cost
  // reservations for it (defensive: finalizeSuccess already releases per task).
  clearWorkflowCostReservations(wfId);

  return { ...workflow, status: 'completed', completed_at: completedAt };
}

export async function continueWorkflowExecution(
  db: Database.Database,
  workflow: Workflow,
  opts: ExecuteWorkflowOpts = {},
): Promise<Workflow> {
  safeEnsureWorkflowContext(db, {
    workspace: workflow.workspace,
    runId: workflow.id,
    objective: workflow.objective,
  });

  const tasks = loadWorkflowTasks(db, workflow.id).map((task) => {
    if (task.status === 'running') {
      setTaskPending(db, task.id);
      return { ...task, status: 'pending' as TaskStatus };
    }
    return task;
  });
  safeEnsureWorkflowWorkGraph(db, {
    workspace: workflow.workspace,
    runId: workflow.id,
    objective: workflow.objective,
    tasks: tasks.map((task) => ({
      id: task.id,
      name: task.name,
      kind: task.kind,
      dependsOn: task.depends_on,
    })),
  });

  insertEvent(db, { workflow_id: workflow.id, type: 'workflow_resumed' });

  // Treat 'completed', 'failed', and 'skipped' as satisfying deps so resume
  // can proceed after cost-cap skips / operator skip-failed-steps without
  // deadlock. ('failed' still blocks retry unless resume prep cleared it.)
  const completedIds = new Set(
    tasks
      .filter((t) =>
        t.status === 'completed' || t.status === 'failed' || t.status === 'skipped',
      )
      .map((t) => t.id),
  );

  await runTaskLoop(db, tasks, workflow.id, completedIds, { ...opts, workspace: workflow.workspace, objective: workflow.objective });

  const allTasksFinal = loadWorkflowTasks(db, workflow.id);
  const failedTasks = allTasksFinal.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    const completedAt = Date.now();
    insertEvent(db, {
      workflow_id: workflow.id,
      type: 'workflow_background_error',
      payload: {
        source: 'continue_workflow_execution',
        error: `Workflow still has ${failedTasks.length} failed task(s) after resume/retry; not marking completed.`,
        failed_task_ids: failedTasks.map((task) => task.id),
      },
    });
    setWorkflowDone(db, workflow.id, 'failed');

    // INTEL-05 — record a failure reflection on the resume failure branch too,
    // mirroring executeWorkflow. Fail-safe: never blocks the failed return.
    try {
      recordReflection(
        db,
        { ...workflow, status: 'failed', completed_at: completedAt },
        allTasksFinal,
      );
    } catch (reflErr) {
      // No terminal workflow_completed event on this branch — audit event safe.
      try {
        insertEvent(db, {
          workflow_id: workflow.id,
          type: 'workflow_reflection_record_error',
          payload: {
            outcome: 'failure',
            error: reflErr instanceof Error ? reflErr.message : String(reflErr),
          },
        });
      } catch {
        /* observability failure must not mask the failed return */
      }
    }

    // WIRE-04 — resume path failed to clear all failed tasks. Surface a
    // dashboard notification (fail-safe, fire-and-forget).
    fireWorkflowNotification(
      'failed',
      workflow.id,
      workflow.objective,
      `Workflow still has ${failedTasks.length} failed task(s) after resume/retry`,
    );

    // Sync costs to OmniRoute (non-blocking, runs in background).
    // INTEL-05 — no silent swallow. This failure branch has NOT emitted a
    // terminal workflow_completed event, so an audit event is safe to append.
    syncWorkflowCostsOnCompletion(db, workflow.id, 'failed').catch((err) => {
      try {
        insertEvent(db, {
          workflow_id: workflow.id,
          type: 'workflow_cost_sync_error',
          payload: { outcome: 'failed', error: err instanceof Error ? err.message : String(err) },
        });
      } catch (logErr) {
        process.stderr.write(
          `[cost-sync] workflow_cost_sync_error (failed branch) for ${workflow.id}: ` +
          `${logErr instanceof Error ? logErr.message : String(logErr)}\n`,
        );
      }
    });

    // BRAIN-04 — terminal failure on resume; drop residual reservations.
    clearWorkflowCostReservations(workflow.id);

    return { ...workflow, status: 'failed', completed_at: completedAt };
  }

  // D35 — same validation step as executeWorkflow
  await runFinalValidationStep(db, workflow, workflow.objective);

  // MÉDIO-4: mesmo wrap do caminho executeWorkflow — chamadas LLM do
  // consolidator no resume também ficam visíveis em model_calls.
  // (workflow.id ≡ wfId do outro site; esta função não tem um local wfId.)
  await spanContextStorage.run(
    { db, parentSpanId: null, workflowId: workflow.id, ledgerSource: 'consolidator' },
    () => runConsolidation(db, workflow, tasks, opts.consolidateFn ?? consolidateWorkflow),
  );

  const finalQualityReviewMode = getFinalQualityReviewMode();
  if (finalQualityReviewMode !== 'off') {
    await enforceFinalQualityReview(db, {
      workflowId: workflow.id,
      mode: finalQualityReviewMode,
    });
  }

  const completedAt = Date.now();
  setWorkflowDone(db, workflow.id, 'completed');
  insertEvent(db, { workflow_id: workflow.id, type: 'workflow_completed' });

  // WIRE-04 — resume path completed successfully. Surface a dashboard
  // notification (fail-safe, fire-and-forget).
  fireWorkflowNotification('completed', workflow.id, workflow.objective);

  // Sync costs to OmniRoute (non-blocking, runs in background).
  // INTEL-05 — no silent swallow. This runs AFTER the terminal
  // workflow_completed event was emitted above, so appending a workflow event
  // would break the "completed is the last event" invariant — log to stderr
  // (observable in the daemon log) instead. Fail-safe.
  syncWorkflowCostsOnCompletion(db, workflow.id, 'completed').catch((err) => {
    process.stderr.write(
      `[cost-sync] workflow_cost_sync_error (completed branch) for ${workflow.id}: ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
  });

  // BRAIN-04 — resume completed successfully; drop residual reservations.
  clearWorkflowCostReservations(workflow.id);

  return { ...workflow, status: 'completed', completed_at: completedAt };
}
