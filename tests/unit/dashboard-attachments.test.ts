// Sprint F4 (D-H2.066): tests for the file-upload helpers used by the
// dashboard Composer. Covers schema validation (per-file/total caps,
// path-traversal guards), per-attachment decoding, and the formatted
// prompt block shape that gets appended to the decomposer's user prompt.

import { describe, expect, it } from 'vitest';
import {
  DashboardAttachmentSchema,
  DashboardAttachmentsListSchema,
  formatAttachmentsForPrompt,
  PER_FILE_BYTES_CAP,
  TOTAL_BYTES_CAP,
} from '../../src/mcp/dashboard-attachments.js';

const helloBase64 = Buffer.from('hello world', 'utf8').toString('base64');

describe('DashboardAttachmentSchema', () => {
  it('accepts a small text-like attachment', () => {
    const result = DashboardAttachmentSchema.safeParse({
      name: 'note.md',
      mimeType: 'text/markdown',
      size: 11,
      contentBase64: helloBase64,
      inlineText: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a name with a path separator', () => {
    const result = DashboardAttachmentSchema.safeParse({
      name: '../etc/passwd',
      mimeType: 'text/plain',
      size: 5,
      contentBase64: 'aGVsbG8=',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('path separators');
    }
  });

  it('rejects a name with a backslash', () => {
    const result = DashboardAttachmentSchema.safeParse({
      name: 'C:\\windows\\system32\\evil.exe',
      mimeType: 'application/octet-stream',
      size: 5,
      contentBase64: 'aGVsbG8=',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a per-file size above the cap', () => {
    const result = DashboardAttachmentSchema.safeParse({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      size: PER_FILE_BYTES_CAP + 1,
      contentBase64: 'aGVsbG8=',
    });
    expect(result.success).toBe(false);
  });
});

describe('DashboardAttachmentsListSchema', () => {
  it('accepts a small list', () => {
    const result = DashboardAttachmentsListSchema.safeParse([
      { name: 'a.txt', mimeType: 'text/plain', size: 11, contentBase64: helloBase64, inlineText: true },
      { name: 'b.txt', mimeType: 'text/plain', size: 11, contentBase64: helloBase64, inlineText: true },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects total size above the cap', () => {
    // 4 files of just under 2 MB each = ~7.5 MB total, over the 5 MB cap.
    const big = 'A'.repeat(PER_FILE_BYTES_CAP - 1);
    const items = Array.from({ length: 4 }, (_, i) => ({
      name: `f${i}.bin`,
      mimeType: 'application/octet-stream',
      size: PER_FILE_BYTES_CAP - 1,
      contentBase64: Buffer.from(big).toString('base64'),
    }));
    const result = DashboardAttachmentsListSchema.safeParse(items);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toContain('5 MB');
    }
  });

  it('caps at 40 attachments per request', () => {
    const items = Array.from({ length: 41 }, (_, i) => ({
      name: `f${i}.txt`,
      mimeType: 'text/plain',
      size: 5,
      contentBase64: 'aGVsbG8=',
    }));
    const result = DashboardAttachmentsListSchema.safeParse(items);
    expect(result.success).toBe(false);
  });

  it('exposes the documented total byte cap', () => {
    expect(TOTAL_BYTES_CAP).toBe(5 * 1024 * 1024);
    expect(PER_FILE_BYTES_CAP).toBe(2 * 1024 * 1024);
  });
});

describe('formatAttachmentsForPrompt', () => {
  it('returns the empty string when no attachments are present', () => {
    expect(formatAttachmentsForPrompt([])).toBe('');
  });

  it('inlines text-like file contents', () => {
    const out = formatAttachmentsForPrompt([
      {
        name: 'spec.md',
        mimeType: 'text/markdown',
        size: 11,
        contentBase64: helloBase64,
        inlineText: true,
      },
    ]);
    expect(out).toContain('ATTACHMENTS:');
    expect(out).toContain('--- file: spec.md');
    expect(out).toContain('hello world');
    expect(out).toContain('--- end of spec.md ---');
  });

  it('surfaces binary files as metadata only', () => {
    const out = formatAttachmentsForPrompt([
      {
        name: 'logo.png',
        mimeType: 'image/png',
        size: 4096,
        contentBase64: 'AQID',
      },
    ]);
    expect(out).toContain('--- file: logo.png');
    expect(out).toContain('binary — content not inlined');
    expect(out).not.toContain('AQID');
  });

  it('truncates oversized text content with a marker', () => {
    // D-H2.078: per-file inline cap raised 16K → 192K so plans-as-attachments
    // (multi-chat spec ~30K) no longer truncate. We now need a >192K file to
    // trigger the truncation marker — anything below the new cap is preserved.
    const big = 'A'.repeat(250 * 1024); // 250 KB > 192 KB cap
    const out = formatAttachmentsForPrompt([
      {
        name: 'huge.txt',
        mimeType: 'text/plain',
        size: big.length,
        contentBase64: Buffer.from(big).toString('base64'),
        inlineText: true,
      },
    ]);
    expect(out).toContain('TRUNCATED');
    // Should NOT contain the full original string length of As
    const matches = out.match(/A/g);
    expect(matches).not.toBeNull();
    if (matches) expect(matches.length).toBeLessThan(big.length);
  });

  it('formats sizes in human-friendly units', () => {
    const out = formatAttachmentsForPrompt([
      {
        name: 'mid.txt',
        mimeType: 'text/plain',
        size: 2048,
        contentBase64: helloBase64,
        inlineText: true,
      },
    ]);
    expect(out).toContain('2 KB');
  });
});
