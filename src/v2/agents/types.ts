/**
 * Agent persona framework — the contract every stage in Omniforge implements.
 *
 * This file is the runtime spine for the RFC at
 * `docs/notes/2026-05-04-omniforge-agents-spec.md`. Every agent (Decomposer,
 * Refiner, Worker.cli_spawn, …) exports an `AgentPersona<I, O>` value that the
 * generic runner in `runner.ts` consumes.
 *
 * Keep this module zero-dependency on agent-specific code — only the Zod core
 * and shared low-level utilities. Personas pull their schemas from
 * `src/types/schemas.ts` and compose them here.
 */

import type { z } from 'zod';

import type { TransitionContext } from './transition-context.js';
import type { PersonaPermissions } from './permissions.js';

// ─────────────────────────────────────────────────────────────────────────────
// Stable agent identifiers — the only IDs the rest of the system may persist.
// New agents must register here so the failover/observability code can pattern
// match by id without stringly-typed bugs.
// ─────────────────────────────────────────────────────────────────────────────
export const AGENT_IDS = [
  'decomposer',
  'refiner',
  'worker.cli_spawn',
  'worker.llm_call',
  'worker.tool_call',
  'worker.advisor_call',
  'reviewer',
  'failover_classifier',
  'consolidator',
  'builder.conversational',
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

/** Tools an agent may call. Personas declare an allowlist; the runner enforces it. */
export type ToolName =
  | 'Write'
  | 'Edit'
  | 'Read'
  | 'Glob'
  | 'Grep'
  | 'Bash'
  | 'WebFetch'
  | 'http_request'
  | 'sql_query'
  | 'file_read'
  | 'file_write';

// ─────────────────────────────────────────────────────────────────────────────
// Ambiguity / failure-mode contracts
// ─────────────────────────────────────────────────────────────────────────────

export interface AmbiguityRule {
  /** When the agent encounters this condition... */
  condition: string;
  /** ...it must do this. */
  resolution: string;
  /** Whether to escalate to operator (HITL) or proceed autonomously. */
  escalate: boolean;
}

/**
 * Remediation strategies the failover classifier may pick. The string union is
 * intentionally a literal type so that misspellings break the build.
 */
export type RemediationStrategy =
  | 'retry_as_is'
  | 'retry_with_stronger_prompt'
  | 'retry_with_different_model'
  | 'retry_with_workspace_clean'
  | 'switch_executor'
  | 'escalate_to_operator'
  | 'soft_fail';

export interface FailureMode<O = unknown> {
  /** Stable id; surfaces in events + ledger ("worker.described_without_writing"). */
  id: string;
  /** Pattern detector — runs on the agent's output and (optionally) the trace text. */
  detect: (output: O, traceText: string) => boolean;
  /** What the failover classifier should do when this fires. */
  remediation: RemediationStrategy;
  /** Optional: prompt addition to inject on retry. */
  retryPromptAddition?: string;
  /** Optional human description used in operator notifications. */
  description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook return shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * preHook may either:
 *   - return a (possibly mutated) input,
 *   - short-circuit with a deterministic result and skip the LLM/tool invocation.
 */
export type PreHookResult<I, O> = I | { skipWithResult: O };

/**
 * postHook may either:
 *   - return a (possibly repaired) output,
 *   - reject with a structured reason that triggers failover classification.
 */
export type PostHookResult<O> = O | { rejectWithReason: string; mode?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Runtime context — passed into every hook and tool call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal event sink. The real daemon binds this to the workflow event bus;
 * tests stub it with an in-memory array. Keeping it tiny avoids leaking the
 * full Daemon shape into the agents tree.
 */
export interface AgentEventEmitter {
  emit(event: string, payload: Record<string, unknown>): void;
  warn(message: string, payload?: Record<string, unknown>): void;
}

export interface AgentContext extends AgentEventEmitter {
  /** Workflow id (when the agent runs inside a workflow). */
  workflowId?: string;
  /** Task id (when scoped to a task; absent for workflow-level agents). */
  taskId?: string;
  /**
   * When worker personas run via `runAgent`, describes why this task was scheduled
   * (built by the executor from upstream completion). Optional on legacy paths.
   */
  transition?: TransitionContext;
  /** Absolute path to the active workspace root. */
  workspaceDir?: string;
  /** How many times this agent has been retried for this invocation. */
  retryCount: number;
  /** Wall-clock budget; runner enforces. */
  deadlineMs?: number;
  /**
   * Bounded carry block from the previous step (formatted by formatCarryBlock).
   * Workers inject this into the prompt as "## Previous step output (carry block)\n{carry}".
   * Set by the executor before invoking the persona.
   */
  carry?: string;
  /**
   * Logger surface — daemon binds to its structured logger, tests use console.
   * Kept independent from `emit` so persistent events and ephemeral debug logs
   * can be filtered separately.
   */
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, payload?: Record<string, unknown>) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// AgentPersona — the canonical contract
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPersona<I, O> {
  /** Stable id used in events, logs, and config keys. */
  id: AgentId;
  /** Persona schema/version — bumped when prompt or contract changes materially. */
  version: string;
  /** Human-readable name for the dashboard. */
  name: string;
  /** One-paragraph identity statement, copied verbatim into the system prompt. */
  identity: string;
  /** Mission — the single sentence the agent measures itself against. */
  mission: string;
  /** Zod schema of the input the agent expects. */
  inputSchema: z.ZodType<I>;
  /** Zod schema of the output the agent must produce. */
  outputSchema: z.ZodType<O>;
  /** Numbered list of inviolable rules. Surface in the system prompt verbatim. */
  hardRules: readonly string[];
  /** Numbered list of forbidden actions. Surface in the system prompt verbatim. */
  forbidden: readonly string[];
  /** Decision tree for ambiguous cases — agent must follow these literally. */
  ambiguityProtocol: readonly AmbiguityRule[];
  /** Tools available at this stage (allowlist). Empty array = pure LLM call. */
  tools: readonly ToolName[];
  /**
   * Optional fine-grained policy over {@link tools}: allow / ask / deny per tool name.
   * Glob patterns (`*`, `?`) and a literal `*` map key apply before defaultAction (see permissions.ts).
   */
  permissions?: PersonaPermissions;
  /**
   * Default model used when the input does not specify one. Personas without a
   * canonical model (e.g. tool_call) leave this null.
   */
  defaultModel: string | null;
  /** Pre-hook: runs before invocation, can mutate input or short-circuit. */
  preHook?: (input: I, ctx: AgentContext) => Promise<PreHookResult<I, O>>;
  /** Post-hook: runs after output is produced, can validate / reject / repair. */
  postHook?: (input: I, output: O, ctx: AgentContext) => Promise<PostHookResult<O>>;
  /** System prompt template — uses `${input.field}` interpolation via renderTemplate. */
  systemPromptTemplate: string;
  /** Known failure modes with remediation, used by failover classifier. */
  failureModes: readonly FailureMode<O>[];
  /** Few-shot examples (good outputs, bad outputs with annotation). */
  examples?: { good: O[]; bad: { output: unknown; reason: string }[] };
  /** Universal hard rules are applied by the runner; personas may opt out per-rule. */
  optOutUniversalRules?: readonly UniversalRuleId[];
  /**
   * Wave 3.E — when true, the runner consumes options.invokeStream or the
   * default Omniroute stream invoker instead of options.invoke, and emits
   * agent_streaming_chunk events as the model yields. Output is accumulated
   * to the same string shape that the non-streaming path would produce, so
   * schema validation and postHooks are unchanged.
   */
  streaming?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal hard rules — applied to every agent unless explicitly opted out
// ─────────────────────────────────────────────────────────────────────────────

export const UNIVERSAL_HARD_RULES = [
  {
    id: 'stay_in_lane',
    text: 'Stay in your lane. Do not perform the next stage\'s job.',
  },
  {
    id: 'fail_loudly',
    text: 'Fail loudly, never silently. If you cannot do your job, return a structured error — never success-looking output.',
  },
  {
    id: 'honor_schema',
    text: 'Honor the output schema. Structured outputs start with `{`. No markdown fences, no prose preamble, no trailing explanation.',
  },
  {
    id: 'cite_sources',
    text: 'Cite your sources. When referencing a file, model, or upstream artifact, include the explicit identifier (path, model id, task id) — never "the file" or "this thing".',
  },
  {
    id: 'idempotent',
    text: 'Idempotent within a single invocation. Same input → same output. Don\'t depend on external state that mutates between phases.',
  },
] as const;

export type UniversalRuleId = (typeof UNIVERSAL_HARD_RULES)[number]['id'];

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when postHook rejects the output. Carries enough context for the
 * failover classifier to decide a remediation without re-running the agent.
 */
export class AgentRejectedError extends Error {
  readonly agentId: AgentId;
  readonly input: unknown;
  readonly output: unknown;
  readonly mode?: string;

  constructor(reason: string, agentId: AgentId, input: unknown, output: unknown, mode?: string) {
    super(reason);
    this.name = 'AgentRejectedError';
    this.agentId = agentId;
    this.input = input;
    this.output = output;
    this.mode = mode;
  }
}

/** Thrown when input validation fails. Programming error — no failover. */
export class AgentInputError extends Error {
  readonly agentId: AgentId;
  readonly issues: unknown;
  constructor(agentId: AgentId, issues: unknown) {
    super(`Agent ${agentId} received invalid input`);
    this.name = 'AgentInputError';
    this.agentId = agentId;
    this.issues = issues;
  }
}

/** Thrown when LLM/tool output cannot be parsed even after one retry. */
export class AgentOutputError extends Error {
  readonly agentId: AgentId;
  readonly rawOutput: unknown;
  constructor(agentId: AgentId, rawOutput: unknown, message: string) {
    super(message);
    this.name = 'AgentOutputError';
    this.agentId = agentId;
    this.rawOutput = rawOutput;
  }
}
