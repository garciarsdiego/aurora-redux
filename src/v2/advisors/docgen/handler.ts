// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/docgen.py — class DocgenTool
// © BeehiveInnovations — see ../NOTICE.md.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callAdvisorLlm } from '../shared/llm.js';
import { DocgenInputSchema, type DocgenInput } from './schema.js';
import { DOCGEN_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Generates comprehensive code documentation with systematic analysis of functions, classes, and complexity. ' +
  'Use for documentation generation, code analysis, complexity assessment, and API documentation. ' +
  'Analyzes code structure and patterns to create thorough documentation.';

function buildUserPrompt(parsed: DocgenInput): string {
  return JSON.stringify(
    {
      step: parsed.step,
      step_number: parsed.step_number,
      total_steps: parsed.total_steps,
      next_step_required: parsed.next_step_required,
      findings: parsed.findings,
      relevant_files: parsed.relevant_files,
      relevant_context: parsed.relevant_context,
      num_files_documented: parsed.num_files_documented,
      total_files_to_document: parsed.total_files_to_document,
      document_complexity: parsed.document_complexity,
      document_flow: parsed.document_flow,
      update_existing: parsed.update_existing,
      comments_on_complex_logic: parsed.comments_on_complex_logic,
    },
    null,
    2,
  );
}

export const docgenAdvisor: Advisor = {
  name: 'docgen',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = DocgenInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const userPrompt = buildUserPrompt(parsed);
    const text = await callAdvisorLlm(ctx, {
      systemPrompt: DOCGEN_SYSTEM_PROMPT,
      userPrompt,
    });
    return { output: text };
  },
};
