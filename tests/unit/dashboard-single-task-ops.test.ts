// Sprint F4 (D-H2.066): smoke tests for the single-task runner that
// powers Build / Discuss modes in the dashboard Composer.
//
// These tests exercise the input validation surface (Zod schema) WITHOUT
// hitting the runWorkflowTool path (which would require a live daemon
// stack + Omniroute). The DAG synthesis logic is the load-bearing bit
// here — runDashboardDag itself is covered elsewhere.

import { describe, expect, it } from 'vitest';
import { RunSingleTaskSchema } from '../../src/mcp/dashboard-single-task-ops.js';

describe('RunSingleTaskSchema', () => {
  it('accepts a minimal build request', () => {
    const result = RunSingleTaskSchema.safeParse({
      objective: 'Write a haiku about closures',
      mode: 'build',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a minimal discuss request', () => {
    const result = RunSingleTaskSchema.safeParse({
      objective: 'What is async/await in JS?',
      mode: 'discuss',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown mode', () => {
    const result = RunSingleTaskSchema.safeParse({
      objective: 'test',
      mode: 'plan', // Plan mode goes through the regular plan flow
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty objective', () => {
    const result = RunSingleTaskSchema.safeParse({
      objective: '',
      mode: 'build',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an objective longer than the cap', () => {
    // D-H2.078: cap raised 20K → 200K so production-grade plans (the 2026-05-04
    // multi-chat spec was ~30K and hit the old wall) go through. Reject test
    // shifted to 200,001 chars to keep verifying the upper bound exists.
    const result = RunSingleTaskSchema.safeParse({
      objective: 'a'.repeat(200_001),
      mode: 'discuss',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional taskModel hint', () => {
    const result = RunSingleTaskSchema.safeParse({
      objective: 'do thing',
      mode: 'build',
      taskModel: 'cli:claude-code',
    });
    expect(result.success).toBe(true);
  });

  it('accepts an attachments array within caps', () => {
    const helloBase64 = Buffer.from('hello').toString('base64');
    const result = RunSingleTaskSchema.safeParse({
      objective: 'do thing',
      mode: 'discuss',
      attachments: [
        {
          name: 'note.md',
          mimeType: 'text/markdown',
          size: 5,
          contentBase64: helloBase64,
          inlineText: true,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid workspace name when explicitly provided', () => {
    const result = RunSingleTaskSchema.safeParse({
      workspace: 'has spaces',
      objective: 'do thing',
      mode: 'build',
    });
    expect(result.success).toBe(false);
  });
});
