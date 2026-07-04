// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/challenge.py — _wrap_prompt_for_challenge()
// © BeehiveInnovations — see ../NOTICE.md.
//
// PAL's challenge tool does NOT call an LLM. The "prompt" here is a pure-text
// wrapper template that the receiving CLI agent reads and acts on. Kept in a
// separate file (mirroring the other advisor folder shape) so future tools
// that DO call an LLM follow the same convention.

/**
 * Wraps a user statement in critical-reassessment instructions.
 *
 * Verbatim copy of the f-string at challenge.py lines 168-175. Whitespace,
 * punctuation, and dashes preserved exactly.
 */
export function wrapPromptForChallenge(prompt: string): string {
  return (
    `CRITICAL REASSESSMENT – Do not automatically agree:\n\n` +
    `"${prompt}"\n\n` +
    `Carefully evaluate the statement above. Is it accurate, complete, and well-reasoned? ` +
    `Investigate if needed before replying, and stay focused. If you identify flaws, gaps, or misleading ` +
    `points, explain them clearly. Likewise, if you find the reasoning sound, explain why it holds up. ` +
    `Respond with thoughtful analysis—stay to the point and avoid reflexive agreement.`
  );
}

/**
 * Operator-facing instructions appended to the structured output. Verbatim
 * copy from challenge.py line 132-137.
 */
export const CHALLENGE_INSTRUCTIONS =
  'Present the challenge_prompt to yourself and follow its instructions. ' +
  'Reassess the statement carefully and critically before responding. ' +
  'If, after reflection, you find reasons to disagree or qualify it, explain your reasoning. ' +
  'Likewise, if you find reasons to agree, articulate them clearly and justify your agreement.';
