// FASE 1B Bloco A.2 — Adaptive supervisor loop.
//
// Drives a set of "adaptive" tasks through multi-turn execution with peer
// messaging (announce / steer / complete). The contract is in
// `adaptive-supervisor.types.ts`; consumers (orchestrate.ts) call the
// exported `runAdaptiveSupervisor` once per group of adaptive tasks.
//
// Design notes:
//   - Sequential per-iteration scan (not Promise.allSettled): each subagent
//     gets a turn before the next iteration starts. This keeps message
//     ordering deterministic and makes test assertions on call args possible.
//     Parallelism is a Bloco B problem; do not optimise prematurely.
//   - All persistence flows through the v2/subagent module helpers
//     (registry / outbox / control). No raw SQL here — the only DB write
//     this file does directly is `insertEvent` for observability.
//   - Errors NEVER fail the whole loop. A failing subagent is recorded as
//     an outcome and removed from the alive set; the supervisor keeps
//     going for the others.

import type Database from 'better-sqlite3';
import type { Task } from '../../types/index.js';
import type { SubagentOutcome } from '../../v2/subagent/types.js';
import type {
  AnnouncementPayload,
  CompletePayload,
} from '../../v2/subagent/messages.js';
import type {
  AdaptiveSupervisorOpts,
  AdaptiveSupervisorResult,
  ExecuteAdaptiveTurnFn,
  RunAdaptiveSupervisor,
  SubagentEvent,
} from './adaptive-supervisor.types.js';

import { spawnSubagent } from '../../v2/subagent/spawn.js';
import {
  markRunStarted,
  markRunComplete,
} from '../../v2/subagent/registry.js';
import { dequeueFor } from '../../v2/subagent/inbox.js';
import { enqueue } from '../../v2/subagent/outbox.js';
import {
  registerAbortController,
  unregisterAbortController,
} from '../../v2/subagent/control.js';
import { insertEvent, loadWorkflowById } from '../../db/persist.js';
import { withTimeout, sleep } from './internal-utils.js';
import { runOmniRouteTask } from '../../executors/omniroute.js';
import { safeParseJson } from '../../utils/safe-parse-json.js';
import { isAbortError } from './run-task/cancel.js';
import { loadWorkflowControlState } from '../../db/workflow-control.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default cap on supervisor iterations (W1 dogfood: 10 → 25). Hermes spec
 * quoted 90, but 25 strikes a balance between giving multi-turn workflows
 * room to converge and bounding worst-case cost. Operators can still tighten
 * or relax this via env (`OMNIFORGE_ADAPTIVE_MAX_ITERATIONS`), MCP tool
 * (`omniforge_set_config`), or `opts.adaptiveMaxIterations` → `opts.maxIterations`.
 * The convergence detector (CONVERGENCE_STREAK_THRESHOLD below) usually
 * short-circuits before this cap is reached.
 */
export const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Per-iteration timeout fallback (in ms) when the task does not declare one.
 * Mirrors DEFAULT_RUN_TIMEOUT_SECONDS from subagent/types.ts (300s).
 */
const FALLBACK_TIMEOUT_MS = 300_000;

/**
 * W1 convergence detector — if the supervisor does no useful work
 * (no completions, no alive-set delta) for this many consecutive iterations,
 * it emits `adaptive_supervisor_converged` and breaks out of the loop early.
 * 2 is deliberately small: a single empty iteration can happen during normal
 * CONTINUE-heavy phases, but two in a row is a strong signal the loop is
 * spinning without progress (LLM stuck, all subagents in pure-thinking turns,
 * etc.). Disabled when env `OMNIFORGE_ADAPTIVE_CONVERGENCE=false`.
 */
const CONVERGENCE_STREAK_THRESHOLD = 2;

/**
 * Reads the convergence feature flag from env. Defaults to enabled.
 * Inlined here rather than added to src/utils/config.ts because W1 scope
 * restricts edits to this file + the new test (`tests/unit/adaptive-supervisor-convergence.test.ts`).
 */
