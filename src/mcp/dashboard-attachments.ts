// Sprint F4 (D-H2.066): Composer file-upload support.
//
// The dashboard Composer in apps/dashboard-v2 lets the operator drag/drop
// or pick files alongside the objective text. Files are sent client-side
// as base64 (per-file ≤2 MB, total ≤5 MB) inside the plan and single-task
// request bodies.
//
// This module owns:
//
//   1. Zod schema for the wire shape (re-validates client-side caps as
//      defense-in-depth — never trust the client's pre-flight check).
//   2. `formatAttachmentsForPrompt` — produces a markdown-style string
//      section that gets appended to the decomposer's user prompt or to
//      a single-task's user-prompt context. Text-like files have their
//      decoded contents inlined (truncated to keep DAG prompt under
//      token budget); binary files surface as filename + size only.
//   3. Per-file content-decode helper that handles invalid base64
//      gracefully and reports per-file errors instead of failing the
//      whole batch.
//
// Where this is called from:
//   - src/mcp/dashboard-plan-ops.ts (plan endpoint)
//   - src/mcp/dashboard-single-task-ops.ts (single-task endpoint)
//
// Constraints:
//   - 256 KB request-body cap is enforced by readJsonBody — but plan and
//     single-task endpoints use a higher cap via `readLargeJsonBody` to
//     accommodate up to 5 MB of attachments. See routes/_shared.ts.

import { z } from 'zod';

// ── Caps (mirror apps/dashboard-v2/src/chrome/composer-attachments.ts) ──

export const PER_FILE_BYTES_CAP = 2 * 1024 * 1024;
export const TOTAL_BYTES_CAP = 5 * 1024 * 1024;

// Per-attachment inlined-text cap for the prompt. We don't want a single
// 2 MB file to blow up the decomposer's context window — typical
// codebases dropped here are 1-50 KB anyway. Exceeding the cap shows a
// truncation marker so the operator (and the LLM) knows content was
// cut.
//
// D-H2.078: bumped 16K → 192K per file so that operators can drop a
// production-grade plan (e.g. the multi-chat spec ~30K, larger refactor
// briefs 100K+) as a .md attachment instead of pasting into the objective
// field. Decomposer.preHook still trims its own input to 20K before LLM
// dispatch, so oversized attachments do not blow the context window — they
// just stay legible to the operator and to any downstream rendering.
const PROMPT_INLINE_PER_FILE_CAP = 192 * 1024;

// Total inline-text budget across all attachments — caps the prompt
// blow-up even when many small text files are dropped together. Above
// this, additional text-like files surface as metadata only with a
// note.
//
// D-H2.078: bumped 64K → 384K total so attaching the plan + a few
// supporting files (config, README, schema) all fit. Still keeps a hard
// upper bound: with 40 attachment slots × 2 MB raw, the worst-case prompt
// inline is bounded to 384K not the raw 80 MB.
const PROMPT_INLINE_TOTAL_CAP = 384 * 1024;

// ── Wire schema ─────────────────────────────────────────────────────────

/**
 * Zod schema for a single attachment as sent by the dashboard. Frontend
 * caps are re-validated here so a tampered client can't push past them.
 *
 * Filename: max 256 chars, no path separators (we never write these to
 * disk — just include them in prompts — but defense-in-depth).
 */
export const DashboardAttachmentSchema = z.object({
  name: z.string().min(1).max(256).refine(
    (n) => !n.includes('/') && !n.includes('\\') && !n.includes('\0'),
    { message: 'Attachment name cannot contain path separators or null bytes' },
  ),
  mimeType: z.string().min(1).max(200),
  // Daemon-side cap: per-file ≤ PER_FILE_BYTES_CAP. The client-reported
  // size is independently checked against the actual decoded base64
  // length below so a lying client can't sneak a 10 MB file past with a
  // forged size of 100.
  size: z.number().int().min(0).max(PER_FILE_BYTES_CAP),
  // Base64 cap reflects PER_FILE_BYTES_CAP * 4/3 (base64 inflation),
  // plus a small margin for padding and varied alphabets.
  contentBase64: z.string().min(0).max(Math.ceil(PER_FILE_BYTES_CAP * 1.4)),
  inlineText: z.boolean().optional(),
});

export type DashboardAttachment = z.infer<typeof DashboardAttachmentSchema>;

/**
 * Schema for the attachments list. Validates the running total cap.
 * Returns the same shape it accepts so callers can use the parsed
 * value directly.
 */
export const DashboardAttachmentsListSchema = z
  .array(DashboardAttachmentSchema)
  .max(40, 'Too many attachments (max 40 per request)')
  .refine(
    (list) => list.reduce((sum, a) => sum + a.size, 0) <= TOTAL_BYTES_CAP,
    { message: `Total attachment size exceeds 5 MB limit` },
  );

