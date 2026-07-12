/**
 * REVIEWER_PERSONA — skeptical critic with filesystem-first verification.
 *
 * The reviewer's job is to verify whether a worker actually accomplished the
 * task per its acceptance criteria. Bias: REJECT plausible-but-unverified
 * claims. The persona's preHook short-circuits the LLM call when:
 *   1. Filesystem alone proves pass/fail (verifyAcceptanceArtifacts)
 *   2. Suspicion patterns combined with absent write-tool trace
 *
 * If the LLM call itself errors out (timeout, schema fail), the reviewer
 * emits verdict=soft_fail so it never blocks the cluster.
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §7.
 */

import { z } from 'zod';

import { verifyAcceptanceArtifacts } from '../validators/filesystem.js';
import {
  SUSPICION_AUTO_FAIL_THRESHOLD,
  calculateSuspicion,
} from '../validators/suspicion.js';
import { hasWriteTool, requiresWrite } from '../validators/tool_trace.js';
import type { AgentPersona, FailureMode, PostHookResult } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

const VerdictSchema = z.enum(['pass', 'fail', 'refine', 'soft_fail']);
const EvidenceStatusSchema = z.enum(['met', 'unmet', 'ambiguous']);

const ReviewerToolCallTraceSchema = z.object({
  name: z.string(),
  args_summary: z.string().max(400).optional(),
});

const EvidenceSchema = z.object({
  criterion: z.string(),
  status: EvidenceStatusSchema,
  proof: z.string(),
});

const FilesystemSummarySchema = z.object({
  files_verified: z.array(z.string()),
  files_missing: z.array(z.string()),
  files_too_short: z.array(z.string()),
});

/**
 * Wave 2.C: state_schema drift surfaced from the post-completion validator
 * so the reviewer LLM sees shape feedback alongside acceptance criteria.
 */
const ReviewerStateSchemaViolationSchema = z.object({
  field: z.string(),
  expected: z.string(),
  actual: z.string(),
  reason: z.enum(['missing', 'wrong_type', 'parse_error']),
});

export const ReviewerInputSchema = z.object({
  task_id: z.string(),
  workflow_id: z.string(),
  task_kind: z.string(),
  acceptance_criteria: z.string().nullable(),
  worker_output: z.unknown(),
  workspace_dir: z.string().min(1),
  files_claimed_written: z.array(z.string()).optional(),
  tool_calls_trace: z.array(ReviewerToolCallTraceSchema).optional(),
  /** Daemon filesystem evidence computed before the LLM reviewer runs. */
  filesystem_evidence: z.array(EvidenceSchema).optional(),
  /** Daemon filesystem summary computed before the LLM reviewer runs. */
  filesystem_check_summary: FilesystemSummarySchema.optional(),
  /** When set with {@link shared_state}, postHook validates the key was written. */
  output_key: z.string().optional(),
  /** Snapshot of workflow shared state (snake_case contract; optional for legacy runs). */
  shared_state: z.record(z.string(), z.unknown()).optional(),
  /** Wave 2.C — state_schema runtime-validation drift for this task. */
  state_schema_violations: z.array(ReviewerStateSchemaViolationSchema).optional(),
  /** Wave 1.1 (F1-2): existing-code workflow mode signal. */
  workflow_mode: z.enum(['standard', 'existing_code_feature']).optional(),
  /**
   * Wave 1.1 (F1-2): architecture integration contract recorded by the
   * architecture-scout task. Shape mirrors
   * src/workflow-modes/existing-code-feature.ts ArchitectureContract.
   */
  architecture_contract: z.object({
    runId: z.string(),
    projectRoot: z.string(),
    appType: z.enum(['react', 'node', 'unknown']),
    existingStateStores: z.array(z.string()),
    existingUiSurfaces: z.array(z.string()),
    allowedFiles: z.array(z.string()),
    forbiddenPatterns: z.array(z.string()),
    requiredIntegrationPoints: z.array(z.string()),
    testSelectors: z.array(z.string()),
  }).nullable().optional(),
});
export type ReviewerInput = z.infer<typeof ReviewerInputSchema>;

