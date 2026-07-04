// MCP tool wrappers for the 17 native advisors (AETHER ε.4 close-out
// 2026-05-01 round 2: chat/listmodels/version added, clink retired). 17/18
// PAL parity by count; the missing one (clink) is intentionally absent —
// see D-H2.074. clink existed in PAL because PAL had no cli_spawn primitive;
// Omniforge has cli_spawn as a first-class task kind, so "use external CLI"
// is `kind: cli_spawn, executor_hint: cli:<name>` directly.
//
// Mirrors PAL's `mcp__pal__*` tool surface — callers that today reach for
// `mcp__pal__consensus` can call `omniforge_consensus` instead.
//
// The advisor handlers do their own Zod validation, so the tool's MCP
// `inputSchema` here is permissive (`type: object, additionalProperties: true`).
// Bad input surfaces as a structured advisor error.

// Side-effect import: ensure all 17 advisors register before any lookup.
import '../../v2/advisors/loader.js';

import { getAdvisor } from '../../v2/advisors/index.js';
import { isAdvisorMode } from '../../v2/advisors/shared/mode.js';
import type { AdvisorContext, AdvisorMode, AdvisorResult, StepwiseAdvisorResult } from '../../v2/advisors/types.js';

export const ADVISOR_NAMES = [
  'analyze',
  'apilookup',
  'challenge',
  'chat',
  'codereview',
  'consensus',
  'debug',
  'docgen',
  'listmodels',
  'planner',
  'precommit',
  'refactor',
  'secaudit',
  'testgen',
  'thinkdeep',
  'tracer',
  'version',
] as const;

export type AdvisorName = (typeof ADVISOR_NAMES)[number];

const ADVISOR_NAME_SET = new Set<string>(ADVISOR_NAMES);

export function isAdvisorToolName(name: string): name is `omniforge_${AdvisorName}` {
  if (!name.startsWith('omniforge_')) return false;
  const advisor = name.slice('omniforge_'.length);
  return ADVISOR_NAME_SET.has(advisor);
}

interface AdvisorToolEntry {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: {
      mode: {
        type: 'string';
        enum: ['stepwise', 'oneshot', 'auto'];
        default: 'auto';
        description: string;
      };
    };
    additionalProperties: true;
  };
}

export function buildAdvisorToolDefinitions(): AdvisorToolEntry[] {
  return ADVISOR_NAMES.map((advisorName) => {
    const advisor = getAdvisor(advisorName);
    const description = advisor?.description
      ?? `Native ${advisorName} advisor (PAL replacement). Schema: see src/v2/advisors/${advisorName}/schema.ts`;
    return {
      name: `omniforge_${advisorName}`,
      description,
      inputSchema: {
        type: 'object' as const,
        properties: {
          mode: {
            type: 'string' as const,
            enum: ['stepwise', 'oneshot', 'auto'],
            default: 'auto',
            description:
              'Advisor execution mode. auto preserves the advisor default; stepwise allows iterative memory; oneshot disables the conversation-memory loop.',
          },
        },
        additionalProperties: true,
      },
    };
  });
}

export async function runAdvisorTool(
  toolName: string,
  args: unknown,
  ctx?: Partial<AdvisorContext>,
): Promise<string> {
  if (!isAdvisorToolName(toolName)) {
    throw new Error(`Not an advisor tool: ${toolName}`);
  }
  const advisorName = toolName.slice('omniforge_'.length);
  const advisor = getAdvisor(advisorName);
  if (!advisor) {
    throw new Error(`Advisor not registered: ${advisorName}. Loader did not run, or registration failed.`);
  }

  const fullCtx: AdvisorContext = {
    workspace: ctx?.workspace ?? 'internal',
    workflow_id: ctx?.workflow_id ?? `mcp-direct-${Date.now()}`,
    mode: extractMode(args, ctx?.mode),
    ...(ctx?.signal ? { signal: ctx.signal } : {}),
    ...(ctx?.onEvent ? { onEvent: ctx.onEvent } : {}),
  };

  const result: AdvisorResult | StepwiseAdvisorResult = await advisor.run(fullCtx, args);
  return result.output;
}

function extractMode(args: unknown, fallback?: AdvisorMode): AdvisorMode {
  if (typeof args === 'object' && args !== null && isAdvisorMode((args as { mode?: unknown }).mode)) {
    return (args as { mode: AdvisorMode }).mode;
  }
  return fallback ?? 'auto';
}
