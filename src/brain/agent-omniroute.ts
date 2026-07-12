// Shared persona-path plumbing for the brain agents (decomposer/consolidator).
// Both files previously carried byte-identical copies of the Omniroute invoker
// and near-identical console-backed AgentContext adapters.

import { callOmnirouteWithUsage } from '../utils/omniroute-call.js';
import type { AgentInvoker } from '../v2/agents/runner.js';
import type { AgentContext } from '../v2/agents/types.js';

/**
 * Omniroute invoker adapter for runAgent. Maps AgentInvokeArgs to
 * callOmnirouteWithUsage and returns the content string.
 */
export const omnirouteInvoker: AgentInvoker = async (args) => {
  const result = await callOmnirouteWithUsage({
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt ?? 'Respond per the system contract above.',
    model: args.model,
  });
  return result.content;
};

/**
 * Builds a minimal console-backed AgentContext with the given log prefix.
 * Events go to console until Bloco 2 instruments with pino. `extras` lets
 * callers attach fields like workflowId.
 */
export function buildConsoleAgentContext(
  prefix: string,
  workspaceDir: string | undefined,
  extras: Partial<AgentContext> = {},
): AgentContext {
  return {
    retryCount: 0,
    workspaceDir,
    emit(event, payload) {
      console.debug(`[${prefix}:event] ${event}`, payload);
    },
    warn(message, payload) {
      console.warn(`[${prefix}:warn] ${message}`, payload ?? '');
    },
    log(level, message, payload) {
      if (level === 'error' || level === 'warn') {
        console.warn(`[${prefix}:${level}] ${message}`, payload ?? '');
      }
    },
    ...extras,
  };
}
