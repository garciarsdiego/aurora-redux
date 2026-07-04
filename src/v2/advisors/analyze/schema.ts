// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/analyze.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const AnalyzeInputSchema = z.object({
  step: z
    .string()
    .min(1)
    .describe(
      'The analysis plan. Step 1: State your strategy, including how you will map the codebase structure, ' +
        'understand business logic, and assess code quality, performance implications, and architectural patterns. ' +
        'Later steps: Report findings and adapt the approach as new insights emerge.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe(
      'The index of the current step in the analysis sequence, beginning at 1. Each step should build upon or ' +
        'revise the previous one.',
    ),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe(
      'Your current estimate for how many steps will be needed to complete the analysis. ' +
        'Adjust as new findings emerge.',
    ),
  next_step_required: z
    .boolean()
    .describe(
      'Set to true if you plan to continue the investigation with another step. False means you believe the ' +
        'analysis is complete and ready for expert validation.',
    ),
  findings: z
    .string()
    .min(1)
    .describe(
      'Summary of discoveries from this step, including architectural patterns, tech stack assessment, scalability characteristics, ' +
        'performance implications, maintainability factors, and strategic improvement opportunities. ' +
        'IMPORTANT: Document both strengths (good patterns, solid architecture) and concerns (tech debt, overengineering, unnecessary complexity). ' +
        'In later steps, confirm or update past findings with additional evidence.',
    ),
  files_checked: z
    .array(z.string())
    .default([])
    .describe('List all files examined (absolute paths). Include even ruled-out files to track exploration path.'),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe(
      'Subset of files_checked directly relevant to analysis findings (absolute paths). Include files with ' +
        'significant patterns, architectural decisions, or strategic improvement opportunities.',
    ),
  relevant_context: z
    .array(z.string())
    .default([])
    .describe(
      "List methods/functions central to analysis findings, in 'ClassName.methodName' or 'functionName' format. " +
        'Prioritize those demonstrating key patterns, architectural decisions, or improvement opportunities.',
    ),
  issues_found: z
    .array(z.record(z.string(), z.unknown()))
    .default([])
    .describe(
      'Issues or concerns identified during analysis, each with severity level (critical, high, medium, low)',
    ),
  images: z
    .array(z.string())
    .optional()
    .describe('Optional absolute paths to architecture diagrams or visual references that help with analysis context.'),
  confidence: z
    .enum(['exploring', 'low', 'medium', 'high', 'very_high', 'almost_certain', 'certain'])
    .default('medium')
    .describe(
      "Your confidence in the analysis: exploring, low, medium, high, very_high, almost_certain, or certain. " +
        "'certain' indicates the analysis is complete and ready for validation.",
    ),
  analysis_type: z
    .enum(['architecture', 'performance', 'security', 'quality', 'general'])
    .default('general')
    .describe('Type of analysis to perform (architecture, performance, security, quality, general)'),
  output_format: z
    .enum(['summary', 'detailed', 'actionable'])
    .default('detailed')
    .describe('How to format the output (summary, detailed, actionable)'),
});

export type AnalyzeInput = z.infer<typeof AnalyzeInputSchema>;
