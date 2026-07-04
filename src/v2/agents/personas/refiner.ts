/**
 * REFINER_PERSONA — minimal-diff DAG mutator.
 *
 * Takes an existing DAG plus a piece of feedback (from operator, reviewer, or
 * failover classifier) and produces the SMALLEST mutation that addresses the
 * feedback. This is NOT the Decomposer — Refiner never redesigns from scratch.
 *
 * Failure modes the postHook guards against:
 *   - refiner.over_diff       — > 50% of tasks changed (use Decomposer instead)
 *   - refiner.empty_changelog — every mutation must be explained
 *   - refiner.broken_deps     — depends_on references task ids that don't exist
 *   - refiner.id_collision    — same id used twice
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §2.
 */

import { z } from 'zod';

import { DagTaskSchema } from '../../../types/schemas.js';
import { ModelEntrySchema } from './decomposer.js';
import type { AgentPersona, FailureMode, PostHookResult } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

const FeedbackOriginSchema = z.enum(['operator', 'reviewer', 'failover', 'auto_repair']);

export const RefinerInputSchema = z.object({
  workspace: z.string().min(1),
  workflow_id: z.string().min(1),
  current_dag: z.object({ tasks: z.array(DagTaskSchema).min(1) }),
  feedback_text: z.string().min(1).max(8_000),
  feedback_origin: FeedbackOriginSchema,
  failed_task_ids: z.array(z.string()).optional(),
  available_models: z.array(ModelEntrySchema),
  available_clis: z.array(z.string()),
  /** Caller hint: how many times this same task has been retried already. */
  retry_count_for_failed: z.number().int().min(0).optional(),
});
export type RefinerInput = z.infer<typeof RefinerInputSchema>;

