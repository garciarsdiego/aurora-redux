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
// Source: pal-mcp-server tools/apilookup.py — class LookupRequest
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

/**
 * Input schema for the `apilookup` advisor.
 *
 * Field description copied verbatim from LOOKUP_FIELD_DESCRIPTIONS["prompt"]
 * in apilookup.py.
 */
export const ApilookupInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt must be a non-empty API/SDK lookup query')
    .describe(
      'The API, SDK, library, framework, or technology you need current documentation, version info, breaking changes, or migration guidance for.',
    ),
});

export type ApilookupInput = z.infer<typeof ApilookupInputSchema>;
