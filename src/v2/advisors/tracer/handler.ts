// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/tracer.py — class TracerTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// Notable simplifications vs the Python source:
// - PAL's WorkflowTool stores work_history, consolidated_findings, and pause/resume MCP responses.
//   Omniforge keeps this advisor stateless: each call forwards step context via callOmniroute.
// - Expert analysis hooks are disabled upstream; this matches PAL's tracer (self-contained LLM workflow).

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callAdvisorLlm } from '../shared/llm.js';
import { TracerInputSchema, type TracerInput } from './schema.js';
import { TRACER_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Performs systematic code tracing with modes for execution flow or dependency mapping. ' +
  'Use for method execution analysis, call chain tracing, dependency mapping, and architectural understanding. ' +
  'Supports precision mode (execution flow) and dependencies mode (structural relationships).';

function buildUserPrompt(parsed: TracerInput): string {
  const lines: string[] = [];

  lines.push(`=== TRACING STEP ${parsed.step_number} of ${parsed.total_steps} ===`);
  lines.push(`Trace mode: ${parsed.trace_mode}`);
  if (parsed.target_description)
    lines.push(`Target description: ${parsed.target_description}`);
  lines.push(`Confidence: ${parsed.confidence}`);
  lines.push(`Next step required: ${parsed.next_step_required}`);
  lines.push('');
  lines.push(`=== STEP NARRATIVE ===`);
  lines.push(parsed.step);
  lines.push('');
  lines.push(`=== FINDINGS ===`);
  lines.push(parsed.findings);

  if (parsed.files_checked.length > 0) {
    lines.push('');
    lines.push('=== FILES CHECKED ===');
    parsed.files_checked.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.relevant_files.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT FILES ===');
    parsed.relevant_files.forEach((f) => lines.push(`- ${f}`));
  }

  if (parsed.relevant_context.length > 0) {
    lines.push('');
    lines.push('=== RELEVANT CODE ELEMENTS ===');
    parsed.relevant_context.forEach((c) => lines.push(`- ${c}`));
  }

  if (parsed.images && parsed.images.length > 0) {
    lines.push('');
    lines.push('=== VISUAL CONTEXT ===');
    parsed.images.forEach((img) => lines.push(`- ${img}`));
  }

  return lines.join('\n');
}

export const tracerAdvisor: Advisor = {
  name: 'tracer',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = TracerInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const userPrompt = buildUserPrompt(parsed);
    const text = await callAdvisorLlm(ctx, {
      systemPrompt: TRACER_SYSTEM_PROMPT,
      userPrompt,
    });
    return { output: text };
  },
};