export const RefinerOutputSchema = z.object({
  tasks: z.array(DagTaskSchema).min(1).max(40),
  changelog: z.array(z.string()).min(1),
  preserved_task_ids: z.array(z.string()),
  added_task_ids: z.array(z.string()),
  removed_task_ids: z.array(z.string()),
  rationale: z.string().max(2_000),
});
export type RefinerOutput = z.infer<typeof RefinerOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<RefinerOutput>[] = [
  {
    id: 'refiner.over_diff',
    detect: () => false, // resolved synchronously inside postHook
    remediation: 'escalate_to_operator',
    description: '> 50% of original DAG was changed; use Decomposer instead.',
  },
  {
    id: 'refiner.empty_changelog',
    detect: (output) => output.changelog.length === 0,
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition: 'Your previous response had an empty changelog. Every mutation requires a one-line explanation in `changelog`.',
  },
  {
    id: 'refiner.broken_deps',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    description: 'A task.depends_on references an id that does not exist in tasks[].',
  },
  {
    id: 'refiner.id_collision',
    detect: (output) => {
      const seen = new Set<string>();
      for (const t of output.tasks) {
        if (seen.has(t.id)) return true;
        seen.add(t.id);
      }
      return false;
    },
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition: 'Your previous DAG had duplicate task ids. Each id must be unique.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are the Omniforge Refiner. Read your role once, never deviate.

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Output contract — JSON only

You MUST respond with ONLY this JSON object (no preamble, no markdown fences):

{
  "tasks": [ /* full DAG with mutations applied — preserve original ids */ ],
  "changelog": [ "t3: timeout 600s -> 1200s (was hitting limit)", ... ],
  "preserved_task_ids": ["t1","t2",...],
  "added_task_ids": [],
  "removed_task_ids": [],
  "rationale": "<one paragraph>"
}

The first character of your response MUST be \`{\`.

# Hard rules
\${HARD_RULES_NUMBERED}

# Forbidden
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Available models
\${INPUT.available_models|json}

# Available CLIs
\${INPUT.available_clis|join, }

# Current DAG
\${INPUT.current_dag|json}

# Feedback (\${INPUT.feedback_origin})
\${INPUT.feedback_text}

# Failed task ids
\${INPUT.failed_task_ids|json}

Now produce the revised DAG.`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_BUDGET_EXHAUSTED_REASON =
  'retry budget exhausted; manual intervention required.';

export const REFINER_PERSONA: AgentPersona<RefinerInput, RefinerOutput> = {
  id: 'refiner',
  version: '1.0.0',
  name: 'Refiner',
  identity:
    'I am the Refiner. I take an existing DAG and a piece of feedback (from operator, reviewer, or failover classifier) and produce a revised DAG with the SMALLEST possible mutation that addresses the feedback. I am NOT the Decomposer — I never redesign from scratch. I preserve task IDs, edge structure, and operator intent unless changing them is unavoidable.',
  mission:
    'Mutate a DAG minimally to address feedback while preserving downstream event continuity.',
  inputSchema: RefinerInputSchema,
  outputSchema: RefinerOutputSchema,
  hardRules: [
    'Preserve task IDs. Downstream events reference them; rename only when adding NEW tasks or removing EXISTING ones.',
    'Smallest diff wins. If feedback says "task t3 timed out", just bump t3.timeout_seconds. Don\'t restructure t1-t10.',
    'Changelog is mandatory. Every mutation gets one line explaining what + why.',
    "Don't renumber. If you remove t5, don't shift t6→t5. Leave gaps.",
    'JSON only. First character `{`. No preamble, no markdown fences.',
    'Respect dependency invariants. New tasks\' depends_on must reference existing ids.',
    "Don't change models silently. Mention model swaps in changelog with reason.",
    "Don't reduce parallelism. Two parallel tasks remain parallel unless feedback explicitly serializes them.",
  ],
  forbidden: [
    'No full redesigns. If feedback requires > 50% of tasks changed, return error and recommend re-decomposing.',
    'No silent model swaps.',
    'No unilateral parallelism reduction.',
    "No fabricating rationale. If you can't explain a mutation in changelog, don't make the mutation.",
    'No injecting new HITL gates unless feedback explicitly requests one.',
  ],
  ambiguityProtocol: [
    {
      condition: 'Feedback is vague ("it failed")',
      resolution: 'Request specifics — emit single-task DAG with kind=llm_call name="Clarify feedback", recommend HITL gate.',
      escalate: true,
    },
    {
      condition: 'Feedback contradicts current DAG structure',
      resolution: 'Honor feedback, note contradiction in rationale.',
      escalate: false,
    },
    {
      condition: 'Feedback removes a task that has dependents',
      resolution: 'Remove the task AND its dependents. List all in changelog.',
      escalate: false,
    },
    {
      condition: 'Two feedback origins disagree (reviewer vs operator)',
      resolution: 'Operator wins. Note in rationale.',
      escalate: false,
    },
    {
      condition: 'Feedback requires switching model but not in catalog',
      resolution: 'Pick closest available, note in rationale.',
      escalate: false,
    },
  ],
  tools: [],
  permissions: { defaultAction: 'allow', tools: { Bash: 'deny' } },
  defaultModel: 'cc/claude-sonnet-4-6',
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, _ctx) => {
    // If reviewer is the feedback origin AND retry budget exhausted,
    // short-circuit with a no-op result so the cluster moves to escalation
    // instead of looping the refine path.
    if (
      input.feedback_origin === 'reviewer' &&
      (input.retry_count_for_failed ?? 0) >= 3
    ) {
      const tasks = input.current_dag.tasks;
      const ids = tasks.map((t) => t.id);
      return {
        skipWithResult: {
          tasks,
          changelog: [`No mutation — ${RETRY_BUDGET_EXHAUSTED_REASON}`],
          preserved_task_ids: ids,
          added_task_ids: [],
          removed_task_ids: [],
          rationale: RETRY_BUDGET_EXHAUSTED_REASON,
        },
      };
    }
    return input;
  },

  postHook: async (input, output): Promise<PostHookResult<RefinerOutput>> => {
    // 1. Diff cap (over_diff failure mode)
    const originalCount = input.current_dag.tasks.length;
    const churn = output.added_task_ids.length + output.removed_task_ids.length;
    if (originalCount > 0 && churn / originalCount > 0.5) {
      return {
        rejectWithReason: `refiner.over_diff: ${churn}/${originalCount} tasks added or removed (> 50%). Use Decomposer instead of Refiner for changes this large.`,
        mode: 'refiner.over_diff',
      };
    }

    // 2. Id uniqueness
    const seen = new Set<string>();
    for (const task of output.tasks) {
      if (seen.has(task.id)) {
        return {
          rejectWithReason: `refiner.id_collision: task id "${task.id}" used more than once`,
          mode: 'refiner.id_collision',
        };
      }
      seen.add(task.id);
    }

    // 3. depends_on integrity
    const ids = new Set(output.tasks.map((t) => t.id));
    for (const task of output.tasks) {
      for (const dep of task.depends_on) {
        if (!ids.has(dep)) {
          return {
            rejectWithReason: `refiner.broken_deps: task ${task.id} depends_on missing id "${dep}"`,
            mode: 'refiner.broken_deps',
          };
        }
      }
    }

    // 4. Changelog mandatory
    if (output.changelog.length === 0) {
      return {
        rejectWithReason: 'refiner.empty_changelog: at least one changelog entry is required',
        mode: 'refiner.empty_changelog',
      };
    }

    return output;
  },
};
