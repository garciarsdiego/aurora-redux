// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/codereview.py — class CodeReviewTool
// © BeehiveInnovations — see ../NOTICE.md.

import type {
  Advisor,
  AdvisorContext,
  AdvisorResult,
  StepwiseAdvisorResult,
} from '../types.js';
import { shouldUseStepwiseMemory } from '../shared/mode.js';
import {
  formatIssueLine,
  runStepwiseAdvisor,
  type StepwisePromptExtras,
} from '../shared/stepwisePrompt.js';
import { CodereviewInputSchema, type CodereviewInput } from './schema.js';
import { CODEREVIEW_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Performs systematic, step-by-step code review with expert validation. ' +
  'Use for comprehensive analysis covering quality, security, performance, and architecture. ' +
  'Guides through structured investigation to ensure thoroughness.';

function buildUserPrompt(parsed: CodereviewInput, extras?: StepwisePromptExtras): string {
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
    parsed.issues_found.forEach((issue) => lines.push(formatIssueLine(issue)));
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
    return runStepwiseAdvisor(ctx, {
      advisorName: 'codereview',
      systemPrompt: CODEREVIEW_SYSTEM_PROMPT,
      useStepwiseMemory: shouldUseStepwiseMemory(ctx, args),
      buildUserPrompt: (extras) => buildUserPrompt(parsed, extras),
    });
  },
};