export const ReviewerOutputSchema = z.object({
  verdict: VerdictSchema,
  feedback: z.string().min(1).max(8_000),
  evidence: z.array(EvidenceSchema),
  filesystem_check_summary: FilesystemSummarySchema,
  llm_called: z.boolean(),
  /** Optional rich diagnostics — surfaces in the dashboard's Errors panel. */
  suspicion_score: z.number().min(0).optional(),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimate the number of distinct acceptance criteria in a free-form string.
 * Heuristic: count bullet points, numbered lines, or semicolons. Used by the
 * postHook to ensure the reviewer produced one evidence entry per criterion.
 */
export function countCriteria(acceptance: string | null | undefined): number {
  if (!acceptance) return 0;
  const text = acceptance.trim();
  if (text.length === 0) return 0;

  // Multi-line bullets/numbered: count line starts matching `- `, `* `, `• `, `1.`, `2)`, etc.
  const lineBulletCount = (text.match(/^[\s]*[-*•]\s+|^\s*\d+[.)]\s+/gm) ?? []).length;
  if (lineBulletCount > 1) return lineBulletCount;

  // Inline numbered list: count "1." "2." "3." anywhere when separated by `;` or `,`.
  // Catches "1. exit 0; 2. file exists; 3. tests pass" on a single line.
  const inlineNumbered = (text.match(/(?:^|[\s;,])(\d+)[.)]\s+/g) ?? []).length;
  if (inlineNumbered > 1) return inlineNumbered;

  // Semicolon-separated criteria (must have > 1 segment to count).
  const semiCount = text.split(/;\s+/).filter((s) => s.trim().length > 0).length;
  if (semiCount > 1) return semiCount;

  // Single bullet OR single semicolon item OR free prose all collapse to 1.
  return 1;
}

function asNarrative(workerOutput: unknown): string {
  if (workerOutput == null) return '';
  if (typeof workerOutput === 'string') return workerOutput;
  if (typeof workerOutput === 'object') {
    const obj = workerOutput as Record<string, unknown>;
    const fields = ['result_text', 'output', 'narrative', 'summary'];
    for (const f of fields) {
      const v = obj[f];
      if (typeof v === 'string') return v;
    }
    return JSON.stringify(workerOutput);
  }
  return String(workerOutput);
}

function sharedStateHasOutputPopulated(
  sharedState: Record<string, unknown> | undefined,
  outputKey: string | undefined,
): boolean {
  if (!outputKey?.trim()) return true;
  if (!sharedState) return false;
  if (!Object.prototype.hasOwnProperty.call(sharedState, outputKey)) return false;
  const v = sharedState[outputKey];
  return v !== undefined && v !== null;
}

function hasCleanPrecomputedFilesystem(input: ReviewerInput): boolean {
  const summary = input.filesystem_check_summary;
  return Boolean(
    summary &&
      summary.files_verified.length > 0 &&
      summary.files_missing.length === 0 &&
      summary.files_too_short.length === 0,
  );
}

