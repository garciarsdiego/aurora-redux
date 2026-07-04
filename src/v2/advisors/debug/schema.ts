// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server tools/debug.py — class DebugIssueTool
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const DebugInputSchema = z.object({
  step: z
    .string()
    .describe(
      'Investigation step. Step 1: State issue+direction. ' +
        "Symptoms misleading; 'no bug' valid. Trace dependencies, verify hypotheses. " +
        'Use relevant_files for code; this for text only.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe('Current step index (starts at 1). Build upon previous steps.'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe(
      'Estimated total steps needed to complete the investigation. Adjust as new findings emerge. ' +
        'IMPORTANT: When continuation_id is provided (continuing a previous conversation), set this to 1 as we are not starting a new multi-step investigation.',
    ),
  next_step_required: z
    .boolean()
    .describe(
      'True if you plan to continue the investigation with another step. False means root cause is known or investigation is complete. ' +
        'IMPORTANT: When continuation_id is provided (continuing a previous conversation), set this to False to immediately proceed with expert analysis.',
    ),
  findings: z
    .string()
    .describe(
      'Discoveries: clues, code/log evidence, disproven theories. Be specific. ' +
        'If no bug found, document clearly as valid.',
    ),
  files_checked: z
    .array(z.string())
    .default([])
    .describe('All examined files (absolute paths), including ruled-out ones.'),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe('Files directly relevant to issue (absolute paths). Cause, trigger, or manifestation locations.'),
  relevant_context: z
    .array(z.string())
    .default([])
    .describe("Methods/functions central to issue: 'Class.method' or 'function'. Focus on inputs/branching/state."),
  hypothesis: z
    .string()
    .optional()
    .describe(
      'Concrete root cause theory from evidence. Can revise. ' +
        "Valid: 'No bug found - user misunderstanding' or 'Symptoms unrelated to code' if supported.",
    ),
  confidence: z
    .enum(['exploring', 'low', 'medium', 'high', 'very_high', 'almost_certain', 'certain'])
    .default('low')
    .describe(
      'Your confidence in the hypothesis: exploring (starting out), low (early idea), medium (some evidence), ' +
        'high (strong evidence), very_high (very strong evidence), almost_certain (nearly confirmed), ' +
        'certain (100% confidence - root cause and fix are both confirmed locally with no need for external validation). ' +
        "WARNING: Do NOT use 'certain' unless the issue can be fully resolved with a fix, use 'very_high' or 'almost_certain' instead when not 100% sure. " +
        "Using 'certain' means you have ABSOLUTE confidence locally and PREVENTS external model validation.",
    ),
  images: z
    .array(z.string())
    .optional()
    .describe('Optional screenshots/visuals clarifying issue (absolute paths).'),
});

export type DebugInput = z.infer<typeof DebugInputSchema>;
