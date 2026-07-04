/**
 * D-H2.078 — input-limit regression tests.
 *
 * The 2026-05-04 multi-chat plan (~30K chars) hit the old 20K cap and the
 * planner-session save silently failed at 4K. This file pins the new caps
 * (200K across the board) so future tightening cannot reintroduce the bug
 * without breaking these contracts intentionally.
 *
 * Each schema's "happy" sizes (50K + 150K) verify the user can paste real
 * production-grade plans. The "rejection" sizes (250K) verify the upper
 * bound still defends against accidental megabyte payloads, and the error
 * message check ensures operators get a useful next step (attach-as-file)
 * instead of a generic Zod "String must contain at most X character(s)".
 */

import { describe, expect, it } from 'vitest';

import { PlanDashboardDagSchema } from '../../src/mcp/dashboard-plan-ops.js';
import { RunSingleTaskSchema } from '../../src/mcp/dashboard-single-task-ops.js';
import {
  AdjustDashboardTaskSchema,
  RetryDashboardTaskSchema,
} from '../../src/mcp/dashboard-task-ops.js';
import {
  PlannerMessageSchema,
  PlannerSessionInputSchema,
} from '../../src/mcp/dashboard-planner-sessions.js';
import {
  DashboardAttachmentSchema,
  DashboardAttachmentsListSchema,
  formatAttachmentsForPrompt,
} from '../../src/mcp/dashboard-attachments.js';

const ATTACH_LARGE_THRESHOLD = 30_000; // representative real-world plan size
const KB = 1024;

function repeat(size: number): string {
  // Build a deterministic-but-non-trivial string so Zod's `.length` check
  // operates on real characters (not whitespace getting trimmed away).
  const chunk = 'omniforge-objective-text-block-1234567890.';
  const out: string[] = [];
  let total = 0;
  while (total < size) {
    out.push(chunk);
    total += chunk.length;
  }
  return out.join('').slice(0, size);
}

describe('PlanDashboardDagSchema (objective cap)', () => {
  it('accepts the real-world ~30K multi-chat plan', () => {
    const objective = repeat(ATTACH_LARGE_THRESHOLD);
    const r = PlanDashboardDagSchema.safeParse({ workspace: 'internal', objective });
    expect(r.success).toBe(true);
  });

  it('accepts a 50K objective', () => {
    const r = PlanDashboardDagSchema.safeParse({ workspace: 'internal', objective: repeat(50_000) });
    expect(r.success).toBe(true);
  });

  it('accepts a 150K objective (just under cap)', () => {
    const r = PlanDashboardDagSchema.safeParse({ workspace: 'internal', objective: repeat(150_000) });
    expect(r.success).toBe(true);
  });

  it('accepts feedback up to 80K', () => {
    const r = PlanDashboardDagSchema.safeParse({
      workspace: 'internal',
      objective: repeat(1_000),
      feedback: repeat(80_000),
    });
    expect(r.success).toBe(true);
  });

  it('rejects a 250K objective with an actionable error message', () => {
    const r = PlanDashboardDagSchema.safeParse({ workspace: 'internal', objective: repeat(250_000) });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path[0] === 'objective');
      expect(issue?.message).toMatch(/200,000 characters/);
      expect(issue?.message).toMatch(/attach.*\.md|split/i);
    }
  });

  it('rejects feedback over 80K (still bounded above objective for prompt budget)', () => {
    const r = PlanDashboardDagSchema.safeParse({
      workspace: 'internal',
      objective: repeat(1_000),
      feedback: repeat(80_001),
    });
    expect(r.success).toBe(false);
  });
});

describe('RunSingleTaskSchema (objective cap)', () => {
  it('accepts a 150K Build-mode objective', () => {
    const r = RunSingleTaskSchema.safeParse({
      objective: repeat(150_000),
      mode: 'build',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a 250K objective with a friendly message', () => {
    const r = RunSingleTaskSchema.safeParse({
      objective: repeat(250_000),
      mode: 'build',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path[0] === 'objective');
      expect(issue?.message).toMatch(/200,000 characters/);
    }
  });
});

describe('RetryDashboardTaskSchema (objective cap)', () => {
  it('accepts a 100K retry objective', () => {
    const r = RetryDashboardTaskSchema.safeParse({ objective: repeat(100_000) });
    expect(r.success).toBe(true);
  });

  it('treats objective as optional (back-compat)', () => {
    const r = RetryDashboardTaskSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mode).toBe('downstream');
  });

  it('rejects a 250K retry objective with split-or-trim guidance', () => {
    const r = RetryDashboardTaskSchema.safeParse({ objective: repeat(250_000) });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path[0] === 'objective');
      expect(issue?.message).toMatch(/200,000/);
      expect(issue?.message).toMatch(/trim|split/i);
    }
  });
});

