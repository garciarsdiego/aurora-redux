// Shared parser for docs/08-AI-PROVIDER-MATRIX.csv — single source of truth for
// the CSV path and column layout. Consumers keep their own caching policy:
// input/completer.ts caches by mtime, services/modelCatalog.ts by 5min TTL.
//
// Column layout (quoted fields are NOT supported — the source file uses
// unquoted commas only):
//   0 model_id · 1 use_primary · 2 use_secondary · 3 score_primary ·
//   4 score_secondary · 5 tier · 6 eq_ref

export const PROVIDER_MATRIX_CSV_REL = ['docs', '08-AI-PROVIDER-MATRIX.csv'] as const;

export interface ProviderMatrixRow {
  readonly model_id: string;
  readonly use_primary: string;
  readonly use_secondary: string;
  readonly score_primary: string;
  readonly score_secondary: string;
  readonly tier: string;
  readonly eq_ref: string;
}

/**
 * Minimal CSV parser tailored to the provider matrix. Skips the header row,
 * ignores blank lines, and drops rows without a model id.
 */
export function parseProviderMatrixCsv(raw: string): readonly ProviderMatrixRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Drop the header row.
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      model_id: cols[0]?.trim() ?? '',
      use_primary: cols[1]?.trim() ?? '',
      use_secondary: cols[2]?.trim() ?? '',
      score_primary: cols[3]?.trim() ?? '',
      score_secondary: cols[4]?.trim() ?? '',
      tier: cols[5]?.trim() ?? '',
      eq_ref: cols[6]?.trim() ?? '',
    };
  }).filter((r) => r.model_id !== '');
}
