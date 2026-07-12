// Helpers for stepwise advisor prompts (AETHER γ).

import type {
  AdvisorContext,
  AdvisorResult,
  StepwiseAdvisorContext,
  StepwiseAdvisorResult,
} from '../types.js';
import { appendStep, ensureConversation, getHistory, type StepHistory } from './conversationMemory.js';
import { callAdvisorLlm } from './llm.js';

export function formatStepHistoryBlock(history: StepHistory[]): string {
  if (history.length === 0) {
    return '(First step — no prior advisor outputs in this conversation.)';
  }
  return history.map((h) => `### Prior step ${h.step} output\n${h.output}`).join('\n\n');
}

/** Parses the last `[CONTINUE: …]` tag from model output (case-insensitive). */
export function extractContinueFocus(text: string): string | undefined {
  const matches = [...text.matchAll(/\[CONTINUE:\s*([^\]]+?)\]/gi)];
  const last = matches[matches.length - 1];
  const focus = last?.[1]?.trim();
  return focus || undefined;
}

/**
 * Formats one `issues_found` entry as an `[SEVERITY] description` line.
 * The schema types entries as Record<string, unknown>, so narrow with
 * `typeof` instead of casting — a non-string severity must not reach
 * `.toUpperCase()` at runtime.
 */
export function formatIssueLine(issue: Record<string, unknown>): string {
  const severity = typeof issue['severity'] === 'string' ? issue['severity'] : 'unknown';
  const description =
    typeof issue['description'] === 'string' ? issue['description'] : 'No description';
  return `[${severity.toUpperCase()}] ${description}`;
}

/** Prompt extras injected by the stepwise runner when conversation memory is active. */
export interface StepwisePromptExtras {
  priorOutputsBlock?: string;
  trackedFindingsLines?: string;
}

export interface RunStepwiseAdvisorOptions {
  advisorName: string;
  systemPrompt: string;
  /** Resolved by the handler via shouldUseStepwiseMemory(ctx, args). */
  useStepwiseMemory: boolean;
  buildUserPrompt: (extras?: StepwisePromptExtras) => string;
  /** Optional sampling temperature, forwarded to the LLM call when set. */
  temperature?: number;
}

/**
 * Shared run() body for the 6 stepwise advisors (precommit, thinkdeep, debug,
 * codereview, consensus, planner): conversation-memory replay, the LLM call,
 * appendStep, and [CONTINUE: …] continuation. Handlers keep only schema
 * parsing, mode resolution, and their advisor-specific prompt building.
 */
export async function runStepwiseAdvisor(
  ctx: AdvisorContext,
  opts: RunStepwiseAdvisorOptions,
): Promise<AdvisorResult | StepwiseAdvisorResult> {
  const stepCtx = ctx as StepwiseAdvisorContext;
  const { useStepwiseMemory } = opts;

  let extras: StepwisePromptExtras | undefined;
  if (useStepwiseMemory && stepCtx.step != null) {
    ensureConversation(stepCtx.step.conversationId, opts.advisorName, ctx.workspace);
    const priorOutputsBlock = formatStepHistoryBlock(getHistory(stepCtx.step.conversationId));
    const trackedFindingsLines =
      stepCtx.step.findings.length > 0
        ? stepCtx.step.findings.map((f) => `- ${f}`).join('\n')
        : undefined;
    extras = { priorOutputsBlock, trackedFindingsLines };
  }

  const userPrompt = opts.buildUserPrompt(extras);
  const text = await callAdvisorLlm(ctx, {
    systemPrompt: opts.systemPrompt,
    userPrompt,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  });

  if (useStepwiseMemory && stepCtx.step != null) {
    appendStep(stepCtx.step.conversationId, stepCtx.step.stepNumber, text);
  }

  const focus = extractContinueFocus(text);
  if (
    useStepwiseMemory &&
    stepCtx.step != null &&
    stepCtx.step.stepNumber < stepCtx.step.totalSteps &&
    focus
  ) {
    return {
      output: text,
      nextStep: { stepNumber: stepCtx.step.stepNumber + 1, request: focus },
    };
  }

  return { output: text };
}
