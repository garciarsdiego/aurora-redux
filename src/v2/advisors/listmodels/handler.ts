// Copyright 2024 BeehiveInnovations / Omniforge Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// Ported from PAL MCP Server (Apache 2.0).
// Source: pal-mcp-server tools/listmodels.py — class ListModelsTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// AETHER ε.4: replaces the legacy `pal:listmodels` stdio call with an
// in-process catalog read. Reuses the same loadOmnirouteCatalog source as
// the `omniforge_list_models` MCP tool so the two stay in sync.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { loadCatalog as loadOmnirouteCatalog } from '../../../repl/services/modelCatalog.js';
import { ListmodelsInputSchema, type ListmodelsInput } from './schema.js';

const DESCRIPTION =
  'List Omniroute models with optional tier/use_case/provider filters. Returns the same data as ' +
  'the omniforge_list_models MCP tool, formatted as JSON (default) or a markdown table.';

interface CatalogEntry {
  model_id: string;
  use_primary: string;
  use_secondary: string;
  score_primary: string;
  score_secondary: string;
  tier: string;
  eq_ref: string;
}

function applyFilters(
  entries: CatalogEntry[],
  filters: Pick<ListmodelsInput, 'tier' | 'use_case' | 'provider'>,
): CatalogEntry[] {
  let out = entries;
  if (filters.provider) {
    const p = filters.provider.toLowerCase();
    out = out.filter((e) => e.model_id.toLowerCase().startsWith(p));
  }
  if (filters.tier) {
    const t = filters.tier.toUpperCase();
    out = out.filter((e) => e.tier.toUpperCase().startsWith(t));
  }
  if (filters.use_case) {
    const u = filters.use_case.toLowerCase();
    out = out.filter(
      (e) =>
        e.use_primary.toLowerCase().includes(u) ||
        e.use_secondary.toLowerCase().includes(u),
    );
  }
  return out;
}

function formatMarkdownTable(entries: CatalogEntry[], totalBeforeLimit: number): string {
  if (entries.length === 0) {
    return `No models matched the filter (catalog has ${totalBeforeLimit} candidates total).`;
  }
  const lines: string[] = [];
  lines.push(`Catalog: ${entries.length} of ${totalBeforeLimit} match`);
  lines.push('');
  lines.push('| Model | Tier | Primary use | Secondary use | eq_ref |');
  lines.push('|---|---|---|---|---|');
  for (const e of entries) {
    lines.push(
      `| ${e.model_id} | ${e.tier || '-'} | ${e.use_primary || '-'} | ${e.use_secondary || '-'} | ${e.eq_ref || '-'} |`,
    );
  }
  return lines.join('\n');
}

export const listmodelsAdvisor: Advisor = {
  name: 'listmodels',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = ListmodelsInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const catalog = await loadOmnirouteCatalog({ force: false });

    const all: CatalogEntry[] = catalog.models.map((m) => ({
      model_id: m.model_id,
      use_primary: m.use_primary ?? '',
      use_secondary: m.use_secondary ?? '',
      score_primary: m.score_primary ?? '',
      score_secondary: m.score_secondary ?? '',
      tier: m.tier ?? '',
      eq_ref: m.eq_ref ?? '',
    }));

    const filtered = applyFilters(all, parsed);
    const limited = filtered.slice(0, parsed.limit);

    if (parsed.format === 'text') {
      return { output: formatMarkdownTable(limited, filtered.length) };
    }

    const json = JSON.stringify({
      total: filtered.length,
      shown: limited.length,
      models: limited,
    });
    return { output: json, structured: { total: filtered.length, shown: limited.length, models: limited } };
  },
};
