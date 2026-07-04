import { setTimeout } from 'node:timers';
import type Database from 'better-sqlite3';
import type { Task, DagTask } from '../../types/index.js';
import { runOmniRouteTask, type RunOmnirouteOpts } from '../../executors/omniroute.js';
import {
  getCostRouterEnabled,
  getCostRouterEnforce,
  getCostRouterMinQuality,
} from '../../utils/config.js';
import { getRemainingBudgetHeadroomUsd } from '../../v2/budget/control.js';
import { runCliTask } from '../../executors/cli.js';
import { runAdvisorTask } from '../../executors/advisor.js';
import { runToolCallTask } from '../../executors/tool.js';
import type { WorkflowProgressEvent } from './types.js';
import { executeIfElse } from './step-executors/if_else.js';
import { executeSwitch } from './step-executors/switch.js';
import { executeTransform } from './step-executors/transform.js';
import { executeEvaluator } from './step-executors/evaluator.js';
import { executeExtractJson } from './step-executors/extract_json.js';
import { executePrint } from './step-executors/print.js';
import { executeLoop } from './step-executors/loop.js';
import { executeMerge } from './step-executors/merge.js';

/**
 * MC: opt-in onEvent for streaming-aware tasks (llm_call with stream_output=true,
 * cli_spawn that emits cli_tool_call events in realtime). Non-streaming kinds
 * ignore the callback. Always optional — back-compat with adaptive supervisor
 * and direct test invocations.
 */
export interface ExecuteTaskOpts {
  signal?: AbortSignal;
  onEvent?: (event: WorkflowProgressEvent) => void | Promise<void>;
  /** Shared mutable state for deterministic step kinds (if_else, switch, etc.). */
  sharedState?: Record<string, unknown>;
  /** Workflow ID — used by step executors to emit observability events. */
  workflowId?: string;
  /**
   * Workflow DB handle — threaded by the orchestrator so the opt-in cost router
   * can read the remaining budget headroom for an llm_call. Absent on test/
   * adaptive-direct paths, in which case cost routing simply no-ops.
   */
  db?: Database.Database;
  /**
   * Callback invoked by the loop executor for each body step per iteration.
   * In the full orchestration path this is wired to the DAG task runner;
   * when absent a no-op is used (loop metadata is still injected into sharedState).
   */
  executeStep?: (stepId: string, meta: { iteration: number; total: number; loopTaskId: string }) => void | Promise<void>;
}

/**
 * Apply session-level executor overrides (REPL `/model` picker writes these
 * to process.env; see src/repl/modal/ModelPickerModal.tsx). When the user
 * sets `TASK_EXECUTOR=cli:<slug>`, every `llm_call` task flowing through
 * executeTask is promoted to `cli_spawn` with that hint — the workflow DAG
 * shape is preserved but the task runs via the chosen CLI binary instead of
 * an Omniroute LLM route.
 *
 * Only `TASK_EXECUTOR` is wired today (covers the vast majority of DAG tasks).
 * `DECOMPOSER_EXECUTOR`, `REVIEWER_EXECUTOR`, `CONSOLIDATOR_EXECUTOR` are
 * accepted by the picker but not consumed yet — those meta-phases call LLM
 * paths directly, not via executeTask. Follow-up when dogfood proves we
 * actually want to run reviewer/consolidator as CLI.
 *
 * Precedence: explicit task.executor_hint (set by decomposer) wins over any
 * env override. Overrides only promote tasks that would otherwise go through
 * the Omniroute LLM path.
 */
export function applyExecutorOverride(task: Task): Task {
  // Decomposer-assigned hint is authoritative.
  if (task.executor_hint) return task;
  // Only the TASK lane has a consumer today.
  const override = process.env['TASK_EXECUTOR'];
  if (!override || !override.startsWith('cli:')) return task;
  // Only promote llm_call; leave pal_call / cli_spawn / tool_call alone.
  if (task.kind !== 'llm_call') return task;
  return { ...task, kind: 'cli_spawn', executor_hint: override };
}

/**
 * F-LIVE-1 hydrator — deterministic-kind tasks carry their config
 * (print_template, output_key, args, etc.) on the DAG JSON, but the
 * `tasks` DB schema only stores a small subset of columns. The remainder
 * is serialized into `input_json`. When the executor loads a task back
 * from the row, those fields are missing from the Task object — so
 * `executePrint(task)` sees `task.print_template === undefined` and
 * throws "print_template is required" even though the decomposer DID
 * emit it. Hydrate them back from input_json before dispatch.
 */
const DETERMINISTIC_KINDS = new Set<string>([
  'print', 'transform', 'extract_json', 'if_else', 'switch',
  'loop', 'merge', 'evaluator',
]);

