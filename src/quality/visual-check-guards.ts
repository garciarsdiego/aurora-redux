/**
 * FASE C (Visual Reviewer) — shared runtime type guards for the two
 * deterministic-check arrays that flow through a task's input_json.
 *
 * Extracted here so final-evidence.ts (workflow-level aggregation) and
 * task-visual-gate.ts (per-task gate) validate the exact same shape from a
 * single source of truth. Both only assert the REQUIRED fields — the full
 * structural validation lives in the zod schemas (src/types/schemas.ts);
 * these guards are the runtime "is this array of the right shape" check
 * used when reading back untrusted input_json.
 */
import type { CanvasRegionCheck, InteractionCheck } from './playwright-product-harness.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCanvasRegionCheckArray(value: unknown): value is CanvasRegionCheck[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item)
    && typeof item['selector'] === 'string'
    && typeof item['label'] === 'string'
    && 'region' in item,
  );
}

export function isInteractionCheckArray(value: unknown): value is InteractionCheck[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item)
    && typeof item['label'] === 'string'
    && typeof item['waitMs'] === 'number',
  );
}
