// FASE 1B Bloco A.2 — public surface of the adaptive supervisor loop.
// Kept in a separate file so consumers (orchestrate.ts) can import the
// signature without dragging in the implementation when they don't need it.

import type Database from 'better-sqlite3';
import type { Task, ReviewResult } from '../../types/index.js';
import type { ReviewerRuntimeContext } from '../../v2/reviewer/outcome.js';
import type { SubagentOutcome } from '../../v2/subagent/types.js';
import type {
  AnnouncementPayload,
  SteerPayload,
  CompletePayload,
} from '../../v2/subagent/messages.js';

/**
 * Event surface emitted by the supervisor loop. Mirrors the lifecycle hooks
 * required by the spec (`docs/09-H2-ROADMAP-DETAILED.md sec FASE 1B Bloco A.2`):
 * subagent_spawned, subagent_announced, subagent_steered, subagent_completed,
 * plus iteration progress for observability.
 */
export type SubagentEvent =
  | { type: 'subagent_spawned'; runId: string; taskId: string }
  | { type: 'subagent_announced'; runId: string; taskId: string; payload: AnnouncementPayload }
  | { type: 'subagent_steered'; runId: string; taskId: string; payload: SteerPayload }
  | { type: 'subagent_completed'; runId: string; taskId: string; payload: CompletePayload }
  | { type: 'supervisor_iteration'; iteration: number; alive: number };

/**
 * Per-iteration executor — caller-provided so tests can stub the LLM call.
 * Receives `task` (with input_json mutated to include the fenced messages
 * accumulated so far) and returns the LLM's output for that iteration.
 *
 * The supervisor parses the output for SubagentSignal markers (see
 * `parseSubagentSignal` in adaptive-supervisor.ts).
 */
export type ExecuteAdaptiveTurnFn = (
  task: Task,
  fencedMessages: string[],
  signal?: AbortSignal,
) => Promise<string>;

export interface AdaptiveSupervisorOpts {
  workflowId: string;
  workspace: string;
  /** Defaults to 10 (conservative — V1 of Bloco A.2). Hermes uses 90. */
  maxIterations?: number;
  /** Stub the per-turn execution (tests). Production calls `runOmniRouteTask`. */
  executeTurnFn?: ExecuteAdaptiveTurnFn;
  /**
   * Stub the post-completion review hook (tests). Defaults to noop.
   * NOT IMPLEMENTED: declared for the planned post-completion review pass but
   * currently never consumed by `runAdaptiveSupervisor` — kept on the exported
   * interface for API stability; passing it today has no effect.
   */
  reviewFn?: (task: Task, output: string, ctx?: ReviewerRuntimeContext) => Promise<ReviewResult>;
  /** Per-event observability hook. Errors are swallowed inside the loop. */
  onSubagentEvent?: (event: SubagentEvent) => void | Promise<void>;
}

/**
 * Result map: per task id, the final outcome the supervisor settled on.
 * `iterations` is the actual loop count (≤ maxIterations).
 */
export interface AdaptiveSupervisorResult {
  outcomes: Map<string, SubagentOutcome>;
  iterations: number;
}

export type RunAdaptiveSupervisor = (
  db: Database.Database,
  adaptiveTasks: Task[],
  opts: AdaptiveSupervisorOpts,
) => Promise<AdaptiveSupervisorResult>;