function hydrateDeterministicArgsFromInputJson(task: Task): Task {
  // F-LIVE-1 — only deterministic-kind tasks need this. llm_call /
  // cli_spawn / tool_call / pal_call all carry their config either in
  // dedicated columns or in the existing input_json contract the
  // executors already understand. Wrapping every task in a fresh object
  // would break ref-based usage writeback in runOmniRouteTask.
  if (!DETERMINISTIC_KINDS.has(task.kind as string)) return task;
  if (!task.input_json) return task;
  let parsed: Record<string, unknown> | null = null;
  try {
    const raw = JSON.parse(task.input_json) as Record<string, unknown>;
    parsed = raw;
  } catch {
    return task;
  }
  if (!parsed) return task;

  // Decomposer emits these fields either at the top level of the task
  // (canonical) or nested under `args` (the shape Haiku/Sonnet tend to
  // produce mirroring tool_call). Accept both.
  const args = (parsed['args'] && typeof parsed['args'] === 'object' && !Array.isArray(parsed['args']))
    ? (parsed['args'] as Record<string, unknown>)
    : {};
  const hydrated: Record<string, unknown> = { ...task };
  // The list of fields we care about across the deterministic kinds.
  const FIELDS = [
    'print_template', 'output_key',
    'transform_code', 'transform_expression',
    'input_keys',
    'if_condition', 'if_true_step_id', 'if_false_step_id',
    'switch_expression', 'switch_key', 'switch_cases', 'switch_default_step_id',
    'loop_count', 'loop_step_ids',
    'merge_strategy', 'merge_branch_outputs',
    'evaluator_prompt', 'evaluator_route_map',
    'state_schema',
    'args',
  ];
  for (const field of FIELDS) {
    if (hydrated[field] !== undefined && hydrated[field] !== null) continue;
    // Top-level on input_json beats args nesting.
    if (parsed[field] !== undefined) hydrated[field] = parsed[field];
    else if (args[field] !== undefined) hydrated[field] = args[field];
  }
  return hydrated as unknown as Task;
}

// Aurora-parity Wave 2 — resolve opt-in cost-aware routing inputs for an
// llm_call. Double opt-in: returns {} (no routing → unchanged model selection)
// unless OMNIFORGE_COST_ROUTER is on AND a budget cap yields POSITIVE remaining
// headroom. We pass the headroom as the per-call budget so the router downshifts
// as a cap is approached; headroom ≤ 0 is left to the pre-dispatch hard guards.
function resolveCostRoutingOpts(
  task: Task,
  opts: ExecuteTaskOpts,
): Pick<RunOmnirouteOpts, 'budgetUsd' | 'minQuality' | 'enforceBudget' | 'workflowId' | 'taskId'> | Record<string, never> {
  if (!getCostRouterEnabled() || !opts.db || !opts.workflowId) return {};
  const headroom = getRemainingBudgetHeadroomUsd(opts.db, opts.workflowId);
  if (headroom === null || headroom <= 0) return {};
  // taskType is intentionally left unset → the router estimates with the
  // 'general' use-case (quality multiplier 1.0). The executor has no reliable
  // per-task use_case here; a future pass can derive it from model_route.
  return {
    budgetUsd: headroom,
    minQuality: getCostRouterMinQuality(),
    enforceBudget: getCostRouterEnforce(),
    workflowId: opts.workflowId,
    taskId: task.id,
  };
}

