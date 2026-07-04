import type { ContextEngine, AssembleResult, CompactResult, AgentMessage } from './types.js';
import { callOmniroute } from '../../utils/omniroute-call.js';
import { truncate7020 } from './truncate.js';
import { estimateTokens } from './estimate-tokens.js';

export class DefaultContextEngine implements ContextEngine {
  readonly info = {
    id: 'default',
    name: 'DefaultContextEngine',
    ownsCompaction: true,
  };

  async assemble(params: {
    messages: AgentMessage[];
    tokenBudget?: number;
    model?: string;
  }): Promise<AssembleResult> {
    const estimated = estimateTokens(params.messages, params.model);
    if (!params.tokenBudget || estimated <= params.tokenBudget) {
      return { messages: params.messages, estimatedTokens: estimated };
    }
    const truncated = truncate7020(params.messages, params.tokenBudget, params.model);
    return { messages: truncated, estimatedTokens: estimateTokens(truncated, params.model) };
  }

  async compact(params: {
    messages: AgentMessage[];
    force?: boolean;
    compactionTarget?: 'budget' | 'threshold';
    currentTokenCount?: number;
    model?: string;
  }): Promise<CompactResult> {
    const tokensBefore = params.currentTokenCount ?? estimateTokens(params.messages, params.model);

    const splitIdx = Math.floor(params.messages.length * 0.7);
    const toSummarize = params.messages.slice(0, splitIdx);
    const tail = params.messages.slice(splitIdx);
    const firstKeptEntryId = tail[0]?.id;

    const summary = await callOmniroute({
      systemPrompt:
        'Summarize the following conversation for context preservation. Keep key decisions, data, and caveats. Omit greetings and filler.',
      userPrompt: toSummarize.map(m => `${m.role}: ${m.content}`).join('\n\n'),
      model: params.model ?? 'cc/claude-haiku-4-5-20251001',
    });

    const compactedMessages: AgentMessage[] = [
      {
        id: 'compact-summary',
        role: 'system',
        content: `<compacted-context>\n${summary}\n</compacted-context>`,
      },
      ...tail,
    ];
    const tokensAfter = estimateTokens(compactedMessages, params.model);

    return {
      ok: true,
      compacted: true,
      result: { summary, firstKeptEntryId, tokensBefore, tokensAfter },
    };
  }

  async ingest(_params: { message: AgentMessage }): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
}
