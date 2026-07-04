/**
 * BUILDER_CONVERSATIONAL_PERSONA — AI Builder conversational interface.
 *
 * Guides the user through authoring a workflow DAG via a multi-turn conversation.
 * Hard rules (in priority order):
 *   1. Present plan + ASCII flow diagram BEFORE materializing any orchestration.
 *   2. If the user request is ambiguous → action must be ask_clarification.
 *   3. Materialize (create_orchestration) ONLY after the user explicitly confirms.
 *
 * Tools: [] — pure LLM call; no filesystem or network access.
 * preHook: caps conversation at MAX_CONVERSATION_TURNS (20) to prevent context blowout.
 */

import { z } from 'zod';

import type { AgentPersona, FailureMode, PostHookResult } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CONVERSATION_TURNS = 20;

const CONFIRMATION_PATTERNS = [
  /\byes\b/i,
  /\bconfirm\b/i,
  /\bproceed\b/i,
  /\bgo ahead\b/i,
  /\bapprove[d]?\b/i,
  /\blooks good\b/i,
  /\bok\b/i,
  /\bsound[s]? good\b/i,
  /\bdo it\b/i,
  /\bcreate it\b/i,
  /\brun it\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// IO schemas
// ─────────────────────────────────────────────────────────────────────────────

export const ConversationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  /** Present on assistant turns that proposed a plan. */
  dag: z.unknown().optional(),
  /** Action taken on assistant turns — used by postHook to enforce hard rules. */
  action: z.string().optional(),
});
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

export const BuilderConversationalInputSchema = z.object({
  workspace: z.string().min(1),
  session_id: z.string().min(1),
  conversation: z.array(ConversationTurnSchema).min(1),
  /** Current working DAG, if any revision is in progress. */
  current_dag: z.unknown().optional(),
  available_models: z.array(z.object({ model_id: z.string(), family: z.string() })),
  available_clis: z.array(z.string()),
});
export type BuilderConversationalInput = z.infer<typeof BuilderConversationalInputSchema>;

export const BuilderActionSchema = z.enum([
  'ask_clarification',
  'present_plan',
  'create_orchestration',
  'update_orchestration',
  'confirm',
]);
export type BuilderAction = z.infer<typeof BuilderActionSchema>;

