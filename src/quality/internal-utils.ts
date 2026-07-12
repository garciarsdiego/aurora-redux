/**
 * Package-internal helpers shared across the quality modules.
 *
 * These were previously copy-pasted (safeParseJson existed in 4 files,
 * tableExists in 2, the ProductEvidenceIssue -> QualityIssue mapping in 3);
 * consolidating them here keeps a single source of truth without touching
 * any public export of the package.
 */
import type Database from 'better-sqlite3';
import type { ProductEvidenceIssue, QualityIssue } from './types.js';

/**
 * Parses a JSON string defensively: any parse failure, non-object, or array
 * result collapses to `{}` so callers can index into the result without
 * further guards.
 */
export function safeParseJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row?.name === table;
}

/** Clamps a finite number into the quality-score range [0, 1]. */
export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Translates ProductEvidenceIssue entries (used by the harnesses) into the
 * broader QualityIssue shape with the given `origin`.
 */
export function qualityIssuesFromProductEvidence(
  productEvidence: ProductEvidenceIssue[],
  origin: string,
): QualityIssue[] {
  return productEvidence.map((issue) => ({
    severity: issue.severity,
    code: issue.code,
    origin,
    message: issue.message,
    suggestedAction: issue.suggestedAction,
    safeContext: issue.safeContext ?? {},
  }));
}
