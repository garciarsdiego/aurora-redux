// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/analyze.py — class AnalyzeTool
// © BeehiveInnovations — see ../NOTICE.md.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callAdvisorLlm } from '../shared/llm.js';
import { AnalyzeInputSchema, type AnalyzeInput } from './schema.js';
import { ANALYZE_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Performs comprehensive code analysis with systematic investigation and expert validation. ' +
  'Use for architecture, performance, maintainability, and pattern analysis. ' +
  'Guides through structured code review and strategic planning.';

function buildUserPrompt(parsed: AnalyzeInput): string {
  const lines: string[] = [
    `=== ANALYZE WORKFLOW — STEP ${parsed.step_number} of ${parsed.total_steps} ===`,
    `Analysis Type: ${parsed.analysis_type}`,
    `Output Format: ${parsed.output_format}`,
    `Confidence: ${parsed.confidence}`,
    `Next Step Required: ${parsed.next_step_required}`,
    '',
    '=== STEP PLAN ===',
    parsed.step,
    '',
    '=== FINDINGS SO FAR ===',
    parsed.findings,
  ];

  if (parsed.files_checked.length > 0) {
    lines.push('', '=== FILES CHECKED ===', parsed.files_checked.join('\n'));
  }

  if (parsed.relevant_files.length > 0) {
    lines.push('', '=== RELEVANT FILES ===', parsed.relevant_files.join('\n'));
  }

  if (parsed.relevant_context.length > 0) {
    lines.push('', '=== RELEVANT CONTEXT ===', parsed.relevant_context.join('\n'));
  }

  if (parsed.issues_found.length > 0) {
    lines.push('', '=== ISSUES FOUND ===', JSON.stringify(parsed.issues_found, null, 2));
  }

  if (parsed.images && parsed.images.length > 0) {
    lines.push('', '=== VISUAL REFERENCES ===', parsed.images.join('\n'));
  }

  return lines.join('\n');
}

export const analyzeAdvisor: Advisor = {
  name: 'analyze',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = AnalyzeInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const userPrompt = buildUserPrompt(parsed);
    const text = await callAdvisorLlm(ctx, {
      systemPrompt: ANALYZE_SYSTEM_PROMPT,
      userPrompt,
    });
    return { output: text };
  },
};
