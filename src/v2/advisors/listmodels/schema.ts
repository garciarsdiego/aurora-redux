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
// Source: pal-mcp-server tools/listmodels.py — class ListModelsRequest
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

/**
 * Input schema for the `listmodels` advisor.
 *
 * Filters mirror the existing `omniforge_list_models` MCP tool so callers
 * can swap between the two without restructuring their args. Optional
 * `format` lets callers ask for human-readable text instead of the default
 * JSON catalog dump (PAL parity: PAL's listmodels printed a markdown table).
 */
export const ListmodelsInputSchema = z.object({
  tier: z
    .string()
    .optional()
    .describe('Optional case-insensitive prefix filter on tier (e.g. "S", "S+").'),
  use_case: z
    .string()
    .optional()
    .describe('Optional case-insensitive substring across use_primary | use_secondary.'),
  provider: z
    .string()
    .optional()
    .describe('Optional case-insensitive prefix filter on model_id (e.g. "openai", "ollama").'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(296)
    .optional()
    .default(50)
    .describe('Maximum entries to return after filtering. Defaults to 50.'),
  format: z
    .enum(['json', 'text'])
    .optional()
    .default('json')
    .describe(
      'Output format: "json" (machine-readable, same shape as omniforge_list_models) or "text" (markdown table).',
    ),
});

export type ListmodelsInput = z.infer<typeof ListmodelsInputSchema>;
