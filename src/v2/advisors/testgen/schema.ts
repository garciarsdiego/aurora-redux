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
// Source: pal-mcp-server tools/testgen.py — TestGenRequest
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const TestgenInputSchema = z.object({
  step: z
    .string()
    .min(1)
    .describe(
      'Test plan for this step. Step 1: outline how you will analyse structure, business logic, critical paths, and edge cases. Later steps: record findings and new scenarios as they emerge.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe('Current test-generation step (starts at 1) — each step should build on prior work.'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe('Estimated number of steps needed for test planning; adjust as new scenarios appear.'),
  next_step_required: z
    .boolean()
    .describe(
      'True while more investigation or planning remains; set False when test planning is ready for expert validation.',
    ),
  findings: z
    .string()
    .describe(
      'Summarise functionality, critical paths, edge cases, boundary conditions, error handling, and existing test patterns. Cover both happy and failure paths.',
    ),
  files_checked: z
    .array(z.string())
    .default([])
    .describe('Absolute paths of every file examined, including those ruled out.'),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe(
      'Absolute paths of code that requires new or updated tests (implementation, dependencies, existing test fixtures).',
    ),
  relevant_context: z
    .array(z.string())
    .default([])
    .describe(
      "Functions/methods needing coverage (e.g. 'Class.method', 'function_name'), with emphasis on critical paths and error-prone code.",
    ),
  confidence: z
    .enum(['exploring', 'low', 'medium', 'high', 'very_high', 'almost_certain', 'certain'])
    .default('low')
    .describe(
      "Indicate your current confidence in the test generation assessment. Use: 'exploring' (starting analysis), 'low' (early investigation), 'medium' (some patterns identified), 'high' (strong understanding), 'very_high' (very strong understanding), 'almost_certain' (nearly complete test plan), 'certain' (100% confidence - test plan is thoroughly complete and all test scenarios are identified with no need for external model validation). Do NOT use 'certain' unless the test generation analysis is comprehensively complete.",
    ),
  images: z
    .array(z.string())
    .optional()
    .describe('Optional absolute paths to diagrams or visuals that clarify the system under test.'),
  model: z.string().optional().describe('Optional model override for the LLM call.'),
});

export type TestgenInput = z.infer<typeof TestgenInputSchema>;
