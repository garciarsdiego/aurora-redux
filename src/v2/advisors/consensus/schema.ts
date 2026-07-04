// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/consensus.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

const ModelConfigSchema = z.object({
  model: z.string().describe('Model identifier to consult'),
  stance: z.enum(['for', 'against', 'neutral']).default('neutral').describe('Perspective stance for this model'),
  stance_prompt: z.string().optional().describe('Custom stance instructions (overrides built-in stance prompt)'),
});

export const ConsensusInputSchema = z.object({
  step: z
    .string()
    .min(1)
    .describe(
      "Consensus prompt. Step 1: write the exact proposal/question every model will see (use 'Evaluate…', not meta commentary). " +
        'Steps 2+: capture internal notes about the latest model response—these notes are NOT sent to other models.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe('Current step index (starts at 1). Step 1 is your analysis; steps 2+ handle each model response.'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe('Total steps = number of models consulted plus the final synthesis step.'),
  next_step_required: z
    .boolean()
    .describe('True if more model consultations remain; set false when ready to synthesize.'),
  findings: z
    .string()
    .describe(
      'Step 1: your independent analysis for later synthesis (not shared with other models). Steps 2+: summarize the newest model response.',
    ),
  models: z
    .array(ModelConfigSchema)
    .min(2)
    .optional()
    .describe(
      'User-specified list of models to consult (provide at least two entries). ' +
        'Each entry may include model, stance (for/against/neutral), and stance_prompt. ' +
        "Each (model, stance) pair must be unique, e.g. [{'model':'gpt5','stance':'for'}, {'model':'pro','stance':'against'}].",
    ),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe('Optional supporting files that help the consensus analysis. Must be absolute full, non-abbreviated paths.'),
  current_model_index: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('0-based index of the next model to consult (managed internally).'),
  model_responses: z
    .array(z.record(z.string(), z.unknown()))
    .default([])
    .describe('Internal log of responses gathered so far.'),
  images: z
    .array(z.string())
    .optional()
    .describe('Optional absolute image paths or base64 references that add helpful visual context.'),
});

export type ConsensusInput = z.infer<typeof ConsensusInputSchema>;