describe('AdjustDashboardTaskSchema (instruction cap)', () => {
  it('accepts a 35K instruction (was 8K — operators paste larger context now)', () => {
    const r = AdjustDashboardTaskSchema.safeParse({ instruction: repeat(35_000) });
    expect(r.success).toBe(true);
  });

  it('rejects a 41K instruction (above the 40K cap)', () => {
    const r = AdjustDashboardTaskSchema.safeParse({ instruction: repeat(41_000) });
    expect(r.success).toBe(false);
  });
});

describe('PlannerSessionInputSchema (objective + message text caps)', () => {
  const baseSession = {
    id: 'session-1',
    title: 'Test session',
    workspace: 'internal',
    messages: [],
    dag: null,
  };

  it('accepts a 150K objective on session save (was capped at 4K — most painful)', () => {
    const r = PlannerSessionInputSchema.safeParse({ ...baseSession, objective: repeat(150_000) });
    expect(r.success).toBe(true);
  });

  it('rejects a 250K objective with friendly guidance', () => {
    const r = PlannerSessionInputSchema.safeParse({ ...baseSession, objective: repeat(250_000) });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path[0] === 'objective');
      expect(issue?.message).toMatch(/200,000/);
    }
  });

  it('PlannerMessageSchema accepts a 150K user message text', () => {
    const r = PlannerMessageSchema.safeParse({
      id: 'msg-1',
      role: 'user',
      text: repeat(150_000),
    });
    expect(r.success).toBe(true);
  });

  it('PlannerMessageSchema rejects a 250K text', () => {
    const r = PlannerMessageSchema.safeParse({
      id: 'msg-1',
      role: 'user',
      text: repeat(250_000),
    });
    expect(r.success).toBe(false);
  });
});

describe('Attachment inline-text caps (raised so plans can be attached as .md)', () => {
  function textAttachment(name: string, sizeBytes: number) {
    const text = repeat(sizeBytes);
    const contentBase64 = Buffer.from(text, 'utf8').toString('base64');
    return {
      name,
      mimeType: 'text/markdown',
      size: Buffer.byteLength(text, 'utf8'),
      contentBase64,
      inlineText: true,
    };
  }

  it('inlines a 30K markdown plan in full (no truncation marker)', () => {
    const att = textAttachment('plan.md', 30 * KB);
    const parsed = DashboardAttachmentSchema.parse(att);
    const out = formatAttachmentsForPrompt([parsed]);
    expect(out).toContain('plan.md');
    expect(out).not.toContain('TRUNCATED');
  });

  it('inlines a 150K markdown plan in full now (was truncated at 16K)', () => {
    const att = textAttachment('big-plan.md', 150 * KB);
    const parsed = DashboardAttachmentSchema.parse(att);
    const out = formatAttachmentsForPrompt([parsed]);
    expect(out).toContain('big-plan.md');
    expect(out).not.toContain('TRUNCATED');
  });

  it('truncates a single 250K file with a clear marker (over per-file cap of 192K)', () => {
    const att = textAttachment('huge.md', 250 * KB);
    const parsed = DashboardAttachmentSchema.parse(att);
    const out = formatAttachmentsForPrompt([parsed]);
    expect(out).toContain('TRUNCATED');
  });

  it('respects the 384K total inline budget across multiple files', () => {
    const a = textAttachment('a.md', 200 * KB); // 200K
    const b = textAttachment('b.md', 200 * KB); // would push past 384K
    const list = DashboardAttachmentsListSchema.parse([a, b]);
    const out = formatAttachmentsForPrompt(list);
    expect(out).toContain('a.md');
    expect(out).toContain('b.md');
    // Either b.md is partially truncated OR surfaced as metadata-only —
    // both indicate the budget was respected (no unbounded prompt blow-up).
    const truncated = out.includes('TRUNCATED') || out.includes('total prompt budget exceeded');
    expect(truncated).toBe(true);
  });
});