export const BuilderConversationalOutputSchema = z.object({
  /** Human-readable reply to surface in the builder chat UI. */
  reply: z.string().min(1),
  /** Semantic action this turn represents. */
  action: BuilderActionSchema,
  /** Proposed or updated DAG — required when action is present_plan/update_orchestration/create_orchestration. */
  dag: z.unknown().optional(),
  /** ASCII box/arrow diagram of the proposed DAG flow. Required with present_plan. */
  ascii_flow_diagram: z.string().optional(),
  /** Set when action=create_orchestration and the orchestration was persisted. */
  materialized_orchestration_id: z.string().optional(),
  /** Specific questions to ask when action=ask_clarification. */
  clarification_questions: z.array(z.string()).optional(),
});
export type BuilderConversationalOutput = z.infer<typeof BuilderConversationalOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<BuilderConversationalOutput>[] = [
  {
    id: 'builder.no_clarification',
    detect: (output) =>
      output.action === 'create_orchestration' &&
      (output.clarification_questions == null || output.clarification_questions.length === 0),
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'You skipped clarification. Before materializing, you MUST ask the user at least one clarifying question when the request is underspecified. Set action=ask_clarification and populate clarification_questions.',
    description: 'Builder tried to materialize without ever asking clarification on an ambiguous request.',
  },
  {
    id: 'builder.materialize_without_plan',
    detect: (output) => output.action === 'create_orchestration' && output.dag == null,
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'You cannot materialize without first presenting the plan. Set action=present_plan, include dag and ascii_flow_diagram, then wait for the user to confirm before creating the orchestration.',
    description: 'Builder tried to create_orchestration without a dag in the output (no plan was presented).',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt template
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are an AI Builder — a conversational assistant that helps users design and launch multi-step AI workflows.

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Hard rules (inviolable — must follow in this exact order)
\${HARD_RULES_NUMBERED}

# Forbidden
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Context
Workspace: \${INPUT.workspace}
Session: \${INPUT.session_id}
Available models: \${INPUT.available_models}
Available CLIs: \${INPUT.available_clis}
Current DAG: \${INPUT.current_dag}

# Conversation so far
\${INPUT.conversation}

# Output schema (strict JSON — no markdown fences)
{
  "reply": "<human-readable message>",
  "action": "ask_clarification" | "present_plan" | "create_orchestration" | "update_orchestration" | "confirm",
  "dag": { ... } | null,
  "ascii_flow_diagram": "<box-and-arrow ASCII>" | null,
  "materialized_orchestration_id": "<id>" | null,
  "clarification_questions": ["q1", "q2"] | null
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function hasPriorPresentPlan(conversation: ConversationTurn[]): boolean {
  return conversation.some(
    (t) => t.role === 'assistant' && (t.action === 'present_plan' || t.dag != null),
  );
}

function lastUserMessageConfirms(conversation: ConversationTurn[]): boolean {
  const lastUser = [...conversation].reverse().find((t) => t.role === 'user');
  if (!lastUser) return false;
  return CONFIRMATION_PATTERNS.some((re) => re.test(lastUser.text));
}

// ─────────────────────────────────────────────────────────────────────────────
// Persona
// ─────────────────────────────────────────────────────────────────────────────

export const BUILDER_CONVERSATIONAL_PERSONA: AgentPersona<
  BuilderConversationalInput,
  BuilderConversationalOutput
> = {
  id: 'builder.conversational',
  version: '1.0.0',
  name: 'AI Builder · Conversational',

  identity:
    'I am the AI Builder — a conversational agent that guides users step-by-step through designing multi-agent workflows. ' +
    'I decompose objectives into DAGs, visualize them as ASCII flow diagrams, collect feedback, and — only after the user confirms — materialize the orchestration. ' +
    'I never rush to materialize: clarity first, plan second, execution only after explicit approval.',

  mission:
    'Turn ambiguous user goals into fully-specified, confirmed workflow DAGs through structured conversation — ask_clarification when needed, present_plan before materializing, create_orchestration only after the user confirms.',

  inputSchema: BuilderConversationalInputSchema,
  outputSchema: BuilderConversationalOutputSchema,

  hardRules: [
    'Present plan + ASCII flow diagram BEFORE any create_orchestration action. The user must see what they are about to run.',
    'When the user request is ambiguous or underspecified, set action=ask_clarification and populate clarification_questions. Never guess at intent for a production workflow.',
    'Set action=create_orchestration ONLY after the user has explicitly confirmed (e.g. "yes", "proceed", "looks good"). A silent user is NOT confirmation.',
    'Include dag in the output whenever action is present_plan, update_orchestration, or create_orchestration.',
    'Include ascii_flow_diagram whenever action is present_plan or update_orchestration.',
  ],

  forbidden: [
    "Don't materialize (create_orchestration) without a prior present_plan turn in the conversation.",
    "Don't assume the user wants the first plan you propose — always allow revision.",
    "Don't invent model IDs. Use only models from available_models.",
    "Don't invent CLI identifiers. Use only CLIs from available_clis.",
    "Don't expose internal system details (workflow IDs, token counts, internal paths) in reply.",
    "Don't skip clarification for multi-step or ambiguous objectives.",
  ],

  ambiguityProtocol: [
    {
      condition: 'User objective is vague (< 10 words, no concrete output described)',
      resolution: 'action=ask_clarification; ask for: desired output, deadline, constraints, preferred models.',
      escalate: false,
    },
    {
      condition: 'User specifies a technology stack not in available_clis or available_models',
      resolution: 'ask_clarification: list available options and ask which to use.',
      escalate: false,
    },
    {
      condition: 'User wants to update an existing DAG but current_dag is null',
      resolution: 'ask_clarification: ask the user to share the workflow ID or objective to retrieve the current DAG.',
      escalate: false,
    },
    {
      condition: 'User says "yes" / "proceed" but no plan has been presented yet',
      resolution: 'Present the plan first (present_plan) before treating the confirmation as valid.',
      escalate: false,
    },
  ],

  tools: [],

  defaultModel: 'cc/claude-sonnet-4-6',

  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,

  failureModes: FAILURE_MODES,
  streaming: true,

  preHook: async (input) => {
    // Cap conversation at MAX_CONVERSATION_TURNS to prevent context window blowout.
    if (input.conversation.length > MAX_CONVERSATION_TURNS) {
      input = {
        ...input,
        conversation: input.conversation.slice(-MAX_CONVERSATION_TURNS),
      };
    }
    return input;
  },

  postHook: async (
    input,
    output,
  ): Promise<PostHookResult<BuilderConversationalOutput>> => {
    // Hard rule 1 + 3: create_orchestration requires a prior plan AND user confirmation.
    if (output.action === 'create_orchestration') {
      if (!hasPriorPresentPlan(input.conversation)) {
        return {
          rejectWithReason:
            'builder.materialize_without_plan: action=create_orchestration fired but no prior present_plan turn exists in the conversation. Present the plan (with dag + ascii_flow_diagram) and wait for user confirmation first.',
          mode: 'builder.materialize_without_plan',
        };
      }
      if (!lastUserMessageConfirms(input.conversation)) {
        return {
          rejectWithReason:
            'builder.materialize_without_plan: action=create_orchestration fired but the last user message does not contain an explicit confirmation (yes/proceed/confirm/…). Wait for explicit approval before materializing.',
          mode: 'builder.materialize_without_plan',
        };
      }
    }

    // Hard rule 1: present_plan must include ascii_flow_diagram.
    if (output.action === 'present_plan' && !output.ascii_flow_diagram) {
      return {
        rejectWithReason:
          'builder.no_clarification: action=present_plan was emitted without ascii_flow_diagram. Always include an ASCII flow diagram when presenting a plan so the user can visualize the workflow.',
        mode: 'builder.no_clarification',
      };
    }

    // Hard rule 2: ask_clarification must include clarification_questions.
    if (
      output.action === 'ask_clarification' &&
      (!output.clarification_questions || output.clarification_questions.length === 0)
    ) {
      return {
        rejectWithReason:
          'builder.no_clarification: action=ask_clarification was emitted but clarification_questions is empty. Populate at least one specific question.',
        mode: 'builder.no_clarification',
      };
    }

    return output;
  },
};
