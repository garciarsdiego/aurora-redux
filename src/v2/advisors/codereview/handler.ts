// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/codereview.py — class CodeReviewTool
// © BeehiveInnovations — see ../NOTICE.md.

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
import { CodereviewInputSchema } from './schema.js';
import { CODEREVIEW_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Performs systematic, step-by-step code review with expert validation. ' +
  'Use for comprehensive analysis covering quality, security, performance, and architecture. ' +
  'Guides through structured investigation to ensure thoroughness.';

interface CodereviewPromptExtras {
  priorOutputsBlock?: string;
}

function buildUserPrompt(
  parsed: ReturnType<typeof CodereviewInputSchema.parse>,
  extras?: CodereviewPromptExtras,
): string {
  const lines: string[] = [];

  if (extras?.priorOutputsBlock) {
    lines.push('=== PRIOR STEP OUTPUTS (same conversation) ===');
    lines.push(extras.priorOutputsBlock);
    lines.push('');
  }

  lines.push(`=== CODE REVIEW STEP ${parsed.step_number} of ${parsed.total_steps} ===`);
  lines.push(`Review type: ${parsed.review_type}`);
  if (parsed.focus_on) lines.push(`Focus on: ${parsed.focus_on}`);
  if (parsed.standards) lines.push(`Standards: ${parsed.standards}`);
  lines.push(`Severity filter: ${parsed.severity_filter}`);
  lines.push(`Validation type: ${parsed.review_validation_type}`);
  lines.push('');
  lines.push(`=== STEP NARRATIVE ===`);
  lines.push(parsed.step);
  lines.push('');
  lines.push(`=== FINDINGS SO FAR ===`);
  lines.push(parsed.findings);

  if (parsed.relevant_files.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT FILES ===');
    parsed.relevant_files.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.files_checked.length > 0) {
    lines.push('');
    lines.push('=== FILES CHECKED ===');
    parsed.files_checked.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.relevant_context.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT CODE ELEMENTS ===');
    parsed.relevant_context.forEach((c) => lines.push(`- ${c}`));
  }

  if (parsed.issues_found.length > 0) {
    lines.push('');
    lines.push('=== ISSUES IDENTIFIED ===');
    parsed.issues_found.forEach((issue) => {
      const severity = (issue['severity'] as string | undefined) ?? 'unknown';
      const description = (issue['description'] as string | undefined) ?? 'No description';
      lines.push(`[${severity.toUpperCase()}] ${description}`);
    });
  }

  if (parsed.images && parsed.images.length > 0) {
    lines.push('');
    lines.push('=== VISUAL CONTEXT ===');
    parsed.images.forEach((img) => lines.push(`- ${img}`));
  }

  lines.push('');
  lines.push(`next_step_required: ${parsed.next_step_required}`);

  return lines.join('\n');
}

export const codereviewAdvisor: Advisor = {
  name: 'codereview',
  description: DESCRIPTION,
  isStepwise: true,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult | StepwiseAdvisorResult> {
    const parsed = CodereviewInputSchema.parse(args);
    const stepCtx = ctx as StepwiseAdvisorContext;
    const useStepwiseMemory = shouldUseStepwiseMemory(ctx, args);

    let extras: CodereviewPromptExtras | undefined;
    if (useStepwiseMemory && stepCtx.step != null) {
      ensureConversation(stepCtx.step.conversationId, 'codereview', ctx.workspace);
      extras = {
        priorOutputsBlock: formatStepHistoryBlock(getHistory(stepCtx.step.conversationId)),
      };
    }

    const userPrompt = buildUserPrompt(parsed, extras);
    const text = await callOmniroute({
      systemPrompt: CODEREVIEW_SYSTEM_PROMPT,
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
