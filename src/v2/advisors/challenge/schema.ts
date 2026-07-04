// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/challenge.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

/**
 * Input schema for the `challenge` advisor.
 *
 * Field description copied verbatim from CHALLENGE_FIELD_DESCRIPTIONS["prompt"]
 * in challenge.py — operators / decomposers reading the schema must see the
 * same guidance the PAL author wrote.
 */
export const ChallengeInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt must be a non-empty statement to scrutinize')
    .describe(
      "Statement to scrutinize. If you invoke `challenge` manually, strip the word 'challenge' and pass just the statement. " +
        'Automatic invocations send the full user message as-is; do not modify it.',
    ),
});

export type ChallengeInput = z.infer<typeof ChallengeInputSchema>;

/**
 * Output structure mirrors PAL's response_data dict (challenge.py line 128-138).
 * Returned as the `structured` field of AdvisorResult so consumers can read
 * fields directly instead of parsing the JSON string in `output`.
 */
export interface ChallengeOutput {
  status: 'challenge_accepted';
  original_statement: string;
  challenge_prompt: string;
  instructions: string;
}
