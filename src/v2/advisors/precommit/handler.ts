// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/precommit.py — class PrecommitTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// Notable simplifications vs the Python source:
// - PAL's WorkflowTool stores cross-call memory and controls expert-analysis
//   timing. Stepwise execution uses conversationMemory + executor persistence.
// - PAL writes/reads a pal_precommit.changeset during guided CLI workflows.
//   Here, callers include those paths in `relevant_files` and the LLM receives
//   the path list in the user prompt.

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
import { PrecommitInputSchema, type PrecommitInput } from './schema.js';
import { PRECOMMIT_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Validates git changes and repository state before committing with systematic analysis. ' +
  'Use for multi-repository validation, security review, change impact assessment, and completeness verification. ' +
  'Guides through structured investigation with expert analysis.';

export type PrecommitPromptExtras = StepwisePromptExtras;

function buildUserPrompt(parsed: PrecommitInput, extras?: PrecommitPromptExtras): string {
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

  lines.push(`=== PRE-COMMIT STEP ${parsed.step_number} of ${parsed.total_steps} ===`);
  lines.push(`Validation type: ${parsed.precommit_type}`);
  lines.push(`Severity filter: ${parsed.severity_filter}`);
  lines.push(`Use assistant model: ${parsed.use_assistant_model}`);
  lines.push(`Confidence: ${parsed.confidence}`);
  if (parsed.path) lines.push(`Repository path: ${parsed.path}`);
  if (parsed.compare_to) lines.push(`Compare to: ${parsed.compare_to}`);
  lines.push(`Include staged: ${parsed.include_staged}`);
  lines.push(`Include unstaged: ${parsed.include_unstaged}`);
  if (parsed.focus_on) lines.push(`Focus on: ${parsed.focus_on}`);
  lines.push('');
  lines.push('=== STEP NARRATIVE ===');
  lines.push(parsed.step);
  lines.push('');
  lines.push('=== FINDINGS SO FAR ===');
  lines.push(parsed.findings);

  if (parsed.hypothesis) {
    lines.push('');
    lines.push('=== CURRENT HYPOTHESIS ===');
    lines.push(parsed.hypothesis);
  }

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
    lines.push('=== VISUAL VALIDATION INFORMATION ===');
    parsed.images.forEach((img) => lines.push(`- ${img}`));
  }

  lines.push('');
  lines.push(`next_step_required: ${parsed.next_step_required}`);

  return lines.join('\n');
}

export const precommitAdvisor: Advisor = {
  name: 'precommit',
  description: DESCRIPTION,
  isStepwise: true,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult | StepwiseAdvisorResult> {
    const parsed = PrecommitInputSchema.parse(args);
    return runStepwiseAdvisor(ctx, {
      advisorName: 'precommit',
      systemPrompt: PRECOMMIT_SYSTEM_PROMPT,
      useStepwiseMemory: shouldUseStepwiseMemory(ctx, args),
      buildUserPrompt: (extras) => buildUserPrompt(parsed, extras),
    });
  },
};
