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
// Source: pal-mcp-server tools/version.py — class VersionRequest
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

/**
 * Input schema for the `version` advisor.
 *
 * PAL's version tool took no arguments; we add an optional `format` knob to
 * mirror listmodels and let callers ask for plain text instead of JSON.
 */
export const VersionInputSchema = z.object({
  format: z
    .enum(['json', 'text'])
    .optional()
    .default('json')
    .describe('Output format: "json" (machine) or "text" (single-line, human-friendly).'),
});

export type VersionInput = z.infer<typeof VersionInputSchema>;
