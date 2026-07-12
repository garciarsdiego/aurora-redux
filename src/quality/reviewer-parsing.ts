/**
 * Package-internal parsing/normalization for LLM reviewer responses.
 *
 * The light task reviewer (task-reviewer.ts) and the final product reviewer
 * (final-reviewer.ts) consume the exact same "strict JSON" reviewer
 * contract; only the default texts and score fallbacks differ, so they are
 * parametrized here instead of duplicating ~120 lines per reviewer.
 */
import { callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import type { ReviewImageAttachment } from '../utils/image-attachment.js';
import type { QualityIssue, QualityReviewOutcome } from './types.js';
import { clamp01 } from './internal-utils.js';

export interface ReviewerInvokerInput {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  images?: ReviewImageAttachment[];
}

/** Default invoker shared by both reviewers: Omniroute at temperature 0. */
export function defaultReviewerInvoker(input: ReviewerInvokerInput): Promise<string> {
  return callOmnirouteWithUsage({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    model: input.model,
    temperature: 0,
    images: input.images,
  }).then((result) => result.content);
}

/**
 * Extracts the strict-JSON object from a raw reviewer response, tolerating
 * fenced code blocks and surrounding prose. Throws `notObjectError` when no
 * object can be located at all.
 */
export function extractJsonObject(raw: string, notObjectError: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1];
  if (fenced) return JSON.parse(fenced) as Record<string, unknown>;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  }
  throw new Error(notObjectError);
}

export function normalizeOutcome(value: unknown): QualityReviewOutcome {
  return value === 'passed' || value === 'needs_fixes' || value === 'blocked'
    ? value
    : 'needs_fixes';
}

export function normalizeSeverity(value: unknown): QualityIssue['severity'] {
  return value === 'info' || value === 'warning' || value === 'error' || value === 'blocking'
    ? value
    : 'warning';
}

/** Per-reviewer defaults filled in when the LLM omits/garbles a field. */
export interface ReviewerIssueDefaults {
  /** Prefix for generated codes: `${codePrefix}_${index + 1}`. */
  codePrefix: string;
  origin: string;
  message: string;
  suggestedAction: string;
}

export function normalizeIssues(raw: unknown, defaults: ReviewerIssueDefaults): QualityIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, index) => {
    const issue = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return {
      severity: normalizeSeverity(issue['severity']),
      code: typeof issue['code'] === 'string' && issue['code'].trim()
        ? issue['code'].trim()
        : `${defaults.codePrefix}_${index + 1}`,
      origin: typeof issue['origin'] === 'string' && issue['origin'].trim()
        ? issue['origin'].trim()
        : defaults.origin,
      message: typeof issue['message'] === 'string' && issue['message'].trim()
        ? issue['message'].trim()
        : defaults.message,
      suggestedAction: typeof issue['suggestedAction'] === 'string' && issue['suggestedAction'].trim()
        ? issue['suggestedAction'].trim()
        : defaults.suggestedAction,
      safeContext: issue['safeContext'] && typeof issue['safeContext'] === 'object'
        ? issue['safeContext'] as Record<string, unknown>
        : {},
    };
  });
}

/** Per-reviewer numeric fallbacks when the LLM returns a non-finite score. */
export interface ReviewerScoreFallbacks {
  passed: number;
  needsFixes: number;
}

export function normalizeScore(
  value: unknown,
  outcome: QualityReviewOutcome,
  fallbacks: ReviewerScoreFallbacks,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) return clamp01(value);
  return outcome === 'passed' ? fallbacks.passed : outcome === 'blocked' ? 0 : fallbacks.needsFixes;
}
