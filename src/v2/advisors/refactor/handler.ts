// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/refactor.py — class RefactorTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// Notable simplifications vs the Python source:
// - PAL's WorkflowTool stores cross-step conversation memory and consolidated
//   findings. Conversation memory is deferred to AETHER γ; this port is
//   stateless per invocation and forwards all provided step data to Omniroute.
// - Expert-analysis skip/continuation logic is represented by the input fields
//   and system prompt instead of PAL's internal workflow state machine.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callOmniroute } from '../../../utils/omniroute-call.js';
import { RefactorInputSchema, type RefactorInput } from './schema.js';
import { REFACTOR_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Analyzes code for refactoring opportunities with systematic investigation. ' +
  'Use for code smell detection, decomposition planning, modernization, and maintainability improvements. ' +
  'Guides through structured analysis with expert validation.';

function buildUserPrompt(parsed: RefactorInput): string {
  return JSON.stringify(
    {
      step: parsed.step,
      step_number: parsed.step_number,
      total_steps: parsed.total_steps,
      next_step_required: parsed.next_step_required,
      findings: parsed.findings,
      files_checked: parsed.files_checked,
      relevant_files: parsed.relevant_files,
      relevant_context: parsed.relevant_context,
      issues_found: parsed.issues_found,
      confidence: parsed.confidence,
      images: parsed.images ?? [],
      refactor_type: parsed.refactor_type,
      focus_areas: parsed.focus_areas ?? [],
      style_guide_examples: parsed.style_guide_examples ?? [],
      continuation_id: parsed.continuation_id,
      hypothesis: parsed.hypothesis,
      use_assistant_model: parsed.use_assistant_model,
    },
    null,
    2,
  );
}

export const refactorAdvisor: Advisor = {
  name: 'refactor',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = RefactorInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const userPrompt = buildUserPrompt(parsed);
    const text = await callOmniroute({
      systemPrompt: REFACTOR_SYSTEM_PROMPT,
      userPrompt,
      model: parsed.model ?? 'cc/claude-sonnet-4-6',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return { output: text };
  },
};
