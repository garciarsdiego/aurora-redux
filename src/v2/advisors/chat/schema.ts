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
// Source: pal-mcp-server tools/chat.py — class ChatRequest
// © BeehiveInnovations — see ../NOTICE.md.

import { z } from 'zod';

/**
 * Input schema for the `chat` advisor.
 *
 * Mirror of PAL's ChatRequest: a generic single-shot LLM call. Used by
 * orchestrators that need a quick "ask the model" without web grounding,
 * stepwise iteration, or domain-specific tooling.
 */
export const ChatInputSchema = z.object({
  prompt: z
    .string()
    .min(1, 'prompt must be a non-empty user message')
    .describe('The question, request, or context to send to the model.'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional Omniroute model id (e.g. "cc/claude-sonnet-4-6"). Defaults to TASK_MODEL when omitted.',
    ),
  absolute_file_paths: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      'Optional absolute file paths to mention as context. The advisor lists them inline; it does not auto-load contents (use codereview/refactor for that).',
    ),
});

export type ChatInput = z.infer<typeof ChatInputSchema>;