export async function executeTask(
  task: Task,
  signalOrOpts?: AbortSignal | ExecuteTaskOpts,
): Promise<string> {
  // Back-compat: callers passing a plain AbortSignal still work.
  const opts: ExecuteTaskOpts = signalOrOpts instanceof AbortSignal
    ? { signal: signalOrOpts }
    : (signalOrOpts ?? {});

  // F-LIVE-1 — restore print_template / args / output_key from input_json
  // before any deterministic-kind dispatcher reads them. Cheap (single
  // JSON.parse per task) and idempotent.
  const hydrated = hydrateDeterministicArgsFromInputJson(task);
  const effective = applyExecutorOverride(hydrated);

  switch (effective.kind) {
    case 'llm_call':
      return runOmniRouteTask(effective, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
        ...resolveCostRoutingOpts(effective, opts),
      });
    case 'cli_spawn':
      return runCliTask(effective, opts.signal, {
        ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
      });
    case 'pal_call': {
      // AETHER ε.4 (2026-05-01) — pal_call is fully ported to native advisors.
      // The PAL stdio fallback was removed once chat / listmodels / version
      // landed alongside the previously-ported 15. Catalog is now:
      //   analyze, apilookup, challenge, chat, clink, codereview, consensus,
      //   debug, docgen, listmodels, planner, precommit, refactor, secaudit,
      //   testgen, thinkdeep, tracer, version  (18/18 PAL tool parity).
      //
      // Routing:
      //   "advisor:<name>" → runAdvisorTask (preferred form for new DAGs)
      //   "pal:<name>"     → remap to "advisor:<name>" for back-compat with
      //                      legacy patterns + decomposer prompt (old hint
      //                      shape is still valid; a deprecation pass can
      //                      retire it once dogfood confirms zero usage).
      const hint = effective.executor_hint ?? '';
      if (hint.startsWith('advisor:')) {
        return runAdvisorTask(effective, opts.signal);
      }
      if (hint.startsWith('pal:')) {
        const remapped: Task = {
          ...effective,
          executor_hint: `advisor:${hint.slice('pal:'.length)}`,
        };
        return runAdvisorTask(remapped, opts.signal);
      }
      // Unhinted pal_call — default to chat, the closest PAL parity for a
      // bare LLM request. Any task that needs a more specific advisor must
      // declare it via executor_hint.
      const defaulted: Task = {
        ...effective,
        executor_hint: 'advisor:chat',
      };
      return runAdvisorTask(defaulted, opts.signal);
    }
    case 'tool_call':
      return runToolCallTask(effective, opts.signal);

    // ── Deterministic step kinds (no CLI spawn) ──────────────────────────────
    // sharedState is thread-local to the calling runTaskLoop iteration; callers
    // that use executeTask directly (tests, adaptive supervisor) must pass it
    // via opts.sharedState. When absent a fresh empty object is used so that
    // the call is always safe (step executors mutate the provided object).
    case 'if_else': {
      const state = opts.sharedState ?? {};
      const ctx = { workflowId: opts.workflowId ?? '' };
      type IfElseTask = Task & { if_condition?: string; if_true_step_id?: string; if_false_step_id?: string };
      const result = await executeIfElse(effective as unknown as IfElseTask, state, ctx);
      return JSON.stringify(result);
    }
    case 'switch': {
      const state = opts.sharedState ?? {};
      const result = await executeSwitch(effective as unknown as DagTask, state);
      return JSON.stringify(result);
    }
    case 'extract_json': {
      const state = opts.sharedState ?? {};
      const dagTask = effective as unknown as DagTask;
      executeExtractJson(dagTask, state);
      return JSON.stringify({ ok: true, output_key: dagTask.output_key ?? null });
    }
    case 'print': {
      const state = opts.sharedState ?? {};
      const dagTask = effective as unknown as DagTask;
      executePrint(dagTask, state);
      // F-LIVE-17 — return the rendered string as the task's output so the
      // reviewer (and any downstream consumer that reads task.output_json)
      // can see the actual rendered text, not just a metadata wrapper.
      // The rendered string also stays in sharedState[output_key] for
      // upstream-selector consumers — both consumers are satisfied.
      const outKey = (dagTask.output_key
        ?? ((dagTask as unknown as { args?: { output_key?: string } }).args?.output_key))
        ?? null;
      const rendered = outKey ? state[outKey] : undefined;
      if (typeof rendered === 'string') return rendered;
      return JSON.stringify({ ok: true, output_key: outKey, rendered: rendered ?? null });
    }
    case 'loop': {
      const state = opts.sharedState ?? {};
      const executeStep = opts.executeStep ?? (async () => { /* no-op: body steps run via DAG */ });
      const result = await executeLoop(effective as unknown as DagTask, state, { executeStep });
      return JSON.stringify(result);
    }
    case 'merge': {
      const state = opts.sharedState ?? {};
      const dagTask = effective as unknown as DagTask;
      executeMerge(dagTask, state);
      return JSON.stringify({ ok: true, output_key: dagTask.output_key ?? null });
    }
    case 'transform': {
      const state = opts.sharedState ?? {};
      const dagTask = effective as unknown as DagTask;
      executeTransform(dagTask, state);
      return JSON.stringify({ ok: true, output_key: dagTask.output_key ?? null });
    }
    case 'evaluator': {
      const state = opts.sharedState ?? {};
      const ctx = { workflowId: opts.workflowId ?? '' };
      const result = await executeEvaluator(effective as unknown as DagTask, state, ctx);
      return JSON.stringify(result);
    }

    default: {
      const _exhaustive: never = effective.kind as never;
      throw new Error(`executeTask: unhandled kind '${String(_exhaustive)}'`);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Races a factory-created promise against a deadline. ms <= 0 = no timeout.
// On timeout: aborts the signal, then rejects with a clear error message.
export function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (ms <= 0) return factory(new AbortController().signal);

  return new Promise<T>((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      reject(new Error(`Task '${label}' timed out after ${ms}ms`));
    }, ms);

    factory(ac.signal).then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err: unknown) => { clearTimeout(timer); reject(err as Error); },
    );
  });
}

// Returns the delay in ms before the Nth retry (attempt=1 means first retry).
export function retryDelayMs(policy: string, attempt: number): number {
  if (policy.startsWith('fixed:')) {
    const ms = parseInt(policy.slice(6), 10);
    return isNaN(ms) ? 1000 : ms;
  }
  // exponential (default for any unrecognised policy)
  return Math.min(Math.pow(2, attempt - 1) * 1000, 30_000);
}
