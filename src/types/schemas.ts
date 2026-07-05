import { z } from 'zod';

export const WorkflowStatusSchema = z.enum([
  'pending',
  'approved',
  'executing',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const TaskStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'completed',
  'waiting',
  'failed',
  'skipped',
  'cancelled',
]);

// D17 cleanup: removed 'eval' and 'consolidate' (redundant with reviewer/consolidator
// pipeline stages from D13/D16 — they were fossils from pre-planning) and 'http'
// (never implemented, no concrete use case). See BUGS-AND-SKIPS.md for rationale.
export const TaskKindSchema = z.enum([
  'llm_call',
  'cli_spawn',
  'pal_call',
  'tool_call',
  // Deterministic step kinds (no LLM, free + fast + predictable)
  'if_else',
  'switch',
  'extract_json',
  'print',
  'loop',
  'merge',
  'transform',
  // LLM-backed routing decision
  'evaluator',
]);

// FASE 1B Bloco A.2 — execution mode per task.
// 'ephemeral' (default) = V1/Tier 0 behaviour: task runs once via Promise.allSettled.
// 'adaptive'            = task spawns a subagent that lives in a supervisor loop
//                         until it declares complete, capable of receiving peer
//                         announcements and steer messages mid-execution.
// Workflows without an opinion get 'ephemeral' (full backwards compat).
// See docs/09-H2-ROADMAP-DETAILED.md sec FASE 1B Bloco A.3.
export const ExecutionModeSchema = z.enum(['ephemeral', 'adaptive']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

// FASE C (Visual Reviewer) item 2 — minimal structured schemas mirroring
// CanvasRegionCheck / InteractionCheck from
// src/quality/playwright-product-harness.ts. Kept intentionally loose on the
// "expect" / "region" unions (z.any() for the parts that are themselves
// unions of primitives+objects) rather than fully mirroring the TS type,
// but the REQUIRED fields (label/selector/waitMs) are validated so a
// malformed DAG task fails fast instead of silently producing a no-op check.
export const DagCanvasRegionCheckSchema = z.object({
  selector: z.string().min(1),
  region: z.union([
    z.enum(['top', 'bottom', 'left', 'right']),
    z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  ]),
  expectedHueRange: z.tuple([z.number(), z.number()]).optional(),
  expectedLuminanceAbove: z.number().optional(),
  label: z.string().min(1),
});

export const DagInteractionCheckSchema = z.object({
  label: z.string().min(1),
  key: z.string().optional(),
  clickSelector: z.string().optional(),
  waitMs: z.number().int().min(0),
  // `expect` is 'increase' | 'decrease' | { equals: unknown } — validated
  // loosely via z.any() here since `unknown` payloads defeat a tight union
  // anyway; the harness's own evaluateInteraction() fails closed at runtime
  // on anything malformed.
  domAssertion: z.object({
    selector: z.string().min(1),
    property: z.string().min(1),
    expect: z.any(),
  }).optional(),
  debugHookAssertion: z.object({
    path: z.string().min(1),
    expect: z.any(),
  }).optional(),
  screenshotBeforeAfter: z.boolean().optional(),
});

/** Declares expected DAG-level shared state shape (contract metadata). */
export const DagStateSchemaFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array', 'null', 'unknown']),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

export const WorkflowSchema = z.object({
  id: z.string(),
  workspace: z.string(),
  objective: z.string(),
  pattern_id: z.string().nullable(),
  status: WorkflowStatusSchema,
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  created_at: z.number(),
  created_by: z.string().nullable(),
  estimated_cost_usd: z.number().nullable(),
  actual_cost_usd: z.number().nullable(),
  /** When set, cumulative model-call spend + upcoming task estimate must stay within this USD cap. */
  max_total_cost_usd: z.number().nullable(),
  /** Wall-clock timeout for the entire workflow in seconds. null = no limit. */
  max_duration_seconds: z.number().int().min(60).max(86400).nullable(),
  metadata: z.string().nullable(),
});

/**
 * Shape returned by the decomposer LLM — a single task inside a generated DAG.
 * Intentionally leaner than the DB-level {@link TaskSchema}:
 * the decomposer emits only what the LLM can reasonably produce; the executor
 * layer (Bloco 2) fills the rest (status, timestamps, retry counters, etc.).
 */
export const DagTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: TaskKindSchema,
  depends_on: z.array(z.string()),
  // `nullish()` = string | null | undefined. LLMs often emit `null` for
  // "not provided" instead of omitting the key; both forms mean the same here.
  executor_hint: z.string().nullish(),
  acceptance_criteria: z.string().nullish(),
  // Optional per-task model override (e.g. "kimi-coding/kimi-k2.5-thinking").
  // When set, this task uses the specified model instead of TASK_MODEL env.
  model: z.string().nullish(),
  // Optional model routing constraints. Ignored when `model` is explicitly set.
  // Preserved in input_json so the Omniroute executor can route at execution time.
  model_route: z.object({
    use_case: z.string().optional(),
    provider: z.string().optional(),
    strategy: z.enum(['quality', 'cost', 'balanced']).optional(),
    required_capabilities: z.array(z.enum([
      'streaming',
      'structured_output',
      'tool_calling',
      'multimodal',
      'embeddings',
      'batch',
      'local',
    ])).optional(),
  }).optional(),
  // When true, executor pauses and prompts for human approval before running.
  hitl: z.boolean().optional(),
  // Per-task declaration of what to receive from each upstream task.
  // Key = upstream task id. Value: string[] = JSON field picks;
  // "summary_only" = first para / 500 chars; "raw_full" = V1 default.
  input_selectors: z.record(
    z.string(),
    z.union([z.array(z.string()), z.literal('summary_only'), z.literal('raw_full')]),
  ).optional(),
  // Human-readable hint of expected output shape (metadata only, not validated here).
  output_summary: z.string().nullish(),
  // Present when kind = 'tool_call'. Name of the tool to invoke from the tool registry.
  // nullish() because LLMs emit null for cli_spawn tasks (no tool needed).
  tool_name: z.string().nullish(),
  // Present when kind = 'tool_call'. Arguments are validated against the
  // selected tool's own Zod schema immediately before execution.
  args: z.record(z.string(), z.unknown()).optional(),
  // Optional per-task governance policy. Used by tool_call execution to
  // enforce allowed/denied/approval-required tools before side effects happen.
  tool_policy: z.unknown().optional(),
  // ── if_else fields ──────────────────────────────────────────────────────
  // Expression evaluated against sharedState (safe-eval, dot-notation ok).
  if_condition: z.string().optional(),
  if_true_step_id: z.string().optional(),
  if_false_step_id: z.string().optional(),

  // ── switch fields ────────────────────────────────────────────────────────
  // Expression evaluated against sharedState; result matched against case keys.
  switch_expression: z.string().optional(),
  // Map of case-key -> next_step_id (nullable = terminal/end).
  switch_cases: z.record(z.string(), z.string().nullable()).optional(),
  switch_default_step_id: z.string().nullable().optional(),

  // ── loop fields ──────────────────────────────────────────────────────────
  // Number of iterations (1–50). Body steps listed in loop_step_ids.
  loop_count: z.number().int().min(1).max(50).optional(),
  loop_step_ids: z.array(z.string()).optional(),

  // ── merge fields ─────────────────────────────────────────────────────────
  // Strategy for combining outputs from parallel branches.
  merge_strategy: z.enum(['list', 'concat', 'dict']).optional(),
  // sharedState keys of branches to merge.
  merge_branch_outputs: z.array(z.string()).optional(),

  // ── transform fields ─────────────────────────────────────────────────────
  // Arrow-style JS expression (≤2000 chars) evaluated against sharedState.
  transform_code: z.string().max(2000).optional(),

  // ── print fields ─────────────────────────────────────────────────────────
  // Template string with {state.key} or {state.key.nested} placeholders.
  print_template: z.string().max(8000).optional(),

  // ── evaluator fields ─────────────────────────────────────────────────────
  // Prompt sent to LLM; model selects one key from evaluator_route_map.
  evaluator_prompt: z.string().max(4000).optional(),
  // Map of decision-label -> next_step_id (nullable = terminal).
  evaluator_route_map: z.record(z.string(), z.string().nullable()).optional(),

  // ── shared control fields (used by multiple new kinds) ───────────────────
  // Describes expected sharedState shape (metadata, not validated at runtime).
  state_schema: z.record(z.string(), z.unknown()).optional(),
  // Keys to read from sharedState (used by extract_json, evaluator, transform).
  input_keys: z.array(z.string()).optional(),
  // Key to write result into sharedState (used by extract_json, print, merge, transform).
  output_key: z.string().optional(),

  // Per-task timeout override (seconds). Decomposer SHOULD set a value larger
  // than the 300s default when the task is large/slow (cli_spawn with >50KB
  // upstream context, multi-component synthesis, etc.). Clamped 60–1800s.
  // See docs/decisions.md D-H2.022 (timeout heuristics).
  timeout_seconds: z.number().int().min(60).max(1800).optional(),
  // OPP-R3 — per-domain reviewer profile selector. Pass-through here; the
  // reviewer dispatcher applies the actual scoring policy. Defaults to
  // 'strict' when omitted (existing behaviour).
  // FASE C (Visual Reviewer) — added 'visual': routes the task through the
  // deterministic Playwright harness checks (canvasRegionChecks /
  // interactionChecks) before any LLM-backed review is attempted.
  reviewer_profile: z.enum(['strict', 'lenient', 'creative', 'code', 'data', 'visual']).optional(),
  // FASE C (Visual Reviewer) item 2 — deterministic per-task visual checks,
  // consumed when reviewer_profile === 'visual'. Optional/aditive: DAGs
  // without these fields keep validating exactly as before.
  canvasRegionChecks: z.array(DagCanvasRegionCheckSchema).optional(),
  interactionChecks: z.array(DagInteractionCheckSchema).optional(),
  // FASE 1B Bloco A.2 — opt into adaptive supervisor loop.
  // Defaults to ephemeral when omitted (back-compat). Skill matcher may set
  // this from SKILL.md frontmatter.
  execution_mode: ExecutionModeSchema.optional(),
  // MC streaming opt-in (D-H2.026). Only meaningful when kind='llm_call' AND
  // a REPL or daemon /stream/llm consumer is listening for chunks. Decomposer
  // emits this when it expects long synthesis output and the user wants
  // live feedback. Default false (back-compat).
  stream_output: z.boolean().optional(),
  /** Optional per-task cost estimate (USD) for DAG-level cap checks before llm_call/cli_spawn. */
  estimated_cost_usd: z.number().nonnegative().optional(),
  // ── vault cross-task storage ──────────────────────────────────────────────
  // Paths (relative to workspace vault root) to read before task execution
  // and inject into the prompt under "=== VAULT INPUTS ===".
  vault_inputs: z.array(z.string()).optional(),
  // Paths to write after successful task execution.
  // source='result_text' writes the task result_text; source='file' writes
  // the content of the named file from the workspace.
  vault_outputs: z.array(z.object({
    path: z.string(),
    source: z.enum(['result_text', 'file']),
    file: z.string().optional(), // required when source='file'
  })).optional(),
  // Optional list of file paths (or glob patterns) this task reads/writes.
  // Used by the parallel scheduler to detect overlap between tasks that
  // would run concurrently — tasks with overlapping scopes are deferred
  // to the next tick unless an explicit depends_on already serialises them.
  // Adapted from Runfusion/Fusion (MIT) — scheduler.ts @ 5f6d998
  file_scope: z.array(z.string()).optional(),
  // Aurora-parity Wave 0 (F-LIVE-5): mark a cli_spawn task as read-only/analysis
  // (expected NOT to modify files). Suppresses the "produced output but changed
  // no files in its worktree" soft_failure grade. Default false.
  read_only: z.boolean().optional(),
  // Aurora-parity Wave 0 (WS3): per-task tool allowlist. When set, a tool_call
  // task may ONLY invoke these tool names — everything else is auto-denied. The
  // scoping substrate for unattended / sub-agent / constrained runs. Omit to
  // inherit all registered tools (default, no behaviour change).
  allowed_tools: z.array(z.string()).optional(),
});

export const DagSchema = z.object({
  tasks: z.array(DagTaskSchema).min(1),
  state_schema: z.record(z.string(), DagStateSchemaFieldSchema).optional(),
});

export const TaskSchema = z.object({
  id: z.string(),
  workflow_id: z.string(),
  name: z.string(),
  kind: TaskKindSchema,
  input_json: z.string().nullable(),
  output_json: z.string().nullable(),
  status: TaskStatusSchema,
  depends_on: z.array(z.string()),
  executor_hint: z.string().nullable(),
  timeout_seconds: z.number().int().default(300),
  max_retries: z.number().int().default(3),
  retry_count: z.number().int().default(0),
  retry_policy: z.string().default('exponential'),
  started_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  created_at: z.number(),
  acceptance_criteria: z.string().nullable(),
});