function isConvergenceDetectionEnabled(): boolean {
  const raw = (process.env['OMNIFORGE_ADAPTIVE_CONVERGENCE'] ?? 'true').trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off');
}

/**
 * BRAIN-03 — authoritative per-iteration cancel check for the supervisor loop.
 *
 * The per-turn AbortController registry (src/v2/subagent/control.ts) only
 * carries a controller WHILE a turn is in flight; a cancel that lands between
 * iterations would otherwise be lost and the loop would keep spawning costly
 * turns until maxIterations. We therefore consult the durable control state
 * (workflow_control_state) AND the workflows.status row each iteration. Either
 * a cancel_requested/canceled control row or a terminal 'cancelled' workflow
 * status means stop now.
 *
 * Read-only and fail-safe: any DB error is swallowed (returns false) so an
 * unrelated DB hiccup can never strand the loop — the existing maxIterations
 * cap remains the backstop.
 */
function isWorkflowCancelRequested(
  db: Database.Database,
  workflowId: string,
): boolean {
  try {
    const control = loadWorkflowControlState(db, workflowId);
    if (control && (control.state === 'cancel_requested' || control.state === 'canceled')) {
      return true;
    }
    const wf = loadWorkflowById(db, workflowId);
    if (wf && wf.status === 'cancelled') return true;
    return false;
  } catch (err) {
    // Cancel detection must never crash or stall the supervisor — fall back to
    // the maxIterations/convergence backstops. But do NOT swallow silently: a
    // transient SQLITE_BUSY here hides a cancel and burns LLM iterations
    // (surfaced by the Aurora dogfood). Record it for observability before the
    // fail-safe return. The insertEvent is itself guarded so an event-write
    // error can never re-break the "must never crash" contract.
    try {
      insertEvent(db, {
        workflow_id: workflowId,
        type: 'workflow_cancel_check_failed',
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch {
      /* even observability must not break the cancel-check fail-safe */
    }
    return false;
  }
}

// ─── Output protocol parser ───────────────────────────────────────────────────

/**
 * Markers a subagent can emit at the end of (or anywhere within) its
 * turn output to signal lifecycle to the supervisor.
 *
 *   [[SUBAGENT_COMPLETE]]\n<body>      → final output, body is result
 *   [[SUBAGENT_CONTINUE]]              → keep iterating, this turn's body is discarded
 *   [[SUBAGENT_ANNOUNCE topic="..." summary="..."]]
 *                                      → broadcast to peers; can appear
 *                                        multiple times per turn; stripped
 *                                        from output before complete/continue
 *                                        evaluation
 */
const COMPLETE_MARKER = '[[SUBAGENT_COMPLETE]]';
const CONTINUE_MARKER = '[[SUBAGENT_CONTINUE]]';

// Multiline; tolerant whitespace; double-quoted attributes only (matches
// how an LLM is most likely to emit them per the prompt template).
const ANNOUNCE_RE =
  /\[\[SUBAGENT_ANNOUNCE\s+topic="([^"]+)"\s+summary="([^"]+)"\]\]/g;

export interface ParsedSubagentSignal {
  announcements: AnnouncementPayload[];
  final: 'complete' | 'continue';
  result: string;
}

/**
 * Pure parser — extracts announcements first, then resolves complete/continue
 * on the residual text. No I/O. Exported for unit tests in the same suite.
 */
export function parseSubagentSignal(output: string): ParsedSubagentSignal {
  const announcements: AnnouncementPayload[] = [];

  // Strip every announce marker, accumulating payloads.
  const stripped = output.replace(ANNOUNCE_RE, (_match, topic: string, summary: string) => {
    announcements.push({ topic, summary });
    return '';
  });

  // CONTINUE wins over COMPLETE if both are present — the subagent is
  // explicitly asking for another turn; treat the body as transient.
  if (stripped.includes(CONTINUE_MARKER)) {
    return { announcements, final: 'continue', result: '' };
  }

  if (stripped.includes(COMPLETE_MARKER)) {
    // Body is everything after the LAST [[SUBAGENT_COMPLETE]] marker.
    // (LAST so a subagent can echo the marker name in mid-output for
    // documentation without confusing the parser.)
    const idx = stripped.lastIndexOf(COMPLETE_MARKER);
    let result = stripped.slice(idx + COMPLETE_MARKER.length);
    // Drop one optional leading newline so the canonical form
    // "[[SUBAGENT_COMPLETE]]\nfoo" yields "foo" not "\nfoo".
    if (result.startsWith('\n')) result = result.slice(1);
    return { announcements, final: 'complete', result: result.trim() };
  }

  // Default — no explicit marker, treat the residual text as the
  // completed result. Lets a single-turn subagent "just work".
  return { announcements, final: 'complete', result: stripped.trim() };
}

// ─── Default executor ─────────────────────────────────────────────────────────

/**
 * Production fall-through when opts.executeTurnFn is undefined.
 * Injects fenced peer messages into the task's input_json under
 * `peer_messages` so the prompt builder can include them alongside
 * upstream_artifacts. Does NOT mutate the caller's task object.
 *
 * M1-W1-B fix for F-REL-1: the `signal` parameter is now forwarded to
 * `runOmniRouteTask`, which threads it through `callOmnirouteWithUsage`
 * into the underlying fetch() — so a workflow cancel observed by the
 * supervisor aborts the in-flight LLM call within ~200ms instead of
 * waiting for the per-call server timeout (~300s). Without this, cancel
 * left cost-bleed up to the Omniroute deadline.
 */
async function defaultExecuteTurn(
  task: Task,
  fenced: string[],
  signal?: AbortSignal,
): Promise<string> {
  if (fenced.length === 0) {
    return runOmniRouteTask(task, signal !== undefined ? { signal } : {});
  }

  // The fenced peer-message injection used to swallow JSON parse failures
  // silently (only `process.stderr.write`); switch to the audited
  // safeParseJson helper so a malformed input_json shows up in the workflow
  // event timeline as `task_input_json_malformed`. We still proceed with
  // an empty ctx so the subagent gets the peer messages — preserving the
  // legacy fall-through semantics.
  //
  // No db/workflowId is available at this layer (the supervisor function
  // signature doesn't thread them through here), so the event emission is
  // skipped — safeParseJson degrades to a silent null in that case. The
  // run-task.ts call sites have full context and DO emit events.
  const ctx = safeParseJson<Record<string, unknown>>(task.input_json, {
    where: 'adaptive_supervisor.defaultExecuteTurn',
  }) ?? {};

  const taskWithMessages: Task = {
    ...task,
    input_json: JSON.stringify({
      ...ctx,
      peer_messages: fenced.join('\n'),
    }),
  };
  return runOmniRouteTask(taskWithMessages, signal !== undefined ? { signal } : {});
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Safely fire the observer hook. Errors thrown by the consumer must NOT
 * affect supervisor progress (the hook is best-effort observability).
 */
async function emitEvent(
  opts: AdaptiveSupervisorOpts,
  event: SubagentEvent,
): Promise<void> {
  if (opts.onSubagentEvent === undefined) return;
  try {
    await opts.onSubagentEvent(event);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[adaptive-supervisor] onSubagentEvent threw (swallowed): ${message}\n`,
    );
  }
}

/**
 * Persist a CompletePayload-shaped event AND emit to the observer.
 * Keeps the loop body terse.
 */
async function recordCompletion(
  db: Database.Database,
  opts: AdaptiveSupervisorOpts,
  taskId: string,
  runId: string,
  outcome: SubagentOutcome,
): Promise<void> {
  insertEvent(db, {
    workflow_id: opts.workflowId,
    task_id: taskId,
    type: 'subagent_completed',
    payload: { run_id: runId, status: outcome.status, error_msg: outcome.errorMsg ?? null },
  });

  const completePayload: CompletePayload = {
    status: outcome.status,
  };
  if (outcome.resultText !== undefined) completePayload.result_text = outcome.resultText;
  if (outcome.errorMsg !== undefined) completePayload.error_msg = outcome.errorMsg;

  await emitEvent(opts, {
    type: 'subagent_completed',
    runId,
    taskId,
    payload: completePayload,
  });
}

/**
 * Resolve the per-turn timeout for a task: prefer task.timeout_seconds when
 * positive, else fall back to FALLBACK_TIMEOUT_MS.
 */
function resolveTimeoutMs(task: Task): number {
  if (typeof task.timeout_seconds === 'number' && task.timeout_seconds > 0) {
    return task.timeout_seconds * 1000;
  }
  return FALLBACK_TIMEOUT_MS;
}

// ─── Phase 1 — spawn ──────────────────────────────────────────────────────────

interface SpawnPhaseResult {
  alive: Map<string, string>; // taskId → runId
  outcomes: Map<string, SubagentOutcome>;
}

async function runSpawnPhase(
  db: Database.Database,
  adaptiveTasks: Task[],
  opts: AdaptiveSupervisorOpts,
): Promise<SpawnPhaseResult> {
  const alive = new Map<string, string>();
  const outcomes = new Map<string, SubagentOutcome>();

  for (const task of adaptiveTasks) {
    const result = await spawnSubagent(
      db,
      {
        task: task.input_json ?? task.name,
        depth: 0,
        maxDepth: 3,
        // Pass through model only when defined — undefined would override null.
        ...(task.model != null ? { model: task.model } : {}),
        timeoutSeconds: task.timeout_seconds,
        cleanup: 'keep',
      },
      {
        parentTaskId: task.id,
        parentRunId: null,
        parentModel: task.model,
        workflowId: opts.workflowId,
      },
    );

    if (result.status !== 'accepted' || result.runId === undefined) {
      const errMsg = result.note ?? result.error ?? 'spawn rejected';
      outcomes.set(task.id, { status: 'error', errorMsg: errMsg });
      // Persist a synthetic spawn-failure event so observers can correlate.
      // task_id is NOT set on the events row because the FK to tasks(id) may
      // fail when the failure cause itself is a missing task row (FK violation
      // inside spawnSubagent → registerSubagentRun). The taskId is instead
      // included in the payload for downstream filtering.
      insertEvent(db, {
        workflow_id: opts.workflowId,
        task_id: null,
        type: 'subagent_spawn_failed',
        payload: { task_id: task.id, reason: errMsg, status: result.status },
      });
      // Surface as a 'subagent_completed' from the observer's POV, since
      // the task will never produce one through the normal loop path.
      await emitEvent(opts, {
        type: 'subagent_completed',
        runId: '',
        taskId: task.id,
        payload: { status: 'error', error_msg: errMsg },
      });
      continue;
    }

    const runId = result.runId;
    alive.set(task.id, runId);
    markRunStarted(db, runId);

    insertEvent(db, {
      workflow_id: opts.workflowId,
      task_id: task.id,
      type: 'subagent_spawned',
      payload: { run_id: runId },
    });

    await emitEvent(opts, {
      type: 'subagent_spawned',
      runId,
      taskId: task.id,
    });
  }

  return { alive, outcomes };
}

// ─── Phase 2 — supervisor loop ────────────────────────────────────────────────

interface IterationContext {
  db: Database.Database;
  opts: AdaptiveSupervisorOpts;
  doExecute: ExecuteAdaptiveTurnFn;
}

/**
 * Emit + persist an announcement broadcast originating from `taskId`.
 * Failures during enqueue are non-fatal — they are logged and surfaced
 * as an event, but the supervisor keeps going.
 */
async function broadcastAnnouncement(
  ctx: IterationContext,
  taskId: string,
  runId: string,
  announcement: AnnouncementPayload,
): Promise<void> {
  const { db, opts } = ctx;
  const enqueueResult = enqueue(db, {
    workflowId: opts.workflowId,
    fromTaskId: taskId,
    toTaskId: null,
    type: 'announcement',
    payload: announcement,
  });

  if (!enqueueResult.ok) {
    process.stderr.write(
      `[adaptive-supervisor] enqueue announcement failed for ${taskId}: ${enqueueResult.error}\n`,
    );
    insertEvent(db, {
      workflow_id: opts.workflowId,
      task_id: taskId,
      type: 'subagent_announce_failed',
      payload: { reason: enqueueResult.error, topic: announcement.topic },
    });
    return;
  }

  insertEvent(db, {
    workflow_id: opts.workflowId,
    task_id: taskId,
    type: 'subagent_announced',
    payload: {
      run_id: runId,
      topic: announcement.topic,
      summary: announcement.summary,
      message_id: enqueueResult.id,
    },
  });

  await emitEvent(opts, {
    type: 'subagent_announced',
    runId,
    taskId,
    payload: announcement,
  });
}

/**
 * Drive one alive task through a single turn. Updates `alive` and
 * `outcomes` in place. Never throws — all failures are converted into
 * outcome rows so the loop can continue with siblings.
 */
async function processOneTurn(
  ctx: IterationContext,
  task: Task,
  runId: string,
  alive: Map<string, string>,
  outcomes: Map<string, SubagentOutcome>,
): Promise<{ aborted: boolean }> {
  const { db, opts, doExecute } = ctx;

  // 1. Drain the inbox for this task.
  const messages = dequeueFor(db, task.id, opts.workflowId);
  const fenced = messages.map((m) => m.fenced);

  // 2. Wire up a per-call AbortController so kill()/steer() can interrupt.
  const ac = new AbortController();
  registerAbortController(task.id, ac);

  let output: string;
  try {
    output = await withTimeout(
      (timeoutSignal) => {
        // Forward the timeout abort onto the task's controller so the
        // executor sees a single signal regardless of which fired first.
        if (timeoutSignal.aborted) {
          ac.abort();
        } else {
          timeoutSignal.addEventListener('abort', () => ac.abort(), { once: true });
        }
        return doExecute(task, fenced, ac.signal);
      },
      resolveTimeoutMs(task),
      `adaptive-turn:${task.id}`,
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[adaptive-supervisor] turn failed for task ${task.id}: ${message}\n`,
    );

    // BRAIN-03: an AbortError means the turn was interrupted by a deliberate
    // cancel (broadcastCancelToWorkflow aborted this task's controller, or the
    // tool/LLM call observed the workflow-cancel signal). Record it as a
    // 'killed' outcome (the closest member of the closed SubagentOutcome union)
    // with a stable, non-data-bearing 'cancelled' message, and report the abort
    // so the loop can re-check workflow control state and stop the whole batch.
    // NOTE: kill()-driven aborts in the existing test throw a plain
    // Error('aborted') (name='Error', not 'AbortError'), so they DO NOT take
    // this branch — they remain an isolated 'error' and the loop continues for
    // siblings, preserving current per-task kill semantics.
    const isAbort = isAbortError(err);
    const isTimeout = !isAbort && /timed out after/i.test(message);
    const outcome: SubagentOutcome = isAbort
      ? { status: 'killed', errorMsg: `adaptive turn cancelled: ${message}` }
      : isTimeout
        ? { status: 'timeout', errorMsg: message }
        : { status: 'error', errorMsg: message };

    markRunComplete(db, runId, outcome);
    outcomes.set(task.id, outcome);
    alive.delete(task.id);
    await recordCompletion(db, opts, task.id, runId, outcome);
    return { aborted: isAbort };
  } finally {
    unregisterAbortController(task.id);
  }

  // 3. Parse the output for lifecycle markers.
  const parsed = parseSubagentSignal(output);

  // 4. Broadcast every announcement (sequentially so deliveries are ordered).
  for (const ann of parsed.announcements) {
    await broadcastAnnouncement(ctx, task.id, runId, ann);
  }

  // 5. Lifecycle resolution.
  if (parsed.final === 'continue') {
    // Subagent asked for another turn. No outcome write; the body is
    // discarded by design (it's the subagent's "scratchpad" turn).
    // R-MED-3 fix: emit a per-task event so the supervisor timeline isn't
    // a black box during many CONTINUE turns. Persist + observer hook.
    insertEvent(db, {
      workflow_id: ctx.opts.workflowId,
      task_id: task.id,
      type: 'subagent_continued',
      payload: {
        run_id: runId,
        announcements_emitted: parsed.announcements.length,
      },
    });
    return { aborted: false };
  }

  // final === 'complete'
  const outcome: SubagentOutcome = { status: 'ok', resultText: parsed.result };
  markRunComplete(db, runId, outcome);
  outcomes.set(task.id, outcome);
  alive.delete(task.id);
  await recordCompletion(db, opts, task.id, runId, outcome);
  return { aborted: false };
}

// ─── Public entry point ───────────────────────────────────────────────────────

export const runAdaptiveSupervisor: RunAdaptiveSupervisor = async (
  db,
  adaptiveTasks,
  opts,
): Promise<AdaptiveSupervisorResult> => {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const doExecute: ExecuteAdaptiveTurnFn = opts.executeTurnFn ?? defaultExecuteTurn;
  // Internal yield helper — tests can stub via a future opts.sleepFn,
  // but for now we route through the same `sleep` that orchestrate.ts uses.
  const doSleep = sleep;

  // ── Phase 1 ─────────────────────────────────────────────────────────────
  const { alive, outcomes } = await runSpawnPhase(db, adaptiveTasks, opts);

  const ctx: IterationContext = { db, opts, doExecute };

  // R-MED-6 fix: build a Map for O(1) task lookup inside the loop
  // (was O(N) Array.find per iteration per task → O(N²) per iteration).
  const taskById = new Map<string, Task>();
  for (const t of adaptiveTasks) taskById.set(t.id, t);

  // ── Phase 2 ─────────────────────────────────────────────────────────────
  const convergenceEnabled = isConvergenceDetectionEnabled();
  let noProgressStreak = 0;
  let iteration = 0;
  let cancelled = false;
  while (alive.size > 0 && iteration < maxIterations) {
    iteration += 1;

    // BRAIN-03: authoritative cancel checkpoint at the top of every iteration.
    // Catches a cancel that landed between turns (when no per-turn
    // AbortController was registered for broadcastCancelToWorkflow to abort).
    if (isWorkflowCancelRequested(db, opts.workflowId)) {
      cancelled = true;
      insertEvent(db, {
        workflow_id: opts.workflowId,
        type: 'supervisor_cancelled',
        payload: { iteration, alive: alive.size, reason: 'workflow_cancel_requested' },
      });
      break;
    }

    insertEvent(db, {
      workflow_id: opts.workflowId,
      type: 'supervisor_iteration',
      payload: { iteration, alive: alive.size },
    });
    await emitEvent(opts, {
      type: 'supervisor_iteration',
      iteration,
      alive: alive.size,
    });

    // W1 convergence: snapshot pre-iteration counters so we can detect
    // "no useful work was done this iteration". A productive iteration
    // either completes a task (alive.size shrinks, outcomes.size grows)
    // or — at minimum — keeps every subagent alive without stalling.
    const aliveSizeBefore = alive.size;
    const outcomesSizeBefore = outcomes.size;

    // Snapshot the alive set so we don't mutate-during-iteration; turns
    // that complete this round mutate `alive` in place but won't be re-tried.
    const aliveSnapshot = Array.from(alive.entries());
    for (const [taskId, runId] of aliveSnapshot) {
      const task = taskById.get(taskId);
      if (task === undefined) {
        // Defensive: task disappeared from input slice. Log + skip.
        process.stderr.write(
          `[adaptive-supervisor] alive task ${taskId} not in adaptiveTasks input; removing\n`,
        );
        alive.delete(taskId);
        continue;
      }
      const turn = await processOneTurn(ctx, task, runId, alive, outcomes);
      // BRAIN-03: an in-flight turn was aborted. Re-check the authoritative
      // control state; if the WHOLE workflow was cancelled, stop driving the
      // remaining siblings (their next turns would just burn tokens). A
      // single-task kill() is NOT a workflow cancel, so the loop continues.
      if (turn.aborted && isWorkflowCancelRequested(db, opts.workflowId)) {
        cancelled = true;
        insertEvent(db, {
          workflow_id: opts.workflowId,
          type: 'supervisor_cancelled',
          payload: { iteration, alive: alive.size, reason: 'turn_aborted_by_workflow_cancel' },
        });
        break;
      }
    }
    if (cancelled) break;

    // W1 convergence detector — break early when the supervisor has been
    // spinning without progress for CONVERGENCE_STREAK_THRESHOLD iterations.
    //
    // Scope: only active for genuine multi-agent coordination (alive.size ≥ 2
    // before AND after the iteration). A single subagent CONTINUEing on its
    // own is not "stuck" in the supervisor-coordination sense — it's just
    // slow — so we don't apply the heuristic in that case. This also keeps
    // backwards compatibility with single-task always-CONTINUE workflows
    // that legitimately rely on maxIterations as the upper bound.
    //
    // The "no useful work" signal is the spec's literal definition:
    //   tasksCompletedThisIter === 0  (no outcomes added)
    //   subagentsAliveDelta === 0     (alive set didn't shrink)
    if (
      convergenceEnabled &&
      aliveSizeBefore >= 2 &&
      alive.size >= 2
    ) {
      const subagentsAliveDelta = aliveSizeBefore - alive.size;
      const tasksCompletedThisIter = outcomes.size - outcomesSizeBefore;
      if (tasksCompletedThisIter === 0 && subagentsAliveDelta === 0) {
        noProgressStreak += 1;
      } else {
        noProgressStreak = 0;
      }

      if (noProgressStreak >= CONVERGENCE_STREAK_THRESHOLD) {
        insertEvent(db, {
          workflow_id: opts.workflowId,
          type: 'adaptive_supervisor_converged',
          payload: {
            iteration,
            alive: alive.size,
            streak: noProgressStreak,
            reason: 'no_progress',
          },
        });
        break;
      }
    } else {
      // Reset streak when the multi-agent precondition isn't met — keeps
      // the counter from carrying over between rounds with shifting alive
      // counts (e.g., shrunk to 1 mid-loop).
      noProgressStreak = 0;
    }

    // Yield between iterations so vitest fake timers / pending I/O can
    // advance and tests can assert intermediate state.
    await doSleep(0);
  }

  // ── Phase 3 — cleanup unfinished ────────────────────────────────────────
  if (alive.size > 0) {
    for (const [taskId, runId] of alive.entries()) {
      // BRAIN-03: when the loop broke because the workflow was cancelled, the
      // remaining alive tasks are 'killed' (cancelled), not timed-out — keep
      // the audit trail honest. Otherwise preserve the existing max-iterations
      // semantics (the max-iterations test asserts status==='timeout').
      const outcome: SubagentOutcome = cancelled
        ? { status: 'killed', errorMsg: 'supervisor stopped: workflow cancelled' }
        : { status: 'timeout', errorMsg: 'supervisor max iterations reached' };
      markRunComplete(db, runId, outcome);
      outcomes.set(taskId, outcome);
      await recordCompletion(db, opts, taskId, runId, outcome);
    }
    alive.clear();
  }

  return { outcomes, iterations: iteration };
};
