// src/v2/advisors/shared/llm.ts
// Shared LLM-call defaults for advisor handlers.

import { callOmniroute } from '../../../utils/omniroute-call.js';
import type { AdvisorContext } from '../types.js';

/** Default model for advisor LLM calls — single source of truth instead of a hardcoded copy per handler. */
export const DEFAULT_ADVISOR_MODEL = 'cc/claude-sonnet-4-6';

export interface AdvisorLlmCall {
  systemPrompt: string;
  userPrompt: string;
  /** Omniroute model id. Defaults to DEFAULT_ADVISOR_MODEL. */
  model?: string;
  /** Optional sampling temperature — forwarded only when set so callOmniroute keeps its own default. */
  temperature?: number;
}

/**
 * Thin callOmniroute wrapper for advisor handlers: applies the shared default
 * model and injects ctx.signal so a workflow cancel aborts the in-flight call.
 */
export function callAdvisorLlm(ctx: AdvisorContext, call: AdvisorLlmCall): Promise<string> {
  return callOmniroute({
    systemPrompt: call.systemPrompt,
    userPrompt: call.userPrompt,
    model: call.model ?? DEFAULT_ADVISOR_MODEL,
    ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
}