// ── Decode + format helpers ─────────────────────────────────────────────

interface DecodedAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly inlineText: boolean;
  readonly text: string | null;
  readonly decodeError: string | null;
}

/**
 * Decode a single attachment's base64 contents to UTF-8 text, but only
 * when the operator (frontend) marked it as text-like. Binary files
 * skip decoding — we never want to ship a multi-MB raw blob through
 * the prompt path. Decode errors are captured per-file so one
 * corrupt attachment doesn't poison the rest of the batch.
 *
 * Why we double-check size here even after Zod validation: Buffer.from
 * happily decodes a base64 string longer than the declared `size`,
 * which would let a client lie. We compute the actual decoded byte
 * length and reject when it exceeds PER_FILE_BYTES_CAP regardless of
 * the size the client sent.
 */
function decodeAttachment(att: DashboardAttachment): DecodedAttachment {
  if (!att.inlineText) {
    return {
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
      inlineText: false,
      text: null,
      decodeError: null,
    };
  }

  try {
    const buf = Buffer.from(att.contentBase64, 'base64');
    if (buf.byteLength > PER_FILE_BYTES_CAP) {
      return {
        name: att.name,
        mimeType: att.mimeType,
        size: att.size,
        inlineText: true,
        text: null,
        decodeError: `Decoded content exceeds 2 MB per-file limit (${buf.byteLength} bytes)`,
      };
    }
    // Toleramos UTF-8 inválido — Buffer.toString('utf8') substitui sequências
    // malformadas pelo replacement char (U+FFFD) ao invés de lançar.
    return {
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
      inlineText: true,
      text: buf.toString('utf8'),
      decodeError: null,
    };
  } catch (err) {
    return {
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
      inlineText: true,
      text: null,
      decodeError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Format the attachments into a markdown-style block ready to append
 * to the decomposer's (or single-task's) user prompt.
 *
 * Returns the empty string when there are no attachments — caller can
 * unconditionally concatenate the result without growing the prompt.
 *
 * Shape:
 *
 *   ATTACHMENTS:
 *   The operator attached <N> file(s) along with the objective. Treat
 *   their contents as additional context — the objective remains the
 *   primary instruction.
 *
 *   --- file: example.md (1.2 KB, text/markdown) ---
 *   <inlined utf-8 contents, truncated at PROMPT_INLINE_PER_FILE_CAP>
 *   --- end of example.md ---
 *
 *   --- file: logo.png (45 KB, image/png) ---
 *   (binary — content not inlined; 46123 bytes available on disk if needed)
 *   --- end of logo.png ---
 */
export function formatAttachmentsForPrompt(
  attachments: readonly DashboardAttachment[],
): string {
  if (attachments.length === 0) return '';

  const decoded = attachments.map(decodeAttachment);
  let inlinedTotal = 0;
  const sections: string[] = [];

  for (const d of decoded) {
    const sizeStr = formatBytesServer(d.size);
    const header = `--- file: ${d.name} (${sizeStr}, ${d.mimeType}) ---`;
    const footer = `--- end of ${d.name} ---`;

    if (d.decodeError) {
      sections.push(
        [
          header,
          `(decode error — content not inlined; reason: ${d.decodeError})`,
          footer,
        ].join('\n'),
      );
      continue;
    }

    if (d.inlineText && d.text !== null) {
      const remainingBudget = PROMPT_INLINE_TOTAL_CAP - inlinedTotal;
      if (remainingBudget <= 0) {
        sections.push(
          [
            header,
            `(text content not inlined — total prompt budget exceeded; ${d.size} bytes available on disk if referenced)`,
            footer,
          ].join('\n'),
        );
        continue;
      }
      const perFileCap = Math.min(PROMPT_INLINE_PER_FILE_CAP, remainingBudget);
      const truncated = d.text.length > perFileCap;
      const body = truncated
        ? `${d.text.slice(0, perFileCap)}\n\n... [TRUNCATED — ${d.text.length - perFileCap} more characters not shown]`
        : d.text;
      inlinedTotal += truncated ? perFileCap : d.text.length;
      sections.push([header, body, footer].join('\n'));
    } else {
      sections.push(
        [
          header,
          `(binary — content not inlined; ${d.size} bytes available on disk if needed)`,
          footer,
        ].join('\n'),
      );
    }
  }

  const intro = [
    'ATTACHMENTS:',
    `The operator attached ${attachments.length} file(s) along with the objective. Treat`,
    'their contents as additional context — the objective remains the primary instruction.',
    '',
  ].join('\n');

  return `\n\n${intro}${sections.join('\n\n')}`;
}

function formatBytesServer(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
