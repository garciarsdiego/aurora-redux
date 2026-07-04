/**
 * WORKER_LLM_CALL_PERSONA — direct LLM call, no filesystem, no tools.
 *
 * This persona handles tasks where the worker just needs to think + emit text
 * (or structured JSON). It is NOT allowed to touch the filesystem; if the
 * prompt requests file ops the worker must respond with `<WRONG_KIND>...
 * </WRONG_KIND>` so the executor reroutes the task to cli_spawn or tool_call.
 *
 * Failure modes:
 *   - worker_llm.wrong_kind_attempted — model emitted <WRONG_KIND>
 *   - worker_llm.schema_violation     — json_schema parse failed
 *   - worker_llm.refusal              — model safety refusal
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §4.
 */

import { z } from 'zod';

import { HANDOFF_SCHEMA_SNIPPET, WORKER_LLM_NO_TOOLS_REMINDER } from '../prompts/prefixes.js';
import type { AgentPersona, FailureMode } from '../types.js';
import { extractHandoffSections } from '../../handoff/extract.js';
import type { ParsedHandoff } from '../../handoff/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

const ResponseFormatSchema = z.enum(['text', 'json', 'json_schema']);

export const WorkerLlmCallInputSchema = z.object({
  task_id: z.string(),
  model: z.string(),
  prompt: z.string().min(1),
  response_format: ResponseFormatSchema.default('text'),
  /** Required when response_format = 'json_schema'. Validated against output. */
  json_schema: z.unknown().optional(),
  upstream_artifacts: z
    .array(
      z.object({
        task_id: z.string(),
        summary: z.string(),
      }),
    )
    .optional(),
  max_tokens: z.number().int().min(1).optional(),
});
export type WorkerLlmCallInput = z.infer<typeof WorkerLlmCallInputSchema>;

export const WorkerLlmCallOutputSchema = z.object({
  output: z.union([z.string(), z.record(z.string(), z.unknown())]),
  format_used: ResponseFormatSchema,
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  /** Parsed handoff sections when format_used = 'text'. Populated by postHook. */
  parsed_handoff: z.custom<ParsedHandoff>().optional(),
});
export type WorkerLlmCallOutput = z.infer<typeof WorkerLlmCallOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FILE_VERBS_RE = /\b(write|edit|read file|read the file|run\s+(?:bash|shell|cmd)|execute (?:python|bash|shell)|touch|mkdir|rm|chmod)\b/i;
const WRONG_KIND_RE = /<WRONG_KIND>([^<]*)<\/WRONG_KIND>/i;

