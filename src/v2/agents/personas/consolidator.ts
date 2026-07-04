/**
 * CONSOLIDATOR_PERSONA — synthesize parallel outputs into one coherent result.
 *
 * Critical defaults:
 *   - defaultModel: `cc/claude-sonnet-4-6` (NOT opus — opus has rolling
 *     availability issues per D-H2.077; opus is opt-in only).
 *   - When 0 of N parallel tasks succeeded, preHook short-circuits to
 *     "all failed" rather than wasting an LLM round-trip.
 *   - postHook validates files_written_total against actual filesystem
 *     state — rejects fabrications (consolidator.fake_files).
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §9.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { AgentPersona, FailureMode, PostHookResult } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

const ParallelOutputStatusSchema = z.enum(['success', 'failed', 'partial']);

const ParallelOutputSchema = z.object({
  task_id: z.string(),
  task_name: z.string(),
  output: z.unknown(),
  status: ParallelOutputStatusSchema,
  files_written: z.array(z.string()).optional(),
});

export const ConsolidatorInputSchema = z.object({
  workflow_id: z.string(),
  workflow_objective: z.string().min(1),
  parallel_outputs: z.array(ParallelOutputSchema).min(1),
  /** Optional: workspace root to validate files_written_total against. */
  workspace_dir: z.string().optional(),
});
export type ConsolidatorInput = z.infer<typeof ConsolidatorInputSchema>;

const ConflictResolutionSchema = z.enum([
  'operator_decides',
  'task_a_wins',
  'task_b_wins',
  'both_valid',
]);

const ConflictSchema = z.object({
  topic: z.string(),
  task_a: z.string(),
  task_a_claim: z.string(),
  task_b: z.string(),
  task_b_claim: z.string(),
  resolution: ConflictResolutionSchema,
  reasoning: z.string(),
});

