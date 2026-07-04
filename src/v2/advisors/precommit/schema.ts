// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/precommit.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const PrecommitInputSchema = z
  .object({
    step: z
      .string()
      .min(1)
      .describe(
        "Step 1: outline how you'll validate the git changes. Later steps: report findings. Review diffs and impacts, use `relevant_files`, and avoid pasting large snippets.",
      ),
    step_number: z
      .number()
      .int()
      .min(1)
      .describe('Current pre-commit step number (starts at 1).'),
    total_steps: z
      .number()
      .int()
      .min(1)
      .describe(
        'Planned number of validation steps. External validation: use at most three (analysis → follow-ups → summary). Internal validation: a single step. Honour these limits when resuming via continuation_id.',
      ),
    next_step_required: z
      .boolean()
      .describe(
        'True to continue with another step, False when validation is complete. ' +
          'CRITICAL: If total_steps>=3 or when `precommit_type = external`, set to True until the final step. ' +
          'When continuation_id is provided: Follow the same validation rules based on precommit_type.',
      ),
    findings: z
      .string()
      .describe(
        'Record git diff insights, risks, missing tests, security concerns, and positives; update previous notes as you go.',
      ),
    files_checked: z
      .array(z.string())
      .default([])
      .describe('Absolute paths for every file examined, including ruled-out candidates.'),
    relevant_files: z
      .array(z.string())
      .default([])
      .describe(
        'Absolute paths of files involved in the change or validation (code, configs, tests, docs). Must be absolute full non-abbreviated paths.',
      ),
    relevant_context: z
      .array(z.string())
      .default([])
      .describe("Key functions/methods touched by the change (e.g. 'Class.method', 'function_name')."),
    issues_found: z
      .array(z.record(z.string(), z.unknown()))
      .default([])
      .describe('List issues with severity (critical/high/medium/low) plus descriptions (bugs, security, performance, coverage).'),
    confidence: z.string().default('low').describe('Latest confidence level from workflow investigation.'),
    hypothesis: z.string().optional().describe('Optional current hypothesis or assessment for the validation.'),
    use_assistant_model: z
      .boolean()
      .default(true)
      .describe('Whether to use the assistant/expert model for final validation.'),
    precommit_type: z
      .enum(['external', 'internal'])
      .default('external')
      .describe("'external' (default, triggers expert model) or 'internal' (local-only validation)."),
    images: z
      .array(z.string())
      .optional()
      .describe('Optional absolute paths to screenshots or diagrams that aid validation.'),
    path: z.string().optional().describe('Absolute path to the repository root. Required in step 1.'),
    compare_to: z
      .string()
      .optional()
      .describe('Optional git ref (branch/tag/commit) to diff against; falls back to staged/unstaged changes.'),
    include_staged: z
      .boolean()
      .default(true)
      .describe('Whether to inspect staged changes (ignored when `compare_to` is set).'),
    include_unstaged: z
      .boolean()
      .default(true)
      .describe('Whether to inspect unstaged changes (ignored when `compare_to` is set).'),
    focus_on: z
      .string()
      .optional()
      .describe('Optional emphasis areas such as security, performance, or test coverage.'),
    severity_filter: z
      .enum(['critical', 'high', 'medium', 'low', 'all'])
      .default('all')
      .describe('Lowest severity to include when reporting issues.'),
  })
  .refine((value) => value.step_number !== 1 || Boolean(value.path), {
    message: "Step 1 requires 'path' field to specify git repository location",
    path: ['path'],
  });

export type PrecommitInput = z.infer<typeof PrecommitInputSchema>;
