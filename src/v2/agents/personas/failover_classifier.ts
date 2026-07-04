/**
 * FAILOVER_CLASSIFIER_PERSONA — cheap, fast (haiku) failure-mode classifier.
 *
 * Runs ONLY on the failure path. Looks at the failure context and picks the
 * best remediation: retry_as_is, retry_with_stronger_prompt, retry_with_
 * different_model, retry_with_workspace_clean, switch_executor,
 * escalate_to_operator, soft_fail.
 *
 * The preHook implements the **known-pattern shortcut table**: when a failure
 * matches one of the documented patterns we've seen in production
 * (worker.described_without_writing, worker.opencode_empty_output,
 * decomposer.prose_response, etc.) we skip the LLM call entirely and apply
 * the canonical remediation.
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §8.
 */

import { z } from 'zod';

import { DagTaskSchema } from '../../../types/schemas.js';
import { ModelEntrySchema, pickAlternativeModel } from './decomposer.js';
import { KNOWN_CLIS } from './decomposer.js';
import type { AgentPersona, FailureMode, PostHookResult, RemediationStrategy } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

const RemediationStrategySchema = z.enum([
  'retry_as_is',
  'retry_with_stronger_prompt',
  'retry_with_different_model',
  'retry_with_workspace_clean',
  'switch_executor',
  'escalate_to_operator',
  'soft_fail',
]);

const MutationSchema = z.object({
  field: z.enum(['model', 'executor_hint', 'prompt_prefix', 'timeout_seconds', 'workspace']),
  old_value: z.unknown(),
  new_value: z.unknown(),
  reason: z.string().min(1).max(500),
});

const FailureEventSchema = z.object({
  type: z.string().min(1),
  output: z.unknown().optional(),
  feedback: z.string().optional(),
  /** Stable failure-mode id from a persona's `mode` reject reason, if known. */
  mode: z.string().optional(),
});

export const FailoverClassifierInputSchema = z.object({
  task_id: z.string(),
  workflow_id: z.string(),
  failure_event: FailureEventSchema,
  retry_count: z.number().int().min(0),
  prior_failures: z
    .array(z.object({ type: z.string(), feedback: z.string().optional(), mode: z.string().optional() }))
    .optional(),
  task: DagTaskSchema,
  available_models: z.array(ModelEntrySchema),
  available_clis: z.array(z.enum(KNOWN_CLIS)).optional(),
});
export type FailoverClassifierInput = z.infer<typeof FailoverClassifierInputSchema>;

export const FailoverClassifierOutputSchema = z.object({
  strategy: RemediationStrategySchema,
  mutations: z.array(MutationSchema),
  reasoning: z.string().max(1_000),
  confidence: z.enum(['high', 'medium', 'low']),
  /** Set when the preHook's known-pattern table fired. */
  shortcut_id: z.string().optional(),
});
export type FailoverClassifierOutput = z.infer<typeof FailoverClassifierOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Known-pattern remediation table (preHook shortcut)
// ─────────────────────────────────────────────────────────────────────────────

interface KnownPattern {
  /** Stable id matched by mode or by detector. */
  id: string;
  /** Detector run on the failure_event when `mode` is not set. */
  match: (event: FailoverClassifierInput['failure_event']) => boolean;
  /** Build the canonical remediation for the given input. */
  build: (input: FailoverClassifierInput) => FailoverClassifierOutput;
}