function looksLikeTraceOnlyReviewerFailure(output: ReviewerOutput): boolean {
  const text = [
    output.feedback,
    ...output.evidence.map((e) => `${e.criterion}\n${e.status}\n${e.proof}`),
  ].join('\n').toLowerCase();
  const mentionsTraceOnlyReason =
    /tool[- ]?call trace|write\/edit|write or edit|no write|without filesystem corroboration|unable to read|could not read/.test(text);
  if (!mentionsTraceOnlyReason) return false;

  return !output.evidence.some((e) => {
    if (e.status !== 'unmet') return false;
    const proof = `${e.criterion}\n${e.proof}`.toLowerCase();
    return !/tool[- ]?call trace|write\/edit|write or edit|no write|filesystem|unable to read|could not read/.test(proof);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<ReviewerOutput>[] = [
  {
    id: 'reviewer.timeout',
    detect: () => false, // resolved by runner; reviewer turns its own timeout into soft_fail
    remediation: 'soft_fail',
    description: 'Reviewer LLM call timed out — emit soft_fail rather than blocking the cluster.',
  },
  {
    id: 'reviewer.over_strict',
    detect: () => false,
    remediation: 'soft_fail',
    description: 'Reject rate too high across recent runs — needs operator tuning of suspicion thresholds.',
  },
  {
    id: 'reviewer.over_lenient',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    description: 'Reviewer accepted a worker that was later proven wrong — tighten suspicion patterns.',
  },
  {
    id: 'reviewer.evidence_missing',
    detect: () => false, // resolved in postHook
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'Your previous review produced fewer evidence entries than acceptance criteria. Emit one evidence per criterion, with status met/unmet/ambiguous and a concrete proof.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are the Omniforge Reviewer. Your bias: REJECT plausible-but-unverified output.

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Process (in order)
1. FIRST: filesystem check. Read claimed files. Count lines. Grep imports/exports. Run any test commands in acceptance.
2. SECOND: tool-trace check only when the task kind can write files AND acceptance explicitly requires writes. For llm_call text deliverables, judge the worker_output itself.
3. THIRD: only if 1 and 2 are inconclusive, call your judgement.

For each acceptance criterion, return one evidence entry: {criterion, status, proof}.

Objective-intent grounding: judge ONLY against what the user objective actually
asks for. Acceptance criteria are a guide, not a contract that can over-reach
the objective. If a criterion demands output that the user objective never
implied (extra deliverables, derivations, specific formatting/wording the
objective did not request), mark that criterion status=ambiguous and treat it
as satisfied — do NOT mark it unmet. Reserve status=unmet for criteria that
reflect what the objective genuinely required and that the output failed.
Genuinely wrong output (contradicts the objective, wrong answer) still fails.

If you encounter your own technical error (timeout, schema fail), emit verdict=soft_fail. Don't block the cluster.

# Output contract — JSON only

{
  "verdict": "pass|fail|refine|soft_fail",
  "feedback": "<actionable next step>",
  "evidence": [{ "criterion": "...", "status": "met|unmet|ambiguous", "proof": "..." }],
  "filesystem_check_summary": { "files_verified": [], "files_missing": [], "files_too_short": [] },
  "llm_called": true
}

# Hard rules
\${HARD_RULES_NUMBERED}

# Forbidden
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Task kind
\${INPUT.task_kind}

# Acceptance criteria
\${INPUT.acceptance_criteria}

# Worker output
\${INPUT.worker_output|json}

# Workspace
\${INPUT.workspace_dir}

# Precomputed filesystem check
These checks were run by the daemon before this LLM review. Treat them as filesystem corroboration.
If files_verified contains the required files and files_missing/files_too_short are empty, do not fail solely because the CLI trace has no Write/Edit entry. Judge remaining semantic requirements from this evidence, worker verification output, and safe context.
Summary:
\${INPUT.filesystem_check_summary|json}
Evidence:
\${INPUT.filesystem_evidence|json}

# Tool-call trace
\${INPUT.tool_calls_trace|json}

# State schema drift (Wave 2.C — observability feedback)
The decomposer declared a state_schema for this task. The runtime validator
checked the worker's output against it. If non-empty, treat each entry as an
extra criterion: the worker drifted from the contract for that field. Prefer
verdict=refine when shape drift is present AND the acceptance is ambiguous
about it; cite the field in your feedback so the next attempt can fix it.
\${INPUT.state_schema_violations|json}

# Workflow mode (Wave 1.1)
\${INPUT.workflow_mode}

# Architecture integration contract (only set when workflow_mode === 'existing_code_feature')
The objective targets an existing product. The contract below was recorded by
the architecture-scout task before any implementation. Treat it as
authoritative ground truth about the codebase the worker MUST integrate with.
\${INPUT.architecture_contract|json}

When architecture_contract is non-null, apply this judgment overlay on top of
the standard process. These are JUDGMENT checks — deterministic regex checks
for sidecar DOM islands and duplicate stores are run separately by the
quality harness, so do NOT re-implement those. Focus on cross-cutting
intent:

  A. Objective vs integration intent. Read the acceptance criteria and the
     objective embedded in worker_output. If the objective implies the
     feature should appear in or modify an existing UI surface listed in
     architecture_contract.requiredIntegrationPoints (e.g. App.tsx,
     screens/*), and the worker output shows zero edits to any of those
     paths, set verdict=refine and cite which integration point was
     skipped. Exception: pure scout/analysis/contract tasks.

  B. State-store discipline. If architecture_contract.existingStateStores is
     non-empty AND the worker_output narrative or files_claimed_written
     introduces a new store-shaped file (paths matching /store|state/ or
     content describing a Zustand/Redux/Pinia/createStore), require the
     worker to justify why an existing store could not be extended. If no
     justification is present, set verdict=refine.

  C. Allowed-file judgment. files_claimed_written entries that fall outside
     architecture_contract.allowedFiles are a strong signal of a sidecar
     implementation. If you see paths like .task-modules-root, omniforge-*,
     sidecar*, or any new top-level directory not covered by allowedFiles,
     set verdict=refine and ask the worker to relocate the change.

  D. Visible-feature/objective alignment. When the objective claims a
     user-visible feature (a button, a heading, a label, a screen), look
     for that string literal — or a reasonable paraphrase — in the worker's
     reported file edits or in the precomputed filesystem evidence. If
     absent, treat as ambiguous and lower confidence; do NOT auto-fail
     unless acceptance explicitly required visible-string presence.

When workflow_mode is 'standard' or architecture_contract is null, ignore
this section entirely. It must not influence judgment for standard runs.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

export const REVIEWER_PERSONA: AgentPersona<ReviewerInput, ReviewerOutput> = {
  id: 'reviewer',
  version: '1.0.0',
  name: 'Reviewer',
  identity:
    'I am the skeptical critic. I receive a task\'s output + acceptance criteria + filesystem snapshot and decide pass/fail/refine. I prefer rejecting plausible-but-unverified output over accepting it. I verify physical artifacts (files, build status, line counts) before trusting narrative claims.',
  mission:
    'Determine whether the worker actually accomplished the task per acceptance criteria, and provide actionable feedback when not.',
  inputSchema: ReviewerInputSchema,
  outputSchema: ReviewerOutputSchema,
  hardRules: [
    'Filesystem check first. When acceptance mentions files, verify them BEFORE calling the LLM.',
    'Evidence per criterion. Each acceptance point gets one evidence entry with status + proof.',
    'Feedback is actionable. Don\'t say "task failed" — say "criterion X failed because Y; suggest Z".',
    'Soft-fail on technical errors. If your own LLM call times out or schema-fails, emit verdict=soft_fail and let the task pass with a warning. Don\'t block the cluster.',
    'Check tool trace when acceptance demands files. If requires_write && tool_calls_trace lacks Write/Edit AND precomputed filesystem evidence did not verify the required files → fail. Do not fail solely because the CLI trace has no Write/Edit entry when files_verified corroborates the artifact.',
    'For llm_call text deliverables, do not require filesystem artifacts or Write/Edit evidence unless the acceptance explicitly says to write a file; verify the inline output structure instead.',
    'Existing-code mode: when architecture_contract is present, treat its requiredIntegrationPoints, existingStateStores, and allowedFiles as ground truth. A task that ships UI/state changes touching none of the listed integration points and creating new top-level files is suspect — verdict=refine with a citation of the missed integration point.',
    'Existing-code mode: do not re-flag deterministic findings. Sidecar DOM mounts, duplicate Zustand stores, and control-copy/keyboard mismatches are caught by the quality harness in src/quality/. Your job is judgment about objective-vs-integration alignment, not regex reproduction.',
    'Judge ONLY against the user objective intent. If an acceptance criterion demands output that is NOT implied by the user objective (extra deliverables, derivations, formatting, or wording the objective never asked for), treat that criterion as status=ambiguous/satisfied — NOT unmet. Do not fail an output for missing something the objective never requested. This does not extend to genuinely wrong output: if the worker contradicts or fails the actual objective, fail it.',
  ],
  forbidden: [
    "Don't trust the worker's narrative without filesystem corroboration.",
    "Don't reject for stylistic reasons (formatting, comments) unless explicitly in acceptance.",
    "Don't block the cluster on reviewer technical errors — soft_fail instead.",
    "Don't ask for information you can verify yourself (filesystem, build commands).",
  ],
  ambiguityProtocol: [
    {
      condition: 'Acceptance is vague',
      resolution: 'Pass with feedback "Acceptance was vague; consider tightening". Set status=ambiguous.',
      escalate: false,
    },
    {
      condition: 'File exists but content is borderline',
      resolution: 'Run the build/test in acceptance; if 0 → pass; else → fail with output.',
      escalate: false,
    },
    {
      condition: 'Worker emitted <BLOCKED>',
      resolution: 'Pass through to failover with verdict=fail, feedback="worker blocked: <reason>".',
      escalate: false,
    },
    {
      condition: 'Filesystem and worker narrative disagree',
      resolution: 'Filesystem wins. Note in feedback.',
      escalate: false,
    },
    {
      condition: 'Multiple criteria, some met some not',
      resolution: 'verdict=refine with per-criterion evidence.',
      escalate: false,
    },
    {
      condition: 'Existing-code mode: objective mentions a visible string (button label, heading, screen title) but the worker output does not include that string in any reported file edit',
      resolution: 'Set status=ambiguous for that criterion with proof noting the missing string. Do not fail the whole task unless acceptance explicitly required visible-string presence; downstream final-product harness will catch it deterministically when implemented.',
      escalate: false,
    },
  ],
  tools: ['Read', 'Bash', 'Grep', 'Glob'],
  permissions: {
    defaultAction: 'deny',
    tools: { Read: 'allow', Grep: 'allow', Bash: 'allow', Glob: 'allow' },
  },
  defaultModel: 'cc/claude-sonnet-4-6',
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, ctx) => {
    const fsCheck = verifyAcceptanceArtifacts(
      input.acceptance_criteria,
      input.workspace_dir,
      input.files_claimed_written ?? [],
    );

    // 1. Filesystem alone is conclusive — short-circuit, no LLM call needed.
    if (fsCheck.canDecide) {
      ctx.emit('reviewer_short_circuit', {
        task_id: input.task_id,
        verdict: fsCheck.verdict,
        reason: 'filesystem_conclusive',
      });
      return {
        skipWithResult: {
          verdict: fsCheck.verdict,
          feedback: fsCheck.feedback,
          evidence: fsCheck.evidence,
          filesystem_check_summary: fsCheck.summary,
          llm_called: false,
        },
      };
    }

    // 2. Suspicion-pattern short-circuit (described-without-writing class).
    const narrative = asNarrative(input.worker_output);
    const suspicion = calculateSuspicion(narrative);
    if (
      suspicion.total >= SUSPICION_AUTO_FAIL_THRESHOLD &&
      requiresWrite(input.acceptance_criteria) &&
      !hasWriteTool(input.tool_calls_trace ?? [])
    ) {
      const matchedReasons = suspicion.matches.map((m) => m.reason).join('; ');
      ctx.emit('reviewer_short_circuit', {
        task_id: input.task_id,
        verdict: 'fail',
        reason: 'suspicion_without_write',
        suspicion_score: suspicion.total,
      });
      return {
        skipWithResult: {
          verdict: 'fail',
          feedback: `Suspicion patterns detected (score=${suspicion.total.toFixed(2)}) AND no Write/Edit tool call. Worker likely described instead of writing. Patterns: ${matchedReasons}`,
          evidence: [],
          filesystem_check_summary: fsCheck.summary,
          llm_called: false,
          suspicion_score: suspicion.total,
        },
      };
    }

    return {
      ...input,
      filesystem_evidence: fsCheck.evidence,
      filesystem_check_summary: fsCheck.summary,
    };
  },

  postHook: async (input, output, ctx): Promise<PostHookResult<ReviewerOutput>> => {
    // Soft-fail passes straight through (technical-error escape hatch).
    if (output.verdict === 'soft_fail') return output;

    if (
      output.verdict === 'fail' &&
      hasCleanPrecomputedFilesystem(input) &&
      looksLikeTraceOnlyReviewerFailure(output)
    ) {
      ctx.emit('reviewer_trace_only_failure_softened', {
        task_id: input.task_id,
        workflow_id: input.workflow_id,
        files_verified: input.filesystem_check_summary?.files_verified ?? [],
      });
      return {
        ...output,
        verdict: 'soft_fail',
        feedback: `Reviewer technical soft-fail: precomputed filesystem evidence verified ${input.filesystem_check_summary?.files_verified.join(', ')}, but the LLM reviewer rejected only because the CLI trace had no Write/Edit entry. Original feedback: ${output.feedback}`,
      };
    }

    // Validate evidence count against criteria count first (avoid counting synthetic output_key rows).
    const expected = countCriteria(input.acceptance_criteria);
    if (expected > 0 && output.evidence.length < expected) {
      return {
        rejectWithReason: `reviewer.evidence_missing: produced ${output.evidence.length} evidence entries but acceptance has ~${expected} criteria. Re-emit with one evidence per criterion.`,
        mode: 'reviewer.evidence_missing',
      };
    }

    if (input.output_key && input.shared_state && !sharedStateHasOutputPopulated(input.shared_state, input.output_key)) {
      ctx.emit('reviewer_output_key_miss', {
        task_id: input.task_id,
        workflow_id: input.workflow_id,
        output_key: input.output_key,
      });
      return {
        ...output,
        evidence: [
          ...output.evidence,
          {
            criterion: 'output_key not produced',
            status: 'unmet',
            proof: `Expected shared_state['${input.output_key}'] to be populated; key is absent or null.`,
          },
        ],
      };
    }

    return output;
  },
};