function asString(output: WorkerLlmCallOutput['output']): string {
  return typeof output === 'string' ? output : JSON.stringify(output);
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<WorkerLlmCallOutput>[] = [
  {
    id: 'worker_llm.wrong_kind_attempted',
    detect: (output) => WRONG_KIND_RE.test(asString(output.output)),
    remediation: 'escalate_to_operator',
    description: 'Decomposer picked llm_call but the prompt requires filesystem access.',
  },
  {
    id: 'worker_llm.schema_violation',
    detect: () => false, // resolved in postHook with the actual schema
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition: 'Your previous response did not match the requested JSON schema. Re-emit STRICTLY matching the schema.',
  },
  {
    id: 'worker_llm.refusal',
    detect: (output) => /\b(I can(?:'|no)t help|I'm sorry,?\s+but|I (?:must|have to) (?:decline|refuse))\b/i.test(asString(output.output)),
    remediation: 'escalate_to_operator',
    description: 'Model safety refusal — operator must intervene.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an LLM-only worker (no tools, no filesystem).

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Hard rules
\${HARD_RULES_NUMBERED}

# Forbidden
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Output format
\${INPUT.response_format}

# Optional schema (only when format = json_schema)
\${INPUT.json_schema|json}

# Upstream artifacts (cite by task_id when used)
\${INPUT.upstream_artifacts|json}

# Task
\${INPUT.prompt}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

export const WORKER_LLM_CALL_PERSONA: AgentPersona<WorkerLlmCallInput, WorkerLlmCallOutput> = {
  id: 'worker.llm_call',
  version: '1.0.0',
  name: 'Worker · LLM Call',
  identity:
    'I am a direct LLM call without filesystem access. My output is text or structured JSON consumed by downstream tasks. I produce — I don\'t act on the world. I never claim to have done filesystem work.',
  mission:
    'Generate the requested text or structured output, validated against the schema, and return it cleanly.',
  inputSchema: WorkerLlmCallInputSchema,
  outputSchema: WorkerLlmCallOutputSchema,
  hardRules: [
    'Honor response_format strictly. If json_schema, output must validate against it. No prose wrapping.',
    'No tool calls. This stage doesn\'t have tools. If you need one, the upstream Decomposer picked the wrong kind — emit <WRONG_KIND>...</WRONG_KIND>.',
    'Cite source artifacts. When using upstream_artifacts, reference them by task_id in your output.',
    "Don't fabricate. If you don't know something, say so.",
  ],
  forbidden: [
    'No filesystem operations (no Read/Write).',
    'No bash commands.',
    'No web fetches.',
    'No claims of having "done" work — only producing text.',
  ],
  ambiguityProtocol: [
    {
      condition: 'Asked to perform filesystem op',
      resolution: 'Refuse with <WRONG_KIND>this requires cli_spawn or tool_call</WRONG_KIND>.',
      escalate: true,
    },
    {
      condition: "Schema doesn't match expected output",
      resolution: "Try to coerce; if can't, return error in expected schema shape.",
      escalate: false,
    },
  ],
  tools: [],
  permissions: { defaultAction: 'deny' },
  defaultModel: 'cc/claude-sonnet-4-6',
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,
  streaming: true,

  preHook: async (input, _ctx) => {
    // When the prompt mentions filesystem verbs we prepend the no-tools
    // reminder so the model is forewarned to emit <WRONG_KIND> instead of
    // pretending to act on the world.
    if (FILE_VERBS_RE.test(input.prompt)) {
      input.prompt = `${WORKER_LLM_NO_TOOLS_REMINDER}\n${input.prompt}`;
    }

    // Append handoff schema for text responses so the carry-compactor can parse output.
    if (input.response_format === 'text' && !input.prompt.includes('=== RESPONSE FORMAT (handoff schema) ===')) {
      input.prompt += HANDOFF_SCHEMA_SNIPPET;
    }

    return input;
  },

  postHook: async (input, output, ctx) => {
    // Wrong-kind sentinel — escalate.
    const text = asString(output.output);
    if (WRONG_KIND_RE.test(text)) {
      return {
        rejectWithReason: `worker_llm.wrong_kind_attempted: model emitted <WRONG_KIND>. The Decomposer picked llm_call but the prompt requires filesystem access. Switch task kind to cli_spawn or tool_call.`,
        mode: 'worker_llm.wrong_kind_attempted',
      };
    }

    // json_schema enforcement
    if (input.response_format === 'json_schema' && input.json_schema) {
      // We only do a lightweight presence/structure check here — full json_schema
      // validation would require a JSON Schema library; the runner does the
      // outputSchema parse separately. The persona contract reduces to: when
      // json_schema is requested, output must be an object (not a string).
      if (typeof output.output !== 'object' || output.output === null) {
        return {
          rejectWithReason: 'worker_llm.schema_violation: response_format=json_schema but output is not a JSON object',
          mode: 'worker_llm.schema_violation',
        };
      }
    }

    // json (loose) enforcement
    if (input.response_format === 'json' && typeof output.output !== 'object') {
      return {
        rejectWithReason: 'worker_llm.schema_violation: response_format=json but output is a string',
        mode: 'worker_llm.schema_violation',
      };
    }

    // Parse handoff sections for text responses
    if (input.response_format === 'text' && typeof output.output === 'string') {
      const parsedHandoff = extractHandoffSections(output.output);
      output.parsed_handoff = parsedHandoff;
      if (!parsedHandoff.sawHeading) {
        ctx.emit('handoff_schema_missed', {
          task_id: input.task_id,
          reason: 'LLM worker text response did not contain handoff section headings.',
        });
        ctx.warn('handoff_schema_missed: llm_call text response lacks handoff headings.', {
          task_id: input.task_id,
        });
      }
    }

    return output;
  },
};
