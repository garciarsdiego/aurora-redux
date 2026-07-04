import type { z } from 'zod';
import type { DagSchema, DagTaskSchema } from './schemas.js';

export type WorkspaceName = string;

/** Task shape emitted by the decomposer (leaner than DB-level {@link Task}). */
export type DagTask = z.infer<typeof DagTaskSchema>;
/** DAG shape returned by the decomposer — just a list of tasks for now. */
export type Dag = z.infer<typeof DagSchema>;

export type WorkflowStatus =
  | 'pending'
  | 'approved'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  // W2 (2026-05-11): parent workflow status while a remediation child
  // is awaiting operator approval or executing fix tasks. Transitions to
  // 'completed' when the child resolves OK, or 'failed' on child failure.
  | 'awaiting_remediation';

export type TaskStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'waiting'
  | 'failed'
  | 'skipped'
  | 'cancelled';

// Kept in sync with TaskKindSchema in schemas.ts.
// Reviewer (D13) and consolidator (D16) are pipeline stages, not task kinds —
// do not re-add 'eval' or 'consolidate' here.
export type TaskKind =
  | 'llm_call'
  | 'cli_spawn'
  | 'pal_call'
  | 'tool_call'
  // Deterministic step kinds (no LLM)
  | 'if_else'
  | 'switch'
  | 'extract_json'
  | 'print'
  | 'loop'
  | 'merge'
  | 'transform'
  // LLM-backed routing
  | 'evaluator';

export interface Workflow {
  id: string;
  workspace: WorkspaceName;
  objective: string;
  pattern_id: string | null;
  status: WorkflowStatus;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  created_by: string | null;
  estimated_cost_usd: number | null;
  actual_cost_usd: number | null;
  max_total_cost_usd: number | null;
  max_duration_seconds: number | null;
  metadata: string | null;
}

export interface Review {
  id: string;
  task_id: string;
  workflow_id: string;
  reviewer_model: string;
  criteria: string | null;
  score: number;
  feedback: string | null;
  passed: number; // SQLite stores booleans as 0/1
  created_at: number;
}

export interface ReviewResult {
  score: number;
  feedback: string;
  passed: boolean;
}

export type ArtifactKind = 'json' | 'yaml' | 'markdown' | 'text' | 'binary';

export interface BudgetThresholdEvent {
  threshold_pct: number;
  used: number;
  cap: number;
}

export interface Pattern {
  id: string;
  workspace: string;
  name: string;
  source: string; // 'generated' | 'imported' | 'auto-captured'
  objective_sample: string;
  dag_json: string;
  usage_count: number;
  success_count: number;
  avg_duration_ms: number | null;
  last_used_at: number | null;
  created_at: number;
  /** Week 3 / Task 2.3 — normalized objective for fuzzy match. Nullable so
   *  legacy rows pre-migration-054 still load. */
  objective_shape?: string | null;
  /** Week 3 / Task 2.4 — objective with `{slot}` placeholders extracted
   *  from multiple matching runs. Populated by detectSlots. */
  template_objective?: string | null;
  /** Week 3 / Task 2.4 — JSON array of slot names found in template_objective. */
  slots_json?: string | null;
}

export interface Artifact {
  id: string;
  workflow_id: string;
  task_id: string | null;
  workspace: string;
  kind: ArtifactKind;
  content_path: string | null;
  content_inline: string | null;
  size_bytes: number;
  hash_sha256: string;
  created_at: number;
}

export interface CostSummary {
  workflow_id: string;
  call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  first_call_at: number | null;
  last_call_at: number | null;
}

export interface CostByTask {
  workflow_id: string;
  task_id: string | null;
  task_name: string | null;
  call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  first_call_at: number | null;
  last_call_at: number | null;
}

export interface CostByModel {
  workflow_id: string;
  model: string;
  provider: string | null;
  call_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  first_call_at: number | null;
  last_call_at: number | null;
}

export interface DashboardRunCostResponse {
  summary: CostSummary;
  byTask: CostByTask[];
  byModel: CostByModel[];
  cap: number | null;
  currency: 'USD';
  generated_at: string;
}

export type ExecutionMode = 'ephemeral' | 'adaptive';

/**
 * OPP-R3 — per-domain reviewer profile. The reviewer dispatcher uses this to
 * pick a scoring policy variant tuned to the task's domain (e.g. 'code' is
 * stricter on exit-code/regex shapes; 'creative' tolerates ambiguity).
 * Optional everywhere; default profile is 'strict'.
 */
export type ReviewerProfile = 'strict' | 'lenient' | 'creative' | 'code' | 'data';

export interface Task {
  id: string;
  workflow_id: string;
  name: string;
  kind: TaskKind;
  input_json: string | null;
  output_json: string | null;
  status: TaskStatus;
  depends_on: string[];
  executor_hint: string | null;
  timeout_seconds: number;
  max_retries: number;
  retry_count: number;
  retry_policy: string;
  started_at: number | null;
  completed_at: number | null;
  created_at: number;
  acceptance_criteria: string | null;
  refine_count: number;
  max_refine: number;
  refine_feedback: string | null;
  model: string | null;
  hitl: boolean;
  // FASE 1B Bloco A.2 — execution mode. 'ephemeral' uses V1/Tier 0 path;
  // 'adaptive' routes through the supervisor loop (`adaptive-supervisor.ts`).
  // Defaults to 'ephemeral' when missing (back-compat).
  execution_mode?: ExecutionMode;
  // OPP-R3 — optional per-domain reviewer profile (pass-through from DAG).
  reviewer_profile?: ReviewerProfile;
  // FASE 1B Bloco A.1 — persisted steering instruction for the next
  // adaptive retry/turn. Cleared by the executor when the task restarts.
  steer_instruction?: string | null;
  // Runtime-only: present when kind = 'tool_call'. Not persisted in DB.
  tool_name?: string | null;
  // Runtime-only: executor context for sandboxed tools. Not persisted in DB.
  workspace?: string;
  // Runtime-only: per-task governance policy preserved in input_json.
  tool_policy?: unknown;
  // Set by Bloco 3.1 fallback consumer after best_combo_for_task resolves.
  model_used?: string | null;
  model_route?: unknown;
  // Runtime/DB-backed LLM usage fields. When Omniroute returns usage, the
  // executor persists these to tasks and model_calls for cost inspection.
  input_tokens?: number | null;
  output_tokens?: number | null;
  llm_call_cost_usd?: number | null;
  llm_call_latency_ms?: number | null;
  // MC streaming opt-in (D-H2.026). When true and kind === 'llm_call',
  // runOmniRouteTask streams via callOmnirouteStream, emits
  // task_streaming_chunk events for each delta, and accumulates the full text
  // into output_json at the end (so reviewer/consolidator see the complete
  // string just like in non-stream mode). Default false — non-stream callers
  // (decomposer/reviewer/consolidator) MUST keep stream off.
  stream_output?: boolean;
  // Optional list of file paths (or glob patterns) this task reads/writes.
  // Used by the parallel scheduler to detect overlap and defer conflicting
  // concurrent tasks. Adapted from Runfusion/Fusion (MIT) — 5f6d998.
  file_scope?: string[];
  // Aurora-parity Wave 2 — pin/freeze. When true AND output_json is set, a
  // re-run reuses the stored output instead of re-executing (zero model spend).
  // Persisted as INTEGER (migration 060); mapped to boolean on load.
  output_pinned?: boolean;
}

export interface TaskHungEvent {
  type: 'task_hung';
  task_id: string;
  payload: {
    age_ms: number;
    last_heartbeat_at: number;
  };
}
