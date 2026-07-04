// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/thinkdeep.py — class ThinkDeepWorkflowRequest
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const ThinkDeepInputSchema = z.object({
  step: z
    .string()
    .min(1)
    .describe(
      'Current work step content and findings. Step 1: state the thinking strategy and initial analysis. ' +
        'Later steps: report discoveries, validate hypotheses, and adapt the investigation plan.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe('Current step number (starts at 1); each step should build on the previous.'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe('Estimated total steps needed; adjust upward as discoveries warrant.'),
  next_step_required: z
    .boolean()
    .describe('True to continue investigating; false when analysis is complete and final output should follow.'),
  findings: z
    .string()
    .describe(
      'Discoveries: insights, connections, implications, evidence. ' +
        'Document contradictions to earlier assumptions. Update past findings.',
    ),
  files_checked: z
    .array(z.string())
    .default([])
    .describe('All files examined (absolute paths). Include ruled-out files.'),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe(
      'Files relevant to problem/goal (absolute paths). Include root cause, solution, key insights.',
    ),
  relevant_context: z
    .array(z.string())
    .default([])
    .describe(
      "Key concepts/methods: 'concept_name' or 'ClassName.methodName'. Focus on core insights, decision points.",
    ),
  hypothesis: z
    .string()
    .optional()
    .describe('Current theory based on evidence. Revise in later steps.'),
  issues_found: z
    .array(z.record(z.string(), z.unknown()))
    .default([])
    .describe("Issues with dict: 'severity' (critical/high/medium/low), 'description'."),
  confidence: z
    .string()
    .default('low')
    .describe(
      "Confidence band: exploring/low/medium/high/very_high/almost_certain/certain. " +
        "CRITICAL: 'certain' signals analysis is locally complete.",
    ),
  temperature: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Creative thinking temperature (0-1, default 0.7).'),
  thinking_mode: z
    .string()
    .optional()
    .describe("Depth: minimal/low/medium/high/max. Default 'high'."),
  problem_context: z
    .string()
    .optional()
    .describe('Additional context about problem/goal. Be expressive.'),
  focus_areas: z
    .array(z.string())
    .optional()
    .describe('Focus aspects (architecture, performance, security, etc.).'),
});

export type ThinkDeepInput = z.infer<typeof ThinkDeepInputSchema>;
