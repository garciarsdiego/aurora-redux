// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/challenge.py — class ChallengeTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// Notable simplifications vs the Python source:
// - PAL's SimpleTool/ToolRequest base classes are absorbed into our Advisor
//   interface (../types.ts). We don't carry the model-category / temperature
//   plumbing because challenge doesn't call an LLM.
// - PAL's `format_response` / `prepare_prompt` are no-ops upstream too — they
//   exist only because the SimpleTool ABC requires them. Skipped here.
// - JSON serialization is identical to PAL: indent=2, ensure_ascii=False.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { ChallengeInputSchema, type ChallengeOutput } from './schema.js';
import { CHALLENGE_INSTRUCTIONS, wrapPromptForChallenge } from './prompt.js';

const DESCRIPTION =
  'Prevents reflexive agreement by forcing critical thinking and reasoned analysis when a statement is challenged. ' +
  'Trigger automatically when a user critically questions, disagrees or appears to push back on earlier answers, ' +
  'and use it manually to sanity-check contentious claims.';

export const challengeAdvisor: Advisor = {
  name: 'challenge',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = ChallengeInputSchema.parse(args);
    void getAdvisorMode(ctx, args);

    const wrapped = wrapPromptForChallenge(parsed.prompt);
    const structured: ChallengeOutput = {
      status: 'challenge_accepted',
      original_statement: parsed.prompt,
      challenge_prompt: wrapped,
      instructions: CHALLENGE_INSTRUCTIONS,
    };

    // PAL serialises with json.dumps(..., indent=2, ensure_ascii=False).
    // JSON.stringify with the indent arg matches the layout exactly; default
    // ensure_ascii is already false for JSON.stringify so we only need indent.
    const output = JSON.stringify(structured, null, 2);

    return {
      output,
      structured,
    };
  },
};
