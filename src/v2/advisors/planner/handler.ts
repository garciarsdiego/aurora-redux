// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/planner.py — class PlannerTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// Notable simplifications vs the Python source:
// - PAL's WorkflowTool base class manages conversation memory (work_history,
//   branches, consolidated_findings). Stepwise runs use conversationMemory + executor persistence.
// - requires_model=False in PAL refers to the MCP-boundary model resolution
//   step in PAL's own workflow architecture. We still call callOmniroute because
//   the PLANNER_SYSTEM_PROMPT exists and drives planning analysis.
// - Branching/revision metadata is forwarded to the LLM via the user prompt
//   so the model can produce contextually-aware step content.

import type {
  Advisor,
  AdvisorContext,
  AdvisorResult,
  StepwiseAdvisorContext,
  StepwiseAdvisorResult,
} from '../types.js';
import { appendStep, ensureConversation, getHistory } from '../shared/conversationMemory.js';
import { shouldUseStepwiseMemory } from '../shared/mode.js';
import { extractContinueFocus, formatStepHistoryBlock } from '../shared/stepwisePrompt.js';
import { callOmniroute } from '../../../utils/omniroute-call.js';
import { PlannerInputSchema, type PlannerInput } from './schema.js';
import { PLANNER_SYSTEM_PROMPT } from './prompt.js';

export interface PlannerPromptExtras {
  priorOutputsBlock?: string;
  trackedFindingsLines?: string;
}

function buildUserPrompt(parsed: PlannerInput, extras?: PlannerPromptExtras): string {
  const lines: string[] = [];

  if (extras?.priorOutputsBlock) {
    lines.push('=== PRIOR STEP OUTPUTS (same conversation) ===');
    lines.push(extras.priorOutputsBlock);
    lines.push('');
  }

  if (extras?.trackedFindingsLines) {
    lines.push('=== FINDINGS TRACKED ACROSS STEPS (executor) ===');
    lines.push(extras.trackedFindingsLines);
    lines.push('');
  }

  lines.push(`Planning step ${parsed.step_number} of ${parsed.total_steps}:`);
  lines.push('');
  lines.push(parsed.step);

  if (parsed.is_step_revision && parsed.revises_step_number != null) {
    lines.push('', `[REVISION: This replaces step ${parsed.revises_step_number}]`);
  }

  if (parsed.is_branch_point) {
    const from = parsed.branch_from_step != null ? ` from step ${parsed.branch_from_step}` : '';
    const id = parsed.branch_id ? ` (branch: ${parsed.branch_id})` : '';
    lines.push('', `[BRANCH POINT${from}${id}]`);
  }

  if (parsed.more_steps_needed) {
    lines.push('', `[MORE STEPS NEEDED beyond the current estimate of ${parsed.total_steps}]`);
  }

  lines.push('', `next_step_required: ${parsed.next_step_required}`);

  return lines.join('\n');
}

export const plannerAdvisor: Advisor = {
  name: 'planner',
  description:
    'Breaks down complex tasks through interactive, sequential planning with revision and branching capabilities. ' +
    'Use for complex project planning, system design, migration strategies, and architectural decisions. ' +
    'Builds plans incrementally with deep reflection for complex scenarios.',
  isStepwise: true,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult | StepwiseAdvisorResult> {
    const parsed = PlannerInputSchema.parse(args);
    const stepCtx = ctx as StepwiseAdvisorContext;
    const useStepwiseMemory = shouldUseStepwiseMemory(ctx, args);

    let extras: PlannerPromptExtras | undefined;
    if (useStepwiseMemory && stepCtx.step != null) {
      ensureConversation(stepCtx.step.conversationId, 'planner', ctx.workspace);
      const priorOutputsBlock = formatStepHistoryBlock(getHistory(stepCtx.step.conversationId));
      const trackedFindingsLines =
        stepCtx.step.findings.length > 0 ? stepCtx.step.findings.map((f) => `- ${f}`).join('\n') : undefined;
      extras = { priorOutputsBlock, trackedFindingsLines };
    }

    const userPrompt = buildUserPrompt(parsed, extras);
    const text = await callOmniroute({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt,
      model: 'cc/claude-sonnet-4-6',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
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
  },
};