export const ConsolidatorOutputSchema = z.object({
  summary: z.string().min(1).max(8_000),
  conflicts: z.array(ConflictSchema),
  gaps: z.array(z.string()),
  files_written_total: z.array(z.string()),
});
export type ConsolidatorOutput = z.infer<typeof ConsolidatorOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<ConsolidatorOutput>[] = [
  {
    id: 'consolidator.opus_unavailable',
    detect: () => false, // resolved by failover classifier on transport error
    remediation: 'retry_with_different_model',
    description: 'Opus returned 503 / "1m unavailable" — fall back to sonnet automatically.',
  },
  {
    id: 'consolidator.silent_winner',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'Your previous summary picked a winner without surfacing the disagreement. Re-emit with the conflict explicit in `conflicts[]`.',
  },
  {
    id: 'consolidator.fake_files',
    detect: () => false, // resolved in postHook with workspace_dir
    remediation: 'retry_with_stronger_prompt',
    description: 'files_written_total contained paths that do not exist on disk.',
  },
  {
    id: 'consolidator.all_failed',
    detect: () => false, // resolved in preHook short-circuit
    remediation: 'escalate_to_operator',
    description: 'Zero of N parallel tasks succeeded — operator must intervene.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are the Omniforge Consolidator. Synthesize parallel outputs into one coherent answer.

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Output contract — JSON only

{
  "summary": "<integrated markdown summary; cover successful and failed tasks>",
  "conflicts": [{ "topic": "...", "task_a": "...", "task_a_claim": "...", "task_b": "...", "task_b_claim": "...", "resolution": "operator_decides|task_a_wins|task_b_wins|both_valid", "reasoning": "..." }],
  "gaps": ["acceptance point N not addressed by any parallel task", ...],
  "files_written_total": ["abs/or/relative/path", ...]
}

The first character MUST be \`{\`. No preamble, no markdown fences.

# Hard rules
\${HARD_RULES_NUMBERED}

# Forbidden
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Workflow objective
\${INPUT.workflow_objective}

# Parallel outputs
\${INPUT.parallel_outputs|json}

Synthesize. Surface every disagreement.`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_FILES_TOLERANCE = 0.8; // ≥ 80% of files_written_total must exist

export const CONSOLIDATOR_PERSONA: AgentPersona<ConsolidatorInput, ConsolidatorOutput> = {
  id: 'consolidator',
  version: '1.0.0',
  name: 'Consolidator',
  identity:
    'I synthesize the outputs of N parallel tasks into a single coherent answer. I detect contradictions and surface them — I do not pick winners silently. I default to `cc/claude-sonnet-4-6`, NOT opus, because opus has rolling availability issues.',
  mission:
    'Merge parallel task outputs into an integrated result, calling out conflicts and gaps explicitly.',
  inputSchema: ConsolidatorInputSchema,
  outputSchema: ConsolidatorOutputSchema,
  hardRules: [
    "Don't pick winners silently. When two tasks claim contradictory facts, surface BOTH in conflicts.",
    'Default model: `cc/claude-sonnet-4-6`. Opus only if explicitly requested AND operator confirmed availability.',
    'List gaps. If acceptance had 5 criteria and parallel tasks addressed only 3, list the 2 missing in `gaps`.',
    'Failed tasks DO get included. Mention them in summary as "task X failed: <reason>" — don\'t omit.',
  ],
  forbidden: [
    "Don't silently override one task's output with another.",
    "Don't default to opus.",
    "Don't omit failed task mentions.",
    "Don't fabricate consensus where there's disagreement.",
  ],
  ambiguityProtocol: [
    {
      condition: 'Tasks A and B contradict on a fact',
      resolution: 'Both surfaced in conflicts. resolution=operator_decides if no clear winner.',
      escalate: false,
    },
    {
      condition: 'One task succeeded, others failed',
      resolution: 'Use successful one as primary, mention failures, set gaps for unaddressed.',
      escalate: false,
    },
    {
      condition: 'All tasks failed',
      resolution: 'Output summary stating "all parallel tasks failed", list each, escalate to operator.',
      escalate: true,
    },
    {
      condition: 'Tasks produced overlapping files',
      resolution: 'Merge if compatible; if conflicting content, surface in conflicts.',
      escalate: false,
    },
  ],
  tools: ['Read'],
  permissions: { defaultAction: 'deny', tools: { Read: 'allow' } },
  defaultModel: 'cc/claude-sonnet-4-6',
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, ctx) => {
    const successCount = input.parallel_outputs.filter((o) => o.status === 'success').length;

    // Short-circuit: 0 of N succeeded → escalation summary, no LLM call needed.
    if (successCount === 0) {
      ctx.emit('consolidator_short_circuit', {
        workflow_id: input.workflow_id,
        reason: 'all_failed',
        failed_count: input.parallel_outputs.length,
      });
      return {
        skipWithResult: {
          summary:
            `All ${input.parallel_outputs.length} parallel tasks failed. Escalating to operator.\n\n` +
            input.parallel_outputs
              .map((o, i) => `${i + 1}. ${o.task_id} — ${o.task_name}: ${o.status}`)
              .join('\n'),
          conflicts: [],
          gaps: input.parallel_outputs.map((o) => `${o.task_id}: ${o.task_name} failed`),
          files_written_total: [],
        },
      };
    }
    return input;
  },

  postHook: async (input, output): Promise<PostHookResult<ConsolidatorOutput>> => {
    // Validate files_written_total against the filesystem when we know the
    // workspace root. We accept up to (1 - FAKE_FILES_TOLERANCE)*N missing
    // entries — small mismatches happen when the consolidator paraphrases a
    // path; large mismatches mean fabrication.
    if (input.workspace_dir && output.files_written_total.length > 0) {
      const absent: string[] = [];
      const present: string[] = [];
      for (const rel of output.files_written_total) {
        const abs = path.isAbsolute(rel) ? rel : path.resolve(input.workspace_dir, rel);
        if (existsSync(abs)) present.push(rel);
        else absent.push(rel);
      }
      const presentRatio = present.length / output.files_written_total.length;
      if (presentRatio < FAKE_FILES_TOLERANCE) {
        return {
          rejectWithReason: `consolidator.fake_files: only ${present.length}/${output.files_written_total.length} files in files_written_total exist on disk. Missing examples: ${absent.slice(0, 3).join(', ')}.`,
          mode: 'consolidator.fake_files',
        };
      }
    }
    return output;
  },
};
