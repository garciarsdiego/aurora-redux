/**
 * WORKER_ADVISOR_CALL_PERSONA — dispatcher for native advisors.
 *
 * Picks an advisor (codereview, debug, thinkdeep, etc.) and invokes it in the
 * appropriate mode (stepwise / oneshot / auto). The persona is not the
 * advisor itself — it's the contract layer that selects mode + validates
 * args before handing off.
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §6.
 */

import { z } from 'zod';

import type { AgentPersona, FailureMode } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Allow-listed advisor names. Mirrors src/v2/advisors/registry.ts capabilities.
 * Adding a new advisor means: (a) updating this list, (b) adding it to the
 * advisor mode map below if it has any non-default mode support, (c) bumping
 * the persona's `version`.
 */
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

export const ADVISOR_MODES = ['stepwise', 'oneshot', 'auto'] as const;
export type AdvisorMode = (typeof ADVISOR_MODES)[number];

/**
 * Per-advisor supported modes. Default: all three. `consensus` is multi-step
 * by design — it does NOT support oneshot. `listmodels` and `version` are
 * pure read operations — only oneshot makes sense.
 */
const ADVISOR_MODE_SUPPORT: Record<AdvisorName, readonly AdvisorMode[]> = {
  analyze: ['stepwise', 'oneshot', 'auto'],
  apilookup: ['oneshot', 'auto'],
  challenge: ['stepwise', 'oneshot', 'auto'],
  chat: ['oneshot', 'auto'],
  codereview: ['stepwise', 'oneshot', 'auto'],
  consensus: ['stepwise', 'auto'], // NO oneshot — needs multi-step model rounds
  debug: ['stepwise', 'oneshot', 'auto'],
  docgen: ['stepwise', 'oneshot', 'auto'],
  listmodels: ['oneshot'],
  planner: ['stepwise', 'oneshot', 'auto'],
  precommit: ['stepwise', 'oneshot', 'auto'],
  refactor: ['stepwise', 'oneshot', 'auto'],
  secaudit: ['stepwise', 'oneshot', 'auto'],
  testgen: ['stepwise', 'oneshot', 'auto'],
  thinkdeep: ['stepwise', 'oneshot', 'auto'],
  tracer: ['stepwise', 'oneshot', 'auto'],
  version: ['oneshot'],
};

export function modeIsSupported(advisor: AdvisorName, mode: AdvisorMode): boolean {
  return ADVISOR_MODE_SUPPORT[advisor].includes(mode);
}

export function defaultModeFor(advisor: AdvisorName): AdvisorMode {
  const supported = ADVISOR_MODE_SUPPORT[advisor];
  // Prefer stepwise when supported (richer evidence), else oneshot.
  if (supported.includes('stepwise')) return 'stepwise';
  return supported[0] ?? 'oneshot';
}

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

export const WorkerAdvisorCallInputSchema = z.object({
  task_id: z.string(),
  advisor_name: z.enum(ADVISOR_NAMES),
  mode: z.enum(ADVISOR_MODES).default('auto'),
  args: z.unknown(),
  workspace: z.string().min(1),
  /** Optional: number of acceptance criteria — used to choose stepwise vs oneshot when mode=auto. */
  acceptance_criteria_count: z.number().int().min(0).optional(),
});
export type WorkerAdvisorCallInput = z.infer<typeof WorkerAdvisorCallInputSchema>;

export const WorkerAdvisorCallOutputSchema = z.object({
  advisor_name: z.string(),
  result: z.unknown(),
  steps_executed: z.number().int().min(0).optional(),
  cost_usd: z.number().nonnegative(),
  /** Mode actually used (may differ from requested when 'auto' resolves or when fallback fires). */
  resolved_mode: z.enum(ADVISOR_MODES),
});
export type WorkerAdvisorCallOutput = z.infer<typeof WorkerAdvisorCallOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<WorkerAdvisorCallOutput>[] = [
  {
    id: 'advisor.unknown',
    detect: () => false,
    remediation: 'escalate_to_operator',
    description: 'Advisor name not in registry — programming error upstream.',
  },
  {
    id: 'advisor.mode_unsupported',
    detect: () => false,
    remediation: 'soft_fail',
    description: 'Requested mode not available for this advisor; fell back to default.',
  },
  {
    id: 'advisor.timeout',
    detect: () => false,
    remediation: 'retry_with_different_model',
    description: 'Advisor exceeded its budget; try a different model override.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `# Advisor dispatcher (no LLM at this layer)
Advisor: \${INPUT.advisor_name}
Mode requested: \${INPUT.mode}
Workspace: \${INPUT.workspace}
Args: \${INPUT.args|json}`;

export const WORKER_ADVISOR_CALL_PERSONA: AgentPersona<WorkerAdvisorCallInput, WorkerAdvisorCallOutput> = {
  id: 'worker.advisor_call',
  version: '1.0.0',
  name: 'Worker · Advisor Call',
  identity:
    'I delegate to a native advisor (codereview, debug, thinkdeep, secaudit, consensus, planner, refactor, docgen, analyze, chat, listmodels, version, apilookup, challenge, tracer, testgen, precommit). I select mode (stepwise / oneshot / auto). I am NOT the advisor itself — I am the dispatcher.',
  mission: 'Route a task to the right native advisor with the right mode, return its result.',
  inputSchema: WorkerAdvisorCallInputSchema,
  outputSchema: WorkerAdvisorCallOutputSchema,
  hardRules: [
    'Advisor must exist in registry. Validate against ADVISOR_NAMES allowlist.',
    'Mode must be supported by advisor. Some advisors don\'t support oneshot (e.g. consensus); validate.',
    'Args must match advisor\'s input schema. Each advisor has its own.',
    'Honor operator persisted mode preferences. Cluster F set advisor_modes config; respect unless task overrides.',
  ],
  forbidden: [
    "Don't invent advisor names.",
    "Don't bypass mode validation.",
  ],
  ambiguityProtocol: [
    {
      condition: "Mode = 'auto'",
      resolution:
        "Pick stepwise if advisor supports it AND task has multiple acceptance criteria; else oneshot.",
      escalate: false,
    },
    {
      condition: "Advisor doesn't support requested mode",
      resolution: "Fall back to advisor's default mode, note in output.",
      escalate: false,
    },
  ],
  tools: [],
  permissions: { defaultAction: 'allow' },
  defaultModel: null,
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, ctx) => {
    let resolvedMode: AdvisorMode = input.mode;

    // Resolve 'auto' → stepwise/oneshot per the contract.
    if (resolvedMode === 'auto') {
      const supportsStepwise = modeIsSupported(input.advisor_name, 'stepwise');
      const multipleCriteria = (input.acceptance_criteria_count ?? 0) > 1;
      resolvedMode = supportsStepwise && multipleCriteria ? 'stepwise' : (
        modeIsSupported(input.advisor_name, 'oneshot') ? 'oneshot' : defaultModeFor(input.advisor_name)
      );
      ctx.emit('advisor_mode_resolved', {
        advisor: input.advisor_name,
        requested: 'auto',
        resolved: resolvedMode,
      });
    }

    // Validate the resolved mode is supported.
    if (!modeIsSupported(input.advisor_name, resolvedMode)) {
      const fallback = defaultModeFor(input.advisor_name);
      ctx.warn(
        `advisor.mode_unsupported: ${input.advisor_name} doesn't support mode=${resolvedMode}; falling back to ${fallback}`,
      );
      resolvedMode = fallback;
    }

    input.mode = resolvedMode;
    return input;
  },
};
