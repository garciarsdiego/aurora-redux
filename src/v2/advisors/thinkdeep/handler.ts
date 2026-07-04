// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/thinkdeep.py — class ThinkDeepTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// Notable simplifications vs the Python source:
// - PAL's WorkflowTool stores work_history, consolidated_findings, and pause/resume MCP responses.
//   Omniforge keeps cross-step continuity via conversationMemory + optional SQLite persistence (executor).

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
import { ThinkDeepInputSchema, type ThinkDeepInput } from './schema.js';
import { THINKDEEP_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Performs multi-stage investigation and reasoning for complex problem analysis. ' +
  'Use for architecture decisions, complex bugs, performance challenges, and security analysis. ' +
  'Provides systematic hypothesis testing, evidence-based investigation, and expert validation.';

export interface ThinkDeepPromptExtras {
  priorOutputsBlock?: string;
  trackedFindingsLines?: string;
}

function buildUserPrompt(parsed: ThinkDeepInput, extras?: ThinkDeepPromptExtras): string {
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

  lines.push(`=== THINKING STEP ${parsed.step_number} of ${parsed.total_steps} ===`);
  lines.push(`Confidence: ${parsed.confidence}`);
  lines.push(`Next step required: ${parsed.next_step_required}`);

  if (parsed.problem_context) {
    lines.push('');
    lines.push('=== PROBLEM CONTEXT ===');
    lines.push(parsed.problem_context);
  }

  if (parsed.focus_areas && parsed.focus_areas.length > 0) {
    lines.push('');
    lines.push(`=== FOCUS AREAS ===`);
    parsed.focus_areas.forEach((a) => lines.push(`- ${a}`));
  }

  lines.push('');
  lines.push('=== STEP NARRATIVE ===');
  lines.push(parsed.step);

  lines.push('');
  lines.push('=== FINDINGS ===');
  lines.push(parsed.findings);

  if (parsed.hypothesis) {
    lines.push('');
    lines.push('=== CURRENT HYPOTHESIS ===');
    lines.push(parsed.hypothesis);
  }

  if (parsed.files_checked.length > 0) {
    lines.push('');
    lines.push('=== FILES CHECKED ===');
    parsed.files_checked.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.relevant_files.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT FILES ===');
    parsed.relevant_files.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.relevant_context.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT CONTEXT ===');
    parsed.relevant_context.forEach((c) => lines.push(`- ${c}`));
  }

  if (parsed.issues_found.length > 0) {
    lines.push('');
    lines.push('=== ISSUES FOUND ===');
    parsed.issues_found.forEach((issue) => {
      const severity = issue['severity'] ?? 'unknown';
      const description = issue['description'] ?? JSON.stringify(issue);
      lines.push(`- [${severity}] ${description}`);
    });
  }

  return lines.join('\n');
}

export const thinkdeepAdvisor: Advisor = {
  name: 'thinkdeep',
  description: DESCRIPTION,
  isStepwise: true,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult | StepwiseAdvisorResult> {
    const parsed = ThinkDeepInputSchema.parse(args);
    const stepCtx = ctx as StepwiseAdvisorContext;
    const useStepwiseMemory = shouldUseStepwiseMemory(ctx, args);

    let extras: ThinkDeepPromptExtras | undefined;
    if (useStepwiseMemory && stepCtx.step != null) {
      ensureConversation(stepCtx.step.conversationId, 'thinkdeep', ctx.workspace);
      const priorOutputsBlock = formatStepHistoryBlock(getHistory(stepCtx.step.conversationId));
      const trackedFindingsLines =
        stepCtx.step.findings.length > 0 ? stepCtx.step.findings.map((f) => `- ${f}`).join('\n') : undefined;
      extras = { priorOutputsBlock, trackedFindingsLines };
    }

    const userPrompt = buildUserPrompt(parsed, extras);
    const text = await callOmniroute({
      systemPrompt: THINKDEEP_SYSTEM_PROMPT,
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
