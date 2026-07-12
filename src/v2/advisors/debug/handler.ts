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

import type {
  Advisor,
  AdvisorContext,
  AdvisorResult,
  StepwiseAdvisorResult,
} from '../types.js';
import { shouldUseStepwiseMemory } from '../shared/mode.js';
import { runStepwiseAdvisor, type StepwisePromptExtras } from '../shared/stepwisePrompt.js';
import { DebugInputSchema, type DebugInput } from './schema.js';
import { DEBUG_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Performs systematic debugging and root cause analysis for any type of issue. ' +
  'Use for complex bugs, mysterious errors, performance issues, race conditions, memory leaks, and integration problems. ' +
  'Guides through structured investigation with hypothesis testing and expert analysis.';

function buildUserPrompt(parsed: DebugInput, extras?: StepwisePromptExtras): string {
  const lines: string[] = [];

  if (extras?.priorOutputsBlock) {
    lines.push('=== PRIOR STEP OUTPUTS (same conversation) ===');
    lines.push(extras.priorOutputsBlock);
    lines.push('');
  }

  lines.push(`=== DEBUG INVESTIGATION STEP ${parsed.step_number} of ${parsed.total_steps} ===`);
  lines.push(`Confidence: ${parsed.confidence}`);
  lines.push('');
  lines.push('=== STEP NARRATIVE ===');
  lines.push(parsed.step);
  lines.push('');
  lines.push('=== FINDINGS SO FAR ===');
  lines.push(parsed.findings);

  if (parsed.hypothesis) {
    lines.push('');
    lines.push('=== CURRENT HYPOTHESIS ===');
    lines.push(parsed.hypothesis);
  }

  if (parsed.relevant_files.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT FILES ===');
    parsed.relevant_files.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.files_checked.length > 0) {
    lines.push('');
    lines.push('=== FILES CHECKED ===');
    parsed.files_checked.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.relevant_context.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT METHODS/FUNCTIONS ===');
    parsed.relevant_context.forEach((c) => lines.push(`- ${c}`));
  }

  if (parsed.images && parsed.images.length > 0) {
    lines.push('');
    lines.push('=== VISUAL DEBUGGING INFORMATION ===');
    parsed.images.forEach((img) => lines.push(`- ${img}`));
  }

  lines.push('');
  lines.push(`next_step_required: ${parsed.next_step_required}`);

  return lines.join('\n');
}

export const debugAdvisor: Advisor = {
  name: 'debug',
  description: DESCRIPTION,
  isStepwise: true,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult | StepwiseAdvisorResult> {
    const parsed = DebugInputSchema.parse(args);
    return runStepwiseAdvisor(ctx, {
      advisorName: 'debug',
      systemPrompt: DEBUG_SYSTEM_PROMPT,
      useStepwiseMemory: shouldUseStepwiseMemory(ctx, args),
      buildUserPrompt: (extras) => buildUserPrompt(parsed, extras),
    });
  },
};
