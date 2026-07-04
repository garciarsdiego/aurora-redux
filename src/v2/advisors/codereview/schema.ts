// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/codereview.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const CodereviewInputSchema = z.object({
  step: z
    .string()
    .describe(
      'Review narrative. Step 1: outline the review strategy. Later steps: report findings. MUST cover quality, security, ' +
        'performance, and architecture. Reference code via `relevant_files`; avoid dumping large snippets.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe('Current review step (starts at 1) – each step should build on the last.'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe(
      'Number of review steps planned. External validation: two steps (analysis + summary). Internal validation: one step. ' +
        'Use the same limits when continuing an existing review via continuation_id.',
    ),
  next_step_required: z
    .boolean()
    .describe(
      'True when another review step follows. External validation: step 1 → True, step 2 → False. Internal validation: set False immediately. ' +
        'Apply the same rule on continuation flows.',
    ),
  findings: z
    .string()
    .describe(
      'Capture findings (positive and negative) across quality, security, performance, and architecture; update each step.',
    ),
  files_checked: z
    .array(z.string())
    .default([])
    .describe('Absolute paths of every file reviewed, including those ruled out.'),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe(
      'Step 1: list all files/dirs under review. Must be absolute full non-abbreviated paths. Final step: narrow to files tied to key findings.',
    ),
  relevant_context: z
    .array(z.string())
    .default([])
    .describe("Functions or methods central to findings (e.g. 'Class.method' or 'function_name')."),
  issues_found: z
    .array(z.record(z.string(), z.unknown()))
    .default([])
    .describe('Issues with severity (critical/high/medium/low) and descriptions.'),
  review_validation_type: z
    .enum(['external', 'internal'])
    .default('external')
    .describe("Set 'external' (default) for expert follow-up or 'internal' for local-only review."),
  images: z
    .array(z.string())
    .optional()
    .describe('Optional diagram or screenshot paths that clarify review context.'),
  review_type: z
    .enum(['full', 'security', 'performance', 'quick'])
    .default('full')
    .describe('Review focus: full, security, performance, or quick.'),
  focus_on: z
    .string()
    .optional()
    .describe("Optional note on areas to emphasise (e.g. 'threading', 'auth flow')."),
  standards: z
    .string()
    .optional()
    .describe('Coding standards or style guides to enforce.'),
  severity_filter: z
    .enum(['critical', 'high', 'medium', 'low', 'all'])
    .default('all')
    .describe('Lowest severity to include when reporting issues (critical/high/medium/low/all).'),
});

export type CodereviewInput = z.infer<typeof CodereviewInputSchema>;
