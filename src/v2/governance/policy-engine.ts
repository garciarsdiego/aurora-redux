import { z } from 'zod';

const ToolPolicyListSchema = z.array(z.string().min(1)).default([]);

export const ToolPolicySpecSchema = z.object({
  tools: z.object({
    allowed: ToolPolicyListSchema.optional(),
    denied: ToolPolicyListSchema.optional(),
    require_approval_for: ToolPolicyListSchema.optional(),
  }).optional().default({}),
}).passthrough();

export type ToolPolicySpec = z.infer<typeof ToolPolicySpecSchema>;

export interface ToolPolicySubject {
  toolName: string;
  workspace: string;
  workflowId: string;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
  requiresApproval?: boolean;
}

export function parseToolPolicySpec(raw: unknown): ToolPolicySpec {
  const parsed = ToolPolicySpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid governance policy: ${parsed.error.message}`);
  }
  return parsed.data;
}

function listContains(list: readonly string[] | undefined, value: string): boolean {
  return Boolean(list?.includes('*') || list?.includes(value));
}

export function evaluateToolPolicy(
  policy: ToolPolicySpec,
  subject: ToolPolicySubject,
): ToolPolicyDecision {
  const tools = policy.tools ?? {};
  if (listContains(tools.denied, subject.toolName)) {
    return {
      allowed: false,
      reason: `tool '${subject.toolName}' denied by policy`,
    };
  }

  if (tools.allowed && tools.allowed.length > 0 && !listContains(tools.allowed, subject.toolName)) {
    return {
      allowed: false,
      reason: `tool '${subject.toolName}' not in allowed tools for this policy`,
    };
  }

  if (listContains(tools.require_approval_for, subject.toolName)) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: `tool '${subject.toolName}' requires human approval by policy`,
    };
  }

  return {
    allowed: true,
    reason: 'allowed_by_policy',
  };
}
