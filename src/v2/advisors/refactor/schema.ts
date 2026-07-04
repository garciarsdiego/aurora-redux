// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/refactor.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const RefactorInputSchema = z
  .object({
    step: z
      .string()
      .min(1)
      .describe(
        'The refactoring plan. Step 1: State strategy. Later steps: Report findings. ' +
          'CRITICAL: Examine code for smells, and opportunities for decomposition, modernization, and organization. ' +
          "Use 'relevant_files' for code. FORBIDDEN: Large code snippets.",
      ),
    step_number: z
      .number()
      .int()
      .min(1)
      .describe(
        'The index of the current step in the refactoring investigation sequence, beginning at 1. Each step should ' +
          'build upon or revise the previous one.',
      ),
    total_steps: z
      .number()
      .int()
      .min(1)
      .describe(
        'Your current estimate for how many steps will be needed to complete the refactoring investigation. ' +
          'Adjust as new opportunities emerge.',
      ),
    next_step_required: z
      .boolean()
      .describe(
        'Set to true if you plan to continue the investigation with another step. False means you believe the ' +
          'refactoring analysis is complete and ready for expert validation.',
      ),
    findings: z
      .string()
      .min(1)
      .describe(
        'Summary of discoveries from this step, including code smells and opportunities for decomposition, modernization, or organization. ' +
          'Document both strengths and weaknesses. In later steps, confirm or update past findings.',
      ),
    files_checked: z
      .array(z.string())
      .default([])
      .describe('List all files examined (absolute paths). Include even ruled-out files to track exploration path.'),
    relevant_files: z
      .array(z.string())
      .default([])
      .describe(
        'Subset of files_checked with code requiring refactoring (absolute paths). Include files with ' +
          'code smells, decomposition needs, or improvement opportunities.',
      ),
    relevant_context: z
      .array(z.string())
      .default([])
      .describe(
        "List methods/functions central to refactoring opportunities, in 'ClassName.methodName' or 'functionName' format. " +
          'Prioritize those with code smells or needing improvement.',
      ),
    issues_found: z
      .array(z.record(z.string(), z.unknown()))
      .default([])
      .describe(
        "Refactoring opportunities as dictionaries with 'severity' (critical/high/medium/low), " +
          "'type' (codesmells/decompose/modernize/organization), and 'description'. " +
          'Include all improvement opportunities found.',
      ),
    confidence: z
      .enum(['exploring', 'incomplete', 'partial', 'complete'])
      .default('incomplete')
      .describe(
        'Your confidence in refactoring analysis: exploring (starting), incomplete (significant work remaining), ' +
          'partial (some opportunities found, more analysis needed), complete (comprehensive analysis finished, ' +
          'all major opportunities identified). ' +
          "WARNING: Use 'complete' ONLY when fully analyzed and can provide recommendations without expert help. " +
          "'complete' PREVENTS expert validation. Use 'partial' for large files or uncertain analysis.",
      ),
    images: z
      .array(z.string())
      .optional()
      .describe(
        'Optional list of absolute paths to architecture diagrams, UI mockups, design documents, or visual references ' +
          'that help with refactoring context. Only include if they materially assist understanding or assessment.',
      ),
    refactor_type: z
      .enum(['codesmells', 'decompose', 'modernize', 'organization'])
      .default('codesmells')
      .describe('Type of refactoring analysis to perform (codesmells, decompose, modernize, organization)'),
    focus_areas: z
      .array(z.string())
      .optional()
      .describe("Specific areas to focus on (e.g., 'performance', 'readability', 'maintainability', 'security')"),
    style_guide_examples: z
      .array(z.string())
      .optional()
      .describe(
        'Optional existing code files to use as style/pattern reference (must be FULL absolute paths to real files / ' +
          'folders - DO NOT SHORTEN). These files represent the target coding style and patterns for the project.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Model to run. Supply a name if requested by the user or stay in auto mode. When in auto mode, use `listmodels` tool for model discovery.',
      ),
    continuation_id: z
      .string()
      .optional()
      .describe(
        'Unique thread continuation ID for multi-turn conversations. Works across different tools. ' +
          'ALWAYS reuse the last continuation_id you were given—this preserves full conversation context, ' +
          'files, and findings so the agent can resume seamlessly.',
      ),
    hypothesis: z.string().optional().describe('Current theory about issue/goal based on work'),
    use_assistant_model: z
      .boolean()
      .default(true)
      .describe(
        'Use assistant model for expert analysis after workflow steps. ' +
          'False skips expert analysis, relies solely on your personal investigation. ' +
          'Defaults to True for comprehensive validation.',
      ),
  })
  .refine((value) => value.step_number !== 1 || value.relevant_files.length > 0, {
    message: "Step 1 requires 'relevant_files' field to specify code files or directories to analyze for refactoring",
    path: ['relevant_files'],
  });

export type RefactorInput = z.infer<typeof RefactorInputSchema>;
