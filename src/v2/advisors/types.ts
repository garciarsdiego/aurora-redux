// src/v2/advisors/types.ts
// Advisor foundation types for the Omniforge native advisor module.
// Ported from PAL MCP Server (Apache 2.0) — see NOTICE.md.

export interface AdvisorResult {
  output: string;
  structured?: unknown;
  /**
   * Reserved for token/cost attribution. No handler populates this today —
   * they call callOmniroute (which discards usage); cost tracking happens
   * inside callOmnirouteWithUsage/the ledger instead. Kept on the contract
   * for callers that fill it in from outer layers.
   */
  usage?: {
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
  };
}

export type AdvisorEvent =
  | { type: 'advisor_step_start'; advisor: string; step: number }
  | { type: 'advisor_step_chunk'; advisor: string; chunk: string }
  | { type: 'advisor_step_end'; advisor: string; step: number; output: string };

/**
 * Per-call advisor execution mode (Onda 1 cluster F).
 * - `stepwise`: full iterative loop with conversationMemory (legacy default for stepwise advisors).
 * - `oneshot`:  single LLM call, no loop / no conversation memory replay.
 * - `auto`:     advisor decides based on intent / complexity (default; safe fallback).
 */
export type AdvisorMode = 'stepwise' | 'oneshot' | 'auto';

export const ADVISOR_MODES: readonly AdvisorMode[] = ['stepwise', 'oneshot', 'auto'] as const;

export interface AdvisorContext {
  workspace: string;
  workflow_id: string;
  signal?: AbortSignal;
  /**
   * Reserved streaming hook — no handler emits advisor_step_* events yet.
   * Kept on the contract for future streaming-aware executors.
   */
  onEvent?: (event: AdvisorEvent) => void;
  /** Per-call execution mode override (Onda 1 cluster F). Defaults to 'auto'. */
  mode?: AdvisorMode;
}

export interface Advisor {
  name: string;
  description: string;
  /** When true, executor may run multi-step loop with `StepwiseAdvisorContext.step`. */
  isStepwise?: boolean;
  run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult | StepwiseAdvisorResult>;
}

// ── Stepwise types (AETHER γ) ────────────────────────────────────────────────

export interface StepState {
  stepNumber: number;
  totalSteps: number;
  nextStepRequired: boolean;
  findings: string[];
  conversationId: string;
}

export interface StepwiseAdvisorContext extends AdvisorContext {
  step?: StepState;
}

export type StepwiseAdvisorResult = AdvisorResult & {
  nextStep?: {
    /** Next step index (1-based); mirrors executor loop advancement. */
    stepNumber: number;
    request: string;
  };
};
