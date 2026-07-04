// src/v2/advisors/shared/schemaValidator.ts
// Parse-and-retry helper for structured LLM outputs.

import type { ZodSchema } from 'zod';

/**
 * Attempts to parse `raw` with `zodSchema`.
 * On failure, calls `retryFn` with Zod's error feedback once, then parses again.
 * Throws if the second parse also fails.
 */
export async function validateOrRetry<T>(
  zodSchema: ZodSchema<T>,
  raw: string,
  retryFn: (feedback: string) => Promise<string>,
): Promise<T> {
  const first = zodSchema.safeParse(tryParseJson(raw));
  if (first.success) return first.data;

  const feedback = first.error.message;
  const retried = await retryFn(feedback);
  return zodSchema.parse(tryParseJson(retried));
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
