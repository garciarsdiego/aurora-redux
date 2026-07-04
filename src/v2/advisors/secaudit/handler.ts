// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/secaudit.py — class SecauditTool
// © BeehiveInnovations — see ../NOTICE.md.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callOmniroute } from '../../../utils/omniroute-call.js';
import { SecauditInputSchema } from './schema.js';
import { SECAUDIT_SYSTEM_PROMPT } from './prompt.js';

function buildUserPrompt(parsed: ReturnType<typeof SecauditInputSchema.parse>): string {
  const lines: string[] = [
    `=== SECURITY AUDIT REQUEST ===`,
    `Step ${parsed.step_number} of ${parsed.total_steps}: ${parsed.step}`,
    `=== END REQUEST ===`,
    ``,
    `=== INVESTIGATION FINDINGS ===`,
    parsed.findings,
    `=== END FINDINGS ===`,
  ];

  if (parsed.security_scope) {
    lines.push(``, `=== SECURITY SCOPE ===`, parsed.security_scope, `=== END SCOPE ===`);
  }

  lines.push(
    ``,
    `=== AUDIT CONFIGURATION ===`,
    `Threat Level: ${parsed.threat_level}`,
    `Audit Focus: ${parsed.audit_focus}`,
    `Severity Filter: ${parsed.severity_filter}`,
    `Confidence: ${parsed.confidence}`,
    `Next Step Required: ${parsed.next_step_required}`,
    `=== END CONFIGURATION ===`,
  );

  if (parsed.compliance_requirements.length > 0) {
    lines.push(
      ``,
      `=== COMPLIANCE REQUIREMENTS ===`,
      parsed.compliance_requirements.map((r) => `- ${r}`).join('\n'),
      `=== END COMPLIANCE ===`,
    );
  }

  if (parsed.relevant_files.length > 0) {
    lines.push(
      ``,
      `=== RELEVANT FILES ===`,
      parsed.relevant_files.map((f) => `- ${f}`).join('\n'),
      `=== END FILES ===`,
    );
  }

  if (parsed.relevant_context.length > 0) {
    lines.push(
      ``,
      `=== SECURITY-CRITICAL CODE ELEMENTS ===`,
      parsed.relevant_context.map((c) => `- ${c}`).join('\n'),
      `=== END CODE ELEMENTS ===`,
    );
  }

  if (parsed.issues_found.length > 0) {
    lines.push(
      ``,
      `=== SECURITY ISSUES IDENTIFIED ===`,
      JSON.stringify(parsed.issues_found, null, 2),
      `=== END ISSUES ===`,
    );
  }

  if (parsed.files_checked.length > 0) {
    lines.push(
      ``,
      `=== FILES CHECKED ===`,
      parsed.files_checked.map((f) => `- ${f}`).join('\n'),
      `=== END FILES CHECKED ===`,
    );
  }

  return lines.join('\n');
}

export const secauditAdvisor: Advisor = {
  name: 'secaudit',
  description:
    'Performs comprehensive security audit with systematic vulnerability assessment. ' +
    'Use for OWASP Top 10 analysis, compliance evaluation, threat modeling, and security architecture review. ' +
    'Guides through structured security investigation with expert validation.',
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = SecauditInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const userPrompt = buildUserPrompt(parsed);
    const text = await callOmniroute({
      systemPrompt: SECAUDIT_SYSTEM_PROMPT,
      userPrompt,
      model: 'cc/claude-sonnet-4-6',
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return { output: text };
  },
};
