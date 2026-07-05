// Aurora-Redux — Fase A / Wave 1 (visual reviewer multimodal, 2026-07-05).
//
// Purpose: pure, testable conversion of a local image file into an OpenAI-
// compatible `data:` URL, so `omniroute-call.ts` can attach a screenshot as a
// content-part (`image_url`) on providers that support vision (see
// docs/VISION-SPIKE-2026-07-05.md — kimi/minimax confirmed OK; glm rejects
// content-parts at its coding endpoint; CLI transports are a separate wave).
//
// This module does ZERO network I/O and ZERO provider-routing decisions —
// those live in provider-routes.ts / omniroute-call.ts. Keeping this file
// pure/synchronous makes it trivially unit-testable without mocking fetch.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/** Media types this module knows how to infer from a file extension. */
export type ReviewImageMediaType = 'image/png' | 'image/jpeg';

/**
 * A single image to attach to a review/consultation prompt. `path` must be a
 * local filesystem path readable by the current process (CLI-transport
 * sandboxing constraints are documented in the vision spike — NOT handled by
 * this module). `mediaType` is optional — when omitted, `imageToDataUrl`
 * infers it from the file extension.
 */
export interface ReviewImageAttachment {
  path: string;
  mediaType?: ReviewImageMediaType;
  /** Optional short label rendered as a text part just before the image. */
  label?: string;
}

export interface ImageDataUrlResult {
  dataUrl: string;
  mediaType: ReviewImageMediaType;
}

/** Extensions mapped to their inferred media type. Anything else defaults to PNG. */
const EXTENSION_MEDIA_TYPES: Record<string, ReviewImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * Infer the media type from a file path's extension. Case-insensitive.
 * Defaults to 'image/png' for unknown/missing extensions — a safe fallback
 * since PNG is a superset-friendly, lossless format most vision endpoints
 * accept without complaint.
 */
function inferMediaType(path: string): ReviewImageMediaType {
  const ext = extname(path).toLowerCase();
  return EXTENSION_MEDIA_TYPES[ext] ?? 'image/png';
}

/**
 * Read a local image file and encode it as a `data:` URL suitable for an
 * OpenAI-style `image_url` content-part. Throws a clear, actionable error
 * (naming the path) when the file cannot be read — NEVER logs the file
 * bytes/base64 content, only the path, so API-key-adjacent or otherwise
 * sensitive image data never hits stdout/stderr.
 */
export function imageToDataUrl(path: string): ImageDataUrlResult {
  const mediaType = inferMediaType(path);
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `imageToDataUrl: failed to read image file at '${path}': ${reason}`,
    );
  }
  const base64 = buffer.toString('base64');
  return {
    dataUrl: `data:${mediaType};base64,${base64}`,
    mediaType,
  };
}
