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
// Source: pal-mcp-server tools/testgen.py — class TestGenTool
// © BeehiveInnovations — see ../NOTICE.md.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callAdvisorLlm } from '../shared/llm.js';
import { TestgenInputSchema, type TestgenInput } from './schema.js';
import { TESTGEN_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Creates comprehensive test suites with edge case coverage for specific functions, classes, or modules. ' +
  'Analyzes code paths, identifies failure modes, and generates framework-specific tests. ' +
  'Be specific about scope - target particular components rather than testing everything.';

function buildUserPrompt(parsed: TestgenInput): string {
  const lines: string[] = [];

  lines.push(`=== TEST GENERATION STEP ${parsed.step_number} of ${parsed.total_steps} ===`);
  lines.push(`Confidence: ${parsed.confidence}`);
  lines.push('');
  lines.push('=== STEP NARRATIVE ===');
  lines.push(parsed.step);
  lines.push('');
  lines.push('=== FINDINGS SO FAR ===');
  lines.push(parsed.findings);

  if (parsed.relevant_files.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT FILES (require new/updated tests) ===');
    parsed.relevant_files.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.files_checked.length > 0) {
    lines.push('');
    lines.push('=== FILES CHECKED ===');
    parsed.files_checked.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.relevant_context.length > 0) {
    lines.push('');
    lines.push('=== CODE ELEMENTS TO TEST ===');
    parsed.relevant_context.forEach((c) => lines.push(`- ${c}`));
  }

  if (parsed.images && parsed.images.length > 0) {
    lines.push('');
    lines.push('=== VISUAL DOCUMENTATION ===');
    parsed.images.forEach((img) => lines.push(`- ${img}`));
  }

  lines.push('');
  lines.push(`next_step_required: ${parsed.next_step_required}`);

  return lines.join('\n');
}

export const testgenAdvisor: Advisor = {
  name: 'testgen',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = TestgenInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const userPrompt = buildUserPrompt(parsed);
    const text = await callAdvisorLlm(ctx, {
      systemPrompt: TESTGEN_SYSTEM_PROMPT,
      userPrompt,
      model: parsed.model,
    });
    return { output: text };
  },
};
