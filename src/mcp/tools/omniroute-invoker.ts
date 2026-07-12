/**
 * Shared Omniroute-backed AgentInvoker for MCP tools (same pattern as
 * decomposer.ts). Used by builder_chat.ts and replay_persona_version.ts.
 */

import { callOmnirouteWithUsage } from '../../utils/omniroute-call.js';
import type { AgentInvoker } from '../../v2/agents/runner.js';

export const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    model: args.model,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
  });
  return result.content;
};