const KNOWN_PATTERNS: readonly KnownPattern[] = [
  {
    id: 'worker.described_without_writing',
    match: (e) => e.mode === 'worker.described_without_writing' || /described_without_writing/i.test(e.type),
    build: (input) => ({
      strategy: 'retry_with_stronger_prompt',
      mutations: [
        {
          field: 'prompt_prefix',
          old_value: null,
          new_value:
            'Your previous attempt READ files but did not call Write. Acceptance demands file creation. Use the Write tool with file_path and content parameters NOW.',
          reason: 'Worker classified as described-without-writing — strengthen contract + workspace clean.',
        },
        {
          field: 'workspace',
          old_value: 'as-is',
          new_value: 'clean_prior_attempt_files',
          reason: 'Move stale stubs out of the way so the next attempt has nothing to "already exists" over.',
        },
      ],
      reasoning:
        'described_without_writing is the dominant failure mode for cli_spawn workers. Documented remediation: stronger prompt + workspace clean.',
      confidence: 'high',
      shortcut_id: 'worker.described_without_writing',
    }),
  },
  {
    id: 'worker.opencode_empty_output',
    match: (e) => e.mode === 'worker.opencode_empty_output' || /opencode.*empty/i.test(e.type),
    build: (input) => {
      const alt = pickAlternativeModel(input.task.model ?? undefined, input.available_models)
        ?? 'cc/claude-sonnet-4-6';
      return {
        strategy: 'retry_with_different_model',
        mutations: [
          {
            field: 'model',
            old_value: input.task.model ?? null,
            new_value: alt,
            reason:
              'opencode + opencode-go/* model returns empty output (D-H2.077). Switch to deepseek/anthropic/groq via the opencode allowlist.',
          },
        ],
        reasoning:
          'D-H2.077 documented bug: opencode + unsupported provider yields silent empty output. Hard model swap is the only fix.',
        confidence: 'high',
        shortcut_id: 'worker.opencode_empty_output',
      };
    },
  },
  {
    id: 'decomposer.prose_response',
    match: (e) => e.mode === 'decomposer.prose_response' || /prose_response/i.test(e.type),
    build: () => ({
      strategy: 'retry_with_stronger_prompt',
      mutations: [
        {
          field: 'prompt_prefix',
          old_value: null,
          new_value:
            'Your previous response was not JSON. The first character of your reply must be `{`. Repeat the request with NO preamble, NO markdown fences, NO trailing notes.',
          reason: 'Decomposer emitted prose preamble — re-issue with stricter contract.',
        },
      ],
      reasoning: 'Prose preamble before JSON breaks the parser. Stronger reminder is the canonical fix.',
      confidence: 'high',
      shortcut_id: 'decomposer.prose_response',
    }),
  },
  {
    id: 'worker.cli_unavailable',
    match: (e) => e.mode === 'worker.cli_unavailable' || /\bENOENT\b|\bcli not found\b|\bcommand not found\b/i.test(e.feedback ?? ''),
    build: (input) => ({
      strategy: 'switch_executor',
      mutations: [
        {
          field: 'executor_hint',
          old_value: input.task.executor_hint ?? null,
          new_value: 'cli:claude-code',
          reason: 'Configured CLI not installed; falling back to claude-code (always present).',
        },
      ],
      reasoning: 'CLI binary missing on this host; swap to a guaranteed-present CLI.',
      confidence: 'medium',
      shortcut_id: 'worker.cli_unavailable',
    }),
  },
  {
    id: 'consolidator.opus_unavailable',
    match: (e) => e.mode === 'consolidator.opus_unavailable' || /opus.*unavail|503.*opus|1m.*unavail/i.test(e.feedback ?? ''),
    build: (input) => ({
      strategy: 'retry_with_different_model',
      mutations: [
        {
          field: 'model',
          old_value: input.task.model ?? 'cc/claude-opus-4-7',
          new_value: 'cc/claude-sonnet-4-6',
          reason: 'Opus rolling availability — automatic sonnet fallback.',
        },
      ],
      reasoning: 'Opus 4.7 has known availability issues; sonnet is the documented fallback.',
      confidence: 'high',
      shortcut_id: 'consolidator.opus_unavailable',
    }),
  },
  {
    id: 'worker.timeout_first',
    match: (e) =>
      (e.mode === 'worker.timeout' || /\btimeout\b/i.test(e.type)) &&
      // First-time only — handled by preHook checking retry_count separately.
      true,
    build: (input) => {
      const oldTimeout = input.task.timeout_seconds ?? 600;
      const newTimeout = Math.min(1800, Math.round(oldTimeout * 1.5));
      return {
        strategy: 'retry_as_is',
        mutations: [
          {
            field: 'timeout_seconds',
            old_value: oldTimeout,
            new_value: newTimeout,
            reason: 'First timeout — give it 50% more time before assuming the model is wrong.',
          },
        ],
        reasoning: 'First-time timeouts are usually transient; bump the budget once before swapping models.',
        confidence: 'medium',
        shortcut_id: 'worker.timeout_first',
      };
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes (meta — failures of the classifier itself)
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<FailoverClassifierOutput>[] = [
  {
    id: 'failover.loop_guard_triggered',
    detect: () => false, // resolved in preHook by retry_count check
    remediation: 'escalate_to_operator',
    description: 'Retry count exceeded budget — escalating to operator regardless of strategy.',
  },
  {
    id: 'failover.no_remediation',
    detect: (output) => output.strategy === 'soft_fail' && output.mutations.length === 0,
    remediation: 'soft_fail',
    description: 'Classifier could not find any remediation — soft-fail keeps the cluster moving.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt (used only when no shortcut matches)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are the Omniforge Failover Classifier. Cheap, fast, decisive.

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Output contract — JSON only
{
  "strategy": "retry_as_is|retry_with_stronger_prompt|retry_with_different_model|retry_with_workspace_clean|switch_executor|escalate_to_operator|soft_fail",
  "mutations": [{ "field": "model|executor_hint|prompt_prefix|timeout_seconds|workspace", "old_value": ..., "new_value": ..., "reason": "..." }],
  "reasoning": "<one short paragraph naming the root cause>",
  "confidence": "high|medium|low"
}

First character MUST be \`{\`.

# Hard rules
\${HARD_RULES_NUMBERED}

# Forbidden
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Failure event
\${INPUT.failure_event|json}

# Retry count so far
\${INPUT.retry_count}

# Prior failures
\${INPUT.prior_failures|json}

# Task being remediated
\${INPUT.task|json}

# Available models
\${INPUT.available_models|json}

Pick the strategy with the highest probability of next-attempt success.`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_BUDGET = 3;

export const FAILOVER_CLASSIFIER_PERSONA: AgentPersona<FailoverClassifierInput, FailoverClassifierOutput> = {
  id: 'failover_classifier',
  version: '1.0.0',
  name: 'Failover Classifier',
  identity:
    'I am the cheap, fast (haiku) agent that decides what to do when something fails. I look at the failure context and pick a strategy: retry with stronger prompt, retry with different model, escalate to operator, or soft-fail. I run only on the failure path — never on success.',
  mission:
    'Classify a failure and pick the best remediation, optimizing for "next attempt has highest probability of success".',
  inputSchema: FailoverClassifierInputSchema,
  outputSchema: FailoverClassifierOutputSchema,
  hardRules: [
    `Don't loop. If retry_count >= ${RETRY_BUDGET}, default to escalate_to_operator unless the error is transient (rate limit, network).`,
    "Diagnose root cause first. Don't just \"try again\" without understanding why it failed.",
    'Cheap model. Use haiku — this stage runs frequently, cost matters.',
    "Mutations must be explicit. Don't say \"try harder\" — say \"swap cc/sonnet → cx/gpt-5.5 because sonnet has the described-without-writing pattern in 60% of frontend tasks per ledger\".",
  ],
  forbidden: [
    "Don't retry indefinitely.",
    "Don't mutate without naming the field/old/new.",
    "Don't escalate when you have a clear remediation in mind.",
  ],
  ambiguityProtocol: [
    {
      condition: 'Same failure type 3+ in a row',
      resolution: 'Switch model (highest-leverage mutation).',
      escalate: false,
    },
    {
      condition: 'Failure is rate-limit / 503',
      resolution: 'retry_as_is with backoff.',
      escalate: false,
    },
    {
      condition: "Failure is 'described without writing'",
      resolution: 'retry_with_stronger_prompt + workspace_clean.',
      escalate: false,
    },
    {
      condition: 'Failure is JSON parse on prose response',
      resolution: 'retry_with_stronger_prompt (force JSON).',
      escalate: false,
    },
    {
      condition: 'Failure is unrecognized',
      resolution: 'escalate (need human pattern detection).',
      escalate: true,
    },
  ],
  tools: [],
  permissions: { defaultAction: 'deny' },
  defaultModel: 'cc/claude-haiku-4-5-20251001',
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, ctx) => {
    // 1. Loop guard — escalate before LLM, regardless of pattern.
    if (input.retry_count >= RETRY_BUDGET) {
      const transientHints = ['rate_limit', 'overloaded', 'server_error', '503', '429'];
      const looksTransient = transientHints.some((h) =>
        (input.failure_event.type + ' ' + (input.failure_event.feedback ?? '')).toLowerCase().includes(h),
      );
      if (!looksTransient) {
        ctx.emit('failover_loop_guard', {
          task_id: input.task_id,
          retry_count: input.retry_count,
        });
        return {
          skipWithResult: {
            strategy: 'escalate_to_operator' as RemediationStrategy,
            mutations: [],
            reasoning: `Retry budget (${RETRY_BUDGET}) exhausted with non-transient failure type "${input.failure_event.type}". Operator review required.`,
            confidence: 'high' as const,
            shortcut_id: 'failover.loop_guard_triggered',
          },
        };
      }
    }

    // 2. Known-pattern shortcuts — skip the LLM call when we have a canonical fix.
    for (const pattern of KNOWN_PATTERNS) {
      // Skip the timeout-first shortcut after the first attempt
      if (pattern.id === 'worker.timeout_first' && input.retry_count > 0) continue;
      if (pattern.match(input.failure_event)) {
        ctx.emit('failover_shortcut', {
          task_id: input.task_id,
          shortcut_id: pattern.id,
        });
        return { skipWithResult: pattern.build(input) };
      }
    }

    return input;
  },

  postHook: async (input, output): Promise<PostHookResult<FailoverClassifierOutput>> => {
    // The classifier MUST justify each mutation; reject opaque ones.
    for (const m of output.mutations) {
      if (!m.reason || m.reason.trim().length < 5) {
        return {
          rejectWithReason: 'failover.opaque_mutation: every mutation requires a non-empty reason explaining the swap.',
          mode: 'failover.opaque_mutation',
        };
      }
    }
    return output;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Test/utility: expose pattern matcher for unit tests
// ─────────────────────────────────────────────────────────────────────────────

export function matchKnownFailurePattern(
  event: FailoverClassifierInput['failure_event'],
): string | null {
  for (const p of KNOWN_PATTERNS) {
    if (p.match(event)) return p.id;
  }
  return null;
}
