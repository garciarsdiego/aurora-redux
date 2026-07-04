// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/docgen.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const DocgenInputSchema = z.object({
  step: z
    .string()
    .min(1)
    .describe(
      'Step 1 (Discovery): list every file that needs documentation and record the total. Do not write docs yet. ' +
        'Steps 2+: document exactly one file per step. Never change code logic; log bugs separately. Keep the counters accurate.',
    ),
  step_number: z.number().int().min(1).describe('Current documentation step (starts at 1).'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe('1 discovery step + one step per file documented (tracks via `total_files_to_document`).'),
  next_step_required: z
    .boolean()
    .describe('True while more files still need documentation; False once everything is complete.'),
  findings: z
    .string()
    .min(1)
    .describe(
      'Summarize documentation gaps, complexity, call flows, and well-documented areas. Stop and report immediately if you uncover a bug.',
    ),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe('Absolute paths for the file(s) you are documenting this step—stick to a single file per step.'),
  relevant_context: z
    .array(z.string())
    .default([])
    .describe(
      "Functions or methods needing documentation (e.g. 'Class.method', 'function_name'), especially complex or user-facing areas.",
    ),
  num_files_documented: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Count of files finished so far. Increment only when a file is fully documented.'),
  total_files_to_document: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Total files identified in discovery; completion requires matching this count.'),
  document_complexity: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include algorithmic complexity (Big O) analysis when True (default).'),
  document_flow: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include call flow/dependency notes when True (default).'),
  update_existing: z
    .boolean()
    .optional()
    .default(true)
    .describe('True (default) to polish inaccurate or outdated docs instead of leaving them untouched.'),
  comments_on_complex_logic: z
    .boolean()
    .optional()
    .default(true)
    .describe('True (default) to add inline comments around non-obvious logic.'),
});

export type DocgenInput = z.infer<typeof DocgenInputSchema>;
