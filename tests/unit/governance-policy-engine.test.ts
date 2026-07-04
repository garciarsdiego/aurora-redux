import { describe, it, expect } from 'vitest';
import {
  evaluateToolPolicy,
  parseToolPolicySpec,
} from '../../src/v2/governance/policy-engine.js';

describe('governance policy engine', () => {
  it('allows tools present in an explicit allowlist', () => {
    const policy = parseToolPolicySpec({
      tools: { allowed: ['file-read', 'file-write'] },
    });

    const decision = evaluateToolPolicy(policy, {
      toolName: 'file-read',
      workspace: 'internal',
      workflowId: 'wf_1',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed_by_policy');
  });

  it('denies tools outside an explicit allowlist', () => {
    const policy = parseToolPolicySpec({
      tools: { allowed: ['file-read'] },
    });

    const decision = evaluateToolPolicy(policy, {
      toolName: 'bash',
      workspace: 'internal',
      workflowId: 'wf_1',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('not in allowed tools');
  });

  it('denies tools listed in denylist even when the allowlist is broad', () => {
    const policy = parseToolPolicySpec({
      tools: { allowed: ['*'], denied: ['bash'] },
    });

    const decision = evaluateToolPolicy(policy, {
      toolName: 'bash',
      workspace: 'internal',
      workflowId: 'wf_1',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('denied by policy');
  });

  it('requires human approval for sensitive tools when policy says so', () => {
    const policy = parseToolPolicySpec({
      tools: { allowed: ['file-write'], require_approval_for: ['file-write'] },
    });

    const decision = evaluateToolPolicy(policy, {
      toolName: 'file-write',
      workspace: 'internal',
      workflowId: 'wf_1',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toContain('requires human approval');
  });

  it('fails closed for malformed policy specs', () => {
    expect(() =>
      parseToolPolicySpec({ tools: { allowed: 'file-read' } }),
    ).toThrow(/policy/i);
  });
});
