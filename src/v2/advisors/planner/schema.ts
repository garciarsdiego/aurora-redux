// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/planner.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const PlannerInputSchema = z.object({
  step: z
    .string()
    .min(1)
    .describe(
      'Planning content for this step. Step 1: describe the task, problem and scope. Later steps: capture updates, ' +
        'revisions, branches, or open questions that shape the plan.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe('Current planning step number (starts at 1).'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe('Estimated number of planning steps; adjust as the plan evolves.'),
  next_step_required: z
    .boolean()
    .describe('Set true when another planning step will follow after this one.'),
  is_step_revision: z
    .boolean()
    .default(false)
    .describe('Set true when you are replacing a previously recorded step.'),
  revises_step_number: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Step number being replaced when revising.'),
  is_branch_point: z
    .boolean()
    .default(false)
    .describe('True when this step creates a new branch to explore an alternative path.'),
  branch_from_step: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('If branching, the step number that this branch starts from.'),
  branch_id: z
    .string()
    .optional()
    .describe("Name for this branch (e.g. 'approach-A', 'migration-path')."),
  more_steps_needed: z
    .boolean()
    .default(false)
    .describe('True when you now expect to add additional steps beyond the prior estimate.'),
});

export type PlannerInput = z.infer<typeof PlannerInputSchema>;
