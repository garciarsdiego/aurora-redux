import {
  loadProviderMatrixCatalog,
  type ModelCapabilityEntry,
} from '../v2/models/capability-registry.js';

/**
 * De-mock (OPS-08): replace the stale hardcoded model->quality maps that used
 * to live inline in CostAwareRouter / CostOptimizer. Quality is now sourced
 * from the live provider matrix (docs/08-AI-PROVIDER-MATRIX.csv) via the
 * capability registry, which carries a per-model `score_primary` (0-100) and a
 * tier-derived `quality_rank`. We normalize that to the 0..1 quality scale the
 * cost router expects.
 *
 * Fail-safe: if the catalog cannot be loaded (CSV missing in a stripped-down
 * deploy), callers fall back to a neutral default rather than throwing — cost
 * routing must never break because the matrix file is absent.
 */

let cachedCatalog: ModelCapabilityEntry[] | null = null;
let catalogLoadFailed = false;

/** Neutral default quality on the 0..1 scale when no catalog entry is found. */
export const DEFAULT_CATALOG_QUALITY = 0.8;

function getCatalog(): ModelCapabilityEntry[] | null {
  if (cachedCatalog) return cachedCatalog;
  if (catalogLoadFailed) return null;
  try {
    cachedCatalog = loadProviderMatrixCatalog();
    return cachedCatalog;
  } catch {
    // CSV not present / unreadable — remember the failure so we don't retry on
    // every call, and let callers use the neutral default.
    catalogLoadFailed = true;
    return null;
  }
}

function baseModelOf(model: string): string {
  return model.split('/').pop() || model;
}

/**
 * Look up a normalized quality score (0..1) for a model from the live catalog.
 *
 * Matching is tolerant of provider prefixes: we try the full model id first,
 * then the bare base name (after the last '/'). Returns DEFAULT_CATALOG_QUALITY
 * when the model is unknown or the catalog is unavailable.
 */
export function getCatalogQuality(model: string): number {
  const catalog = getCatalog();
  if (!catalog || catalog.length === 0) return DEFAULT_CATALOG_QUALITY;

  const base = baseModelOf(model).toLowerCase();
  const full = model.toLowerCase();

  const entry =
    catalog.find((e) => e.model_id.toLowerCase() === full) ??
    catalog.find((e) => baseModelOf(e.model_id).toLowerCase() === base);

  if (!entry) return DEFAULT_CATALOG_QUALITY;

  // Prefer the explicit 0-100 primary score; fall back to the tier-derived
  // quality_rank (0..6) scaled to 0..1 when score is absent/zero.
  if (entry.score_primary > 0) {
    return Math.min(1, Math.max(0, entry.score_primary / 100));
  }
  if (entry.quality_rank > 0) {
    return Math.min(1, Math.max(0, entry.quality_rank / 6));
  }
  return DEFAULT_CATALOG_QUALITY;
}

/**
 * Use-case multiplier applied on top of the catalog quality. This is a
 * deliberate routing heuristic (not a quality measurement), shared by
 * CostAwareRouter and CostOptimizer so the two estimates can never diverge.
 */
const USE_CASE_MULTIPLIER: Record<string, number> = {
  'code': 1.0,
  'debug': 0.95,
  'planning': 1.05,
  'review': 1.0,
  'chat': 0.9
};

/**
 * Estimate quality for a model (0-1) adjusted for a use case.
 *
 * De-mock (OPS-08): base quality is sourced from the live provider matrix
 * (capability registry) instead of a stale hardcoded map.
 */
export function estimateUseCaseQuality(model: string, use_case: string): number {
  const baseQuality = getCatalogQuality(model);
  return Math.min(1.0, baseQuality * (USE_CASE_MULTIPLIER[use_case] || 1.0));
}

/** Test/maintenance hook — clears the in-process catalog cache. */
export function resetCatalogQualityCache(): void {
  cachedCatalog = null;
  catalogLoadFailed = false;
}
