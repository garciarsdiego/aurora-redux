// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/consensus.py — class ConsensusTool
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
import { ConsensusInputSchema } from './schema.js';
import { CONSENSUS_SYSTEM_PROMPT } from './prompt.js';

interface ConsensusPromptExtras {
  priorOutputsBlock?: string;
}

function buildUserPrompt(
  parsed: ReturnType<typeof ConsensusInputSchema.parse>,
  extras?: ConsensusPromptExtras,
): string {
  const lines: string[] = [];

  if (extras?.priorOutputsBlock) {
    lines.push('=== PRIOR STEP OUTPUTS (same conversation) ===');
    lines.push(extras.priorOutputsBlock);
    lines.push('');
  }

  lines.push(`## Consensus Analysis Request`);
  lines.push(`**Step ${parsed.step_number} of ${parsed.total_steps}**`);
  lines.push('');
  lines.push(`### Proposal / Question`);
  lines.push(parsed.step);
  lines.push('');

  if (parsed.findings) {
    lines.push(`### Current Findings`);
    lines.push(parsed.findings);
    lines.push('');
  }

  if (parsed.models && parsed.models.length > 0) {
    lines.push(`### Models to Consult`);
    for (const m of parsed.models) {
      lines.push(`- ${m.model} (stance: ${m.stance ?? 'neutral'})`);
    }
    lines.push('');
  }

  if (parsed.model_responses && parsed.model_responses.length > 0) {
    lines.push(`### Prior Model Responses`);
    lines.push(JSON.stringify(parsed.model_responses, null, 2));
    lines.push('');
  }

  if (parsed.relevant_files && parsed.relevant_files.length > 0) {
    lines.push(`### Relevant Files`);
    for (const f of parsed.relevant_files) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  lines.push(`**Next step required:** ${parsed.next_step_required}`);
  lines.push(`**Current model index:** ${parsed.current_model_index}`);

  return lines.join('\n');
}

export const consensusAdvisor: Advisor = {
  name: 'consensus',
  description:
    'Builds multi-model consensus through systematic analysis and structured debate. ' +
    'Use for complex decisions, architectural choices, feature proposals, and technology evaluations. ' +
    'Consults multiple models with different stances to synthesize comprehensive recommendations.',
  isStepwise: true,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult | StepwiseAdvisorResult> {
    const parsed = ConsensusInputSchema.parse(args);
    const stepCtx = ctx as StepwiseAdvisorContext;
    const useStepwiseMemory = shouldUseStepwiseMemory(ctx, args);

    let extras: ConsensusPromptExtras | undefined;
    if (useStepwiseMemory && stepCtx.step != null) {
      ensureConversation(stepCtx.step.conversationId, 'consensus', ctx.workspace);
      extras = {
        priorOutputsBlock: formatStepHistoryBlock(getHistory(stepCtx.step.conversationId)),
      };
    }

    const userPrompt = buildUserPrompt(parsed, extras);
    const text = await callOmniroute({
      systemPrompt: CONSENSUS_SYSTEM_PROMPT,
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
