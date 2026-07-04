import type { Task, Workflow, ReviewResult } from '../../types/index.js';
import type { ReviewerRuntimeContext } from '../../v2/reviewer/outcome.js';
import type { SelectorValue } from '../../v2/contracts/apply-selectors.js';
import type {
  BridgeResult,
  QuotaResult,
  CostReportResult,
  BestComboResult,
} from '../../v2/omniroute-bridge/index.js';
import type { QuotaGuardMode } from '../../utils/config.js';
import type {
  ExecuteAdaptiveTurnFn,
  SubagentEvent,
} from './adaptive-supervisor.types.js';
import type { OmniforgeEventType } from '../../runtime/event-types.js';

export class HitlModifyError extends Error {
  constructor(public readonly feedback: string) {
    super(`Plan modification requested: ${feedback}`);
    this.name = 'HitlModifyError';
  }
}

/**
 * Lifecycle event surface for live progress reporting.
 *
 *   workflow_started   payload: { tasks: string[], total: number }
 *   batch_started      payload: { tasks: string[], total: number, completed: number }
 *   task_started       payload: { task_name, kind, model, completed, total }
 *   task_completed     payload: { task_name, duration_ms, completed, total }
 *   task_failed        payload: { task_name, error, completed, total }
 *   batch_completed    payload: { completed_tasks: string[], remaining: number, total: number }
 *   workflow_completed payload: { total: number }
 *
 * Per-task events (task_started / task_completed / task_failed) were added
 * so CLI / Telegram clients can show live progress without polling the DB.
 */
export interface WorkflowProgressEvent {
  // F7-1 (2026-05-09): widened to OmniforgeEventType (closed registry in
  // src/runtime/event-types.ts) ∪ string for back-compat with the ~142
  // existing insertEvent call sites that have NOT yet been migrated to the
  // closed union. The fallback `string` will be removed in a follow-up sprint
  // once every emitter imports OmniforgeEventType.
  // Tracked: drop the `| string` fallback after call-site migration. Tier D
  // backlog item — see docs/notes/2026-05-12-master-goal-plan-all-tiers.md.
  type: OmniforgeEventType | (string & {});
  workflow_id: string;
  payload: Record<string, unknown>;
}

/**
 * Strongly-typed payloads for streaming events.
 * Consumers can narrow via `event.type === 'task_streaming_chunk'` and treat
 * `event.payload` as TaskStreamingChunkPayload. Schema not enforced here
 * because the executor's onEvent callback uses `Record<string, unknown>` for
 * back-compat with existing event types — narrow at the consumer.
 */
export interface TaskStreamingStartPayload {
  task_id: string;
  task_name: string;
  ts: number;
}

export interface TaskStreamingChunkPayload {
  task_id: string;
  task_name: string;
  chunk: string;
  cumulative_chars: number;
  seq: number;
}

export interface TaskStreamingEndPayload {
  task_id: string;
  task_name: string;
  total_chars: number;
  total_chunks: number;
  duration_ms: number;
  ttft_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  cost_usd?: number;
}

export interface CliToolCallPayload {
  task_id: string;
  tool_name: string;
  /** Compact JSON of input args; useful for live "Agent (Explore): ..." display. */
  input_summary: string;
}

export interface TaskLoopOpts {
  workspace?: string;
  objective?: string;
  workflowSpanId?: string;
  executeTaskFn?: (task: Task, signal?: AbortSignal) => Promise<string>;
  sleepFn?: (ms: number) => Promise<void>;
  reviewFn?: (task: Task, output: string, ctx?: ReviewerRuntimeContext) => Promise<ReviewResult>;
  refineCostPerCallUsd?: number;
  refineTimeoutMs?: number;
  // Receives a rich HitlPromptInfo so terminal/Telegram/Slack channels can
  // show name + kind + model + timeout + acceptance criteria. Tests may
  // pass a function whose body only reads .name (back-compat fine).
  hitlFn?: (info: import('../../hitl/cli.js').HitlPromptInfo) => Promise<'approve' | 'reject'>;
  autoApprove?: boolean;
  bestComboFn?: (taskKind: string, complexity: string) => Promise<BridgeResult<BestComboResult>>;
  onEvent?: (event: WorkflowProgressEvent) => void | Promise<void>;
  // FASE 1B Bloco A.2 — adaptive supervisor opts.
  // Passed through to runAdaptiveSupervisor for adaptive-mode tasks.
  adaptiveMaxIterations?: number;
  maxParallelTasks?: number;
  /** Poll interval while a workflow is cooperatively paused. */
  controlPollMs?: number;
  adaptiveExecuteTurnFn?: ExecuteAdaptiveTurnFn;
  onSubagentEvent?: (event: SubagentEvent) => void | Promise<void>;
  /**
   * BRAIN-01 — per-workflow shared state for deterministic step kinds
   * (if_else / switch / extract_json / print / loop / merge / transform /
   * evaluator). When omitted, runTaskLoop creates a fresh object and seeds it
   * from completed-task outputs keyed by DAG task id before each dispatch.
   * Exposed so unit/integration tests can inspect or pre-seed it.
   */
  sharedState?: Record<string, unknown>;
}

export type UpstreamResult = {
  content: string;
  slicedEvents: Array<{
    upstream_task_id: string;
    selector: SelectorValue;
    tokensBefore: number;
    tokensAfter: number;
  }>;
};

export interface ExecuteWorkflowOpts extends TaskLoopOpts {
  consolidateFn?: (workflow: Workflow, tasks: Task[]) => Promise<string>;
  pattern_id?: string;
  quotaGuardMode?: QuotaGuardMode;
  checkQuotaFn?: (workspace: string) => Promise<BridgeResult<QuotaResult>>;
  costReportFn?: (workflowId: string) => Promise<BridgeResult<CostReportResult>>;
  pre_workflow_id?: string; // caller pre-inserted the workflow record; skip insertWorkflow
  /** When non-null, cumulative model spend + per-task estimate must stay within this USD cap. */
  max_total_cost_usd?: number | null;
  /** Wall-clock limit for the entire workflow in seconds. null = no limit. */
  max_duration_seconds?: number | null;
  // Inherited from TaskLoopOpts: autoApprove?: boolean, bestComboFn
}
