// Sprint 4.5 / Agent M2-A3: shared helpers extracted while splitting the
// original dashboard-workflow-ops.ts (~1535 LOC) into per-domain modules.
//
// Pure behavior-preserving extraction — these helpers were inline private
// functions in the monolithic file; they're now exported here so each
// sub-router (lifecycle/tasks/reviews/dags/diff/runtime) can re-use them
// without cross-module imports between siblings.

import type { ServerResponse } from 'node:http';
import { badRequest, jsonOk } from '../_shared.js';

export function parseRecordJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function parseToolJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

export function toolJsonObject(raw: string): object {
  const parsed = parseToolJson(raw);
  return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
}

export function collaborationStructuredError(
  code: string,
  origin: string,
  message: string,
  suggestedAction: string,
  safeContext: Record<string, unknown>,
): Record<string, unknown> {
  return {
    structured_error: {
      code,
      origin,
      message,
      suggested_action: suggestedAction,
      context: safeContext,
    },
  };
}

export async function respondWithCollaborationTool(
  res: ServerResponse,
  code: string,
  origin: string,
  safeContext: Record<string, unknown>,
  suggestedAction: string,
  fn: () => Promise<string>,
): Promise<void> {
  try {
    jsonOk(res, toolJsonObject(await fn()));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    badRequest(res, message, collaborationStructuredError(
      code,
      origin,
      message,
      suggestedAction,
      safeContext,
    ));
  }
}
