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
// Source: pal-mcp-server tools/chat.py — class ChatTool
// © BeehiveInnovations — see ../NOTICE.md.
//
// AETHER ε.4: replaces the legacy `pal:chat` stdio path with an in-process
// callOmniroute. Removes the PAL Python dependency for the simplest tool in
// the catalog. Multi-step reasoning lives in the stepwise advisors
// (consensus / codereview / debug / planner / precommit / thinkdeep);
// `chat` stays one-shot by design.

import type { Advisor, AdvisorContext, AdvisorResult } from '../types.js';
import { getAdvisorMode } from '../shared/mode.js';
import { callOmniroute } from '../../../utils/omniroute-call.js';
import { ChatInputSchema, type ChatInput } from './schema.js';
import { CHAT_SYSTEM_PROMPT } from './prompt.js';

const DESCRIPTION =
  'Generic single-shot LLM call for quick questions, brainstorming, or thinking-partner conversations. ' +
  'Falls back to TASK_MODEL when no model is supplied. Use codereview / refactor / debug for file-bearing tasks.';

const DEFAULT_MODEL = 'cc/claude-sonnet-4-6';

function buildUserPrompt(parsed: ChatInput): string {
  const lines: string[] = [];
  lines.push('=== USER REQUEST ===');
  lines.push(parsed.prompt);

  if (parsed.absolute_file_paths.length > 0) {
    lines.push('');
    lines.push('=== FILE REFERENCES (operator already has these on disk) ===');
    parsed.absolute_file_paths.forEach((f) => lines.push(`- ${f}`));
  }

  return lines.join('\n');
}

export const chatAdvisor: Advisor = {
  name: 'chat',
  description: DESCRIPTION,
  async run(ctx: AdvisorContext, args: unknown): Promise<AdvisorResult> {
    const parsed = ChatInputSchema.parse(args);
    void getAdvisorMode(ctx, args);
    const userPrompt = buildUserPrompt(parsed);
    const text = await callOmniroute({
      systemPrompt: CHAT_SYSTEM_PROMPT,
      userPrompt,
      model: parsed.model ?? DEFAULT_MODEL,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return { output: text };
  },
};
