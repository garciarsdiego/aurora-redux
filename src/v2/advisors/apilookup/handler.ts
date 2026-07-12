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
// Source: pal-mcp-server tools/apilookup.py — class LookupTool
// © BeehiveInnovations — see ../NOTICE.md.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callAdvisorLlm } from '../shared/llm.js';
import { webSearch } from '../../tools/core/web-search.js';
import { webFetch } from '../../tools/core/web-fetch.js';
import { ApilookupInputSchema } from './schema.js';
import { LOOKUP_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Use this tool automatically when you need current API/SDK documentation, latest version info, breaking changes, ' +
  'deprecations, migration guides, or official release notes. ' +
  'This tool searches authoritative sources (official docs, GitHub, package registries) to ensure up-to-date accuracy.';

const TOP_N = 3;
const PER_FETCH_TIMEOUT = 15_000;
// Cap fetched body length so the LLM context isn't blown out by a single doc page.
const MAX_BODY_PER_RESULT = 12_000;

async function gatherSources(query: string): Promise<string> {
  // Only the search itself is guarded: when it fails there is no grounding at
  // all, so return '' and let the caller fall back to the ungrounded prompt —
  // an error string here would be mislabelled as "GROUNDING SOURCES" evidence.
  let search;
  try {
    search = await webSearch({ query, limit: TOP_N });
  } catch {
    return '';
  }

  const lines: string[] = [];
  lines.push(`Search provider: ${search.provider}${search.cached ? ' (cached)' : ''}`);
  lines.push(`Top ${search.results.length} results:`);
  for (const [i, r] of search.results.entries()) {
    lines.push(`  ${i + 1}. ${r.title} — ${r.url}`);
    if (r.snippet) lines.push(`     ${r.snippet.slice(0, 200)}`);
  }
  lines.push('');

  const fetched = await Promise.allSettled(
    search.results.slice(0, TOP_N).map((r) =>
      webFetch({ url: r.url, method: 'GET', timeout: PER_FETCH_TIMEOUT }),
    ),
  );
  fetched.forEach((settled, i) => {
    const url = search.results[i]?.url ?? '<unknown>';
    lines.push(`=== Source ${i + 1}: ${url} ===`);
    if (settled.status === 'fulfilled') {
      const body = settled.value.body.length > MAX_BODY_PER_RESULT
        ? `${settled.value.body.slice(0, MAX_BODY_PER_RESULT)}\n[truncated: ${settled.value.body.length - MAX_BODY_PER_RESULT} chars omitted]`
        : settled.value.body;
      lines.push(`status=${settled.value.status}`);
      lines.push(body);
    } else {
      lines.push(`fetch failed: ${String(settled.reason).slice(0, 300)}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

export const apilookupAdvisor: Advisor = {
  name: 'apilookup',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = ApilookupInputSchema.parse(args);
    void getAdvisorMode(ctx, args);

    const sources = await gatherSources(parsed.prompt);

    const userPrompt = sources.trim()
      ? `${parsed.prompt}\n\n=== GROUNDING SOURCES (use these as primary evidence) ===\n${sources}`
      : parsed.prompt;

    const text = await callAdvisorLlm(ctx, {
      systemPrompt: LOOKUP_PROMPT,
      userPrompt,
    });

    return { output: text };
  },
};
