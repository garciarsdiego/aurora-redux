import { z } from 'zod';
import { loadCatalog as loadOmnirouteCatalog } from '../../repl/services/modelCatalog.js';

export const ListModelsSchema = z.object({
  tier: z.string().optional(),
  use_case: z.string().optional(),
  provider: z.string().optional(),
  limit: z.number().int().min(1).max(296).optional().default(50),
});

// Example smoke test 2026-04-30: the previous implementation read ONLY from
// `docs/08-AI-PROVIDER-MATRIX.csv` (a hand-curated snapshot), so newly
// published Omniroute models (e.g. ollamacloud/deepseek-v4-pro) never
// surfaced via MCP. The dashboard's `/api/dashboard/model-catalog` route
// already merges Omniroute live + CSV via `repl/services/modelCatalog`;
// list_models now uses the same source. Live API misses fall back to CSV
// (network outage / Omniroute down) — graceful degradation built into
// loadOmnirouteCatalog.
//
// Filter semantics preserved:
//   - provider: case-insensitive prefix match on model_id (so 'ollama'
//     catches both 'ollamacloud/...' and 'ollama-cloud/...')
//   - tier: case-insensitive prefix on tier ('S' matches 'S', 'S+', 'S-')
//   - use_case: case-insensitive substring across use_primary | use_secondary
//
// Output shape kept identical to the previous CSV-only contract so all
// existing MCP clients continue to parse it.
export async function listModelsTool(raw: unknown): Promise<string> {
  const { tier, use_case, provider, limit } = ListModelsSchema.parse(raw);
  const catalog = await loadOmnirouteCatalog({ force: false });

  let entries = catalog.models.map((m) => ({
    model_id: m.model_id,
    use_primary: m.use_primary ?? '',
    use_secondary: m.use_secondary ?? '',
    score_primary: m.score_primary ?? '',
    score_secondary: m.score_secondary ?? '',
    tier: m.tier ?? '',
    eq_ref: m.eq_ref ?? '',
  }));

  if (provider) {
    const p = provider.toLowerCase();
    entries = entries.filter((e) => e.model_id.toLowerCase().startsWith(p));
  }
  if (tier) {
    const t = tier.toUpperCase();
    entries = entries.filter((e) => e.tier.toUpperCase().startsWith(t));
  }
  if (use_case) {
    const u = use_case.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.use_primary.toLowerCase().includes(u) ||
        e.use_secondary.toLowerCase().includes(u),
    );
  }

  const results = entries.slice(0, limit);
  return JSON.stringify({
    total: entries.length,
    shown: results.length,
    models: results,
  });
}
