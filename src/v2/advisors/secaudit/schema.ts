// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server@7afc7c1 tools/secaudit.py
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

export const SecauditInputSchema = z.object({
  step: z
    .string()
    .describe(
      'Step 1: outline the audit strategy (OWASP Top 10, auth, validation, etc.). Later steps: report findings. MANDATORY: use `relevant_files` for code references and avoid large snippets.',
    ),
  step_number: z
    .number()
    .int()
    .min(1)
    .describe('Current security-audit step number (starts at 1).'),
  total_steps: z
    .number()
    .int()
    .min(1)
    .describe('Expected number of audit steps; adjust as new risks surface.'),
  next_step_required: z
    .boolean()
    .describe(
      'True while additional threat analysis remains; set False once you are ready to hand off for validation.',
    ),
  findings: z
    .string()
    .describe(
      'Summarize vulnerabilities, auth issues, validation gaps, compliance notes, and positives; update prior findings as needed.',
    ),
  files_checked: z
    .array(z.string())
    .default([])
    .describe('Absolute paths for every file inspected, including rejected candidates.'),
  relevant_files: z
    .array(z.string())
    .default([])
    .describe('Absolute paths for security-relevant files (auth modules, configs, sensitive code).'),
  relevant_context: z
    .array(z.string())
    .default([])
    .describe("Security-critical classes/methods (e.g. 'AuthService.login', 'encryption_helper')."),
  issues_found: z
    .array(z.record(z.string(), z.unknown()))
    .default([])
    .describe(
      'Security issues with severity (critical/high/medium/low) and descriptions (vulns, auth flaws, injection, crypto, config).',
    ),
  confidence: z
    .enum(['exploring', 'low', 'medium', 'high', 'very_high', 'almost_certain', 'certain'])
    .default('low')
    .describe(
      "exploring/low/medium/high/very_high/almost_certain/certain. 'certain' blocks external validation—use only when fully complete.",
    ),
  images: z
    .array(z.string())
    .optional()
    .describe('Optional absolute paths to diagrams or threat models that inform the audit.'),
  security_scope: z
    .string()
    .optional()
    .describe(
      'Security context (web, mobile, API, cloud, etc.) including stack, user types, data sensitivity, and threat landscape.',
    ),
  threat_level: z
    .enum(['low', 'medium', 'high', 'critical'])
    .default('medium')
    .describe(
      'Assess the threat level: low (internal/low-risk), medium (customer-facing/business data), high (regulated or sensitive), critical (financial/healthcare/PII).',
    ),
  compliance_requirements: z
    .array(z.string())
    .default([])
    .describe(
      'Applicable compliance frameworks or standards (SOC2, PCI DSS, HIPAA, GDPR, ISO 27001, NIST, etc.).',
    ),
  audit_focus: z
    .enum(['owasp', 'compliance', 'infrastructure', 'dependencies', 'comprehensive'])
    .default('comprehensive')
    .describe('Primary focus area: owasp, compliance, infrastructure, dependencies, or comprehensive.'),
  severity_filter: z
    .enum(['critical', 'high', 'medium', 'low', 'all'])
    .default('all')
    .describe('Minimum severity to include when reporting security issues.'),
});

export type SecauditInput = z.infer<typeof SecauditInputSchema>;
