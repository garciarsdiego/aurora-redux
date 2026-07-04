/**
 * model-config-validator.ts — D-H2.076
 *
 * Validates DECOMPOSER_MODEL / TASK_MODEL / REVIEWER_MODEL / CONSOLIDATOR_MODEL
 * against the Omniroute catalog. Called at daemon start and by `omniforge doctor`.
 *
 * Returns { valid, failures[] } so the caller decides whether to abort or warn.
 */

import { loadCatalog } from '../../repl/services/modelCatalog.js';
import {
  getDecomposerModel,
  getTaskModel,
  getReviewerModel,
  getConsolidatorModel,
} from '../../utils/config.js';

export interface ModelValidationFailure {
  env: string;
  value: string;
  suggestions: string[];
}

export interface ModelValidationResult {
  valid: boolean;
  catalogReachable: boolean;
  failures: ModelValidationFailure[];
}

const MODEL_ENVS: Array<{ env: string; getter: () => string }> = [
  { env: 'DECOMPOSER_MODEL', getter: getDecomposerModel },
  { env: 'TASK_MODEL', getter: getTaskModel },
  { env: 'REVIEWER_MODEL', getter: getReviewerModel },
  { env: 'CONSOLIDATOR_MODEL', getter: getConsolidatorModel },
];

function topSuggestions(value: string, allIds: string[], n = 3): string[] {
  const needle = value.toLowerCase();
  // Score by shared prefix length + substring match bonus
  const scored = allIds.map((id) => {
    const idLower = id.toLowerCase();
    let score = 0;
    // shared leading chars
    for (let i = 0; i < Math.min(needle.length, idLower.length); i++) {
      if (needle[i] === idLower[i]) score++;
      else break;
    }
    // substring bonus
    if (idLower.includes(needle) || needle.includes(idLower)) score += 10;
    // provider match bonus (provider/model format)
    const needleParts = needle.split('/');
    const idParts = idLower.split('/');
    if (needleParts[0] && idParts[0] === needleParts[0]) score += 5;
    return { id, score };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((s) => s.id);
}

/**
 * Validate configured model env vars against the live Omniroute catalog.
 *
 * @param opts.force  Force-refresh the catalog cache (default false).
 * @returns ModelValidationResult. If catalog is unreachable, valid=true with
 *          catalogReachable=false so the caller can decide.
 */
export async function validateModelEnvsAgainstCatalog(
  opts: { force?: boolean } = {},
): Promise<ModelValidationResult> {
  let catalogModels: string[] = [];
  let catalogReachable = false;

  try {
    const catalog = await loadCatalog({ force: opts.force ?? false });
    if (catalog.models.length > 0) {
      catalogReachable = true;
      catalogModels = catalog.models.map((m) => m.model_id);
    }
  } catch {
    // Catalog unreachable — skip model validation, let daemon start
    return { valid: true, catalogReachable: false, failures: [] };
  }

  if (!catalogReachable) {
    return { valid: true, catalogReachable: false, failures: [] };
  }

  const failures: ModelValidationFailure[] = [];

  for (const { env, getter } of MODEL_ENVS) {
    const value = getter();
    if (!value) continue;
    if (!catalogModels.includes(value)) {
      failures.push({
        env,
        value,
        suggestions: topSuggestions(value, catalogModels),
      });
    }
  }

  return {
    valid: failures.length === 0,
    catalogReachable: true,
    failures,
  };
}
