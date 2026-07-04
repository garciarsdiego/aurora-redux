// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/tracer.py — class TracerRequest
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const TracerInputSchema = z
  .object({
    step: z
      .string()
      .min(1)
      .describe(
        'Step 1: state the tracing strategy. Later steps: report findings and adapt the plan. ' +
          'For precision mode emphasize execution flow and call chains; for dependencies mode emphasize structural relationships. ' +
          "If trace_mode is 'ask' in step 1, prompt the user to choose precision or dependencies before continuing.",
      ),
    step_number: z
      .number()
      .int()
      .min(1)
      .describe('Current tracing step index (starts at 1); each step should build on the previous.'),
    total_steps: z
      .number()
      .int()
      .min(1)
      .describe(
        'Estimated number of steps to complete tracing; adjust upward as discoveries warrant.',
      ),
    next_step_required: z
      .boolean()
      .describe(
        'True to continue investigating; false when tracing is complete and final formatted output should follow.',
      ),
    findings: z
      .string()
      .describe(
        'Summary of discoveries: execution paths, dependency relationships, call chains, structural patterns. ' +
          'Document direct and indirect relationships.',
      ),
    files_checked: z
      .array(z.string())
      .default([])
      .describe('All files examined this step (absolute paths), including ruled-out paths.'),
    relevant_files: z
      .array(z.string())
      .default([])
      .describe('Subset of files_checked directly tied to the trace target (absolute paths).'),
    relevant_context: z
      .array(z.string())
      .default([])
      .describe(
        "Methods/functions central to the trace, e.g. 'ClassName.methodName' or 'functionName'.",
      ),
    confidence: z
      .string()
      .default('exploring')
      .describe(
        'Confidence band: exploring, low, medium, high, very_high, almost_certain, certain. ' +
          "Use 'certain' only when analysis is locally complete (blocks external validation in PAL workflows).",
      ),
    trace_mode: z
      .enum(['precision', 'dependencies', 'ask'])
      .default('ask')
      .describe(
        'ask prompts the user for mode selection; precision traces execution flow; dependencies maps structural links.',
      ),
    target_description: z
      .string()
      .optional()
      .describe('What to trace and why; include motivation and surrounding context.'),
    images: z
      .array(z.string())
      .optional()
      .describe('Optional paths to architecture diagrams or flow charts that contextualize the trace.'),
  })
  .refine((v) => v.step_number !== 1 || Boolean(v.target_description?.trim()), {
    message: "Step 1 requires 'target_description' describing what to trace and why",
    path: ['target_description'],
  });

export type TracerInput = z.infer<typeof TracerInputSchema>;
