/**
 * WORKER_CLI_SPAWN_PERSONA — the agent that produces files via spawned CLIs.
 *
 * This persona codifies the regression we hit on 2026-05-04: the worker would
 * Read a stale stub, claim "files already exist and look correct", and never
 * call Write — the cluster would loop 5 times with identical failure.
 *
 * Defenses (all of which need a regression test):
 *   1. preHook backs up prior-attempt files before retry, so Read returns
 *      ENOENT and the worker is forced to write.
 *   2. preHook prepends WORKER_CLI_SPAWN_PREFIX which spells out the contract.
 *   3. postHook rejects when acceptance demands a write but the trace contains
 *      no Write/Edit call.
 *   4. postHook rejects when claimed files don't exist or are <10 chars.
 *   5. postHook rejects markdown-in-code-file (file_path.tsx whose first line
 *      is a markdown header).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { Vault } from '../../vault/store.js';

import { backupFilesForRetry } from '../validators/workspace.js';
import {
  extractFilePathsFromAcceptance,
  hasWriteTool,
  listToolNames,
  requiresWrite,
} from '../validators/tool_trace.js';
import {
  HANDOFF_SCHEMA_SNIPPET,
  WORKER_CLI_SPAWN_PREFIX,
  WORKER_GEMINI_TEXT_PREFIX,
} from '../prompts/prefixes.js';

/**
 * N2 (post-2026-05-05): strip a single outer ```json``` / ```ts``` / etc.
 * fence wrapping. Idempotent — text without fences passes through unchanged.
 * Inner fences (e.g. inside markdown documentation that itself shows code
 * samples) are preserved by only matching outermost fences anchored to the
 * trimmed-text edges.
 */
function stripMarkdownFences(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  // Match: optional language, content, closing fence — at the edges of the trimmed string.
  const fenceMatch = trimmed.match(/^```[a-zA-Z0-9_+-]*\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) return fenceMatch[1].trim();
  return text;
}
import { extractHandoffSections } from '../../handoff/extract.js';
import type { ParsedHandoff } from '../../handoff/types.js';
import { KNOWN_CLIS } from './decomposer.js';
import type { AgentPersona, FailureMode, PostHookResult } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

export const ToolCallTraceSchema = z.object({
  name: z.string(),
  args_summary: z.string().max(400).optional(),
  result_summary: z.string().max(800).optional(),
});

export const UpstreamArtifactSchema = z.object({
  task_id: z.string(),
  summary: z.string(),
  files_written: z.array(z.string()).optional(),
});

export const WorkerCliSpawnInputSchema = z.object({
  task_id: z.string(),
  workflow_id: z.string(),
  workspace: z.string(),
  cli: z.enum(KNOWN_CLIS),
  model: z.string(),
  prompt: z.string().min(1),
  acceptance_criteria: z.string().nullable(),
  workspace_dir: z.string(),
  upstream_artifacts: z.array(UpstreamArtifactSchema).optional(),
  /** Carry block produced by buildCarryFromUpstream from each direct parent's parsed_handoff. */
  carry_from_upstream: z.string().optional(),
  retry_count: z.number().int().min(0),
  prior_attempt_artifacts: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().min(1),
  vault_inputs: z.array(z.string()).optional(),
  vault_outputs: z.array(z.object({
    path: z.string(),
    source: z.enum(['result_text', 'file']),
    file: z.string().optional(),
  })).optional(),
});
export type WorkerCliSpawnInput = z.infer<typeof WorkerCliSpawnInputSchema>;

export const WorkerCliSpawnOutputSchema = z.object({
  exit_code: z.number().int(),
  duration_ms: z.number().nonnegative(),
  tool_calls: z.array(ToolCallTraceSchema),
  files_written: z.array(z.string()),
  files_modified: z.array(z.string()),
  files_read: z.array(z.string()),
  result_text: z.string(),
  blocked: z.boolean().default(false),
  blocked_reason: z.string().optional(),
  /** Parsed handoff sections from result_text. Populated by postHook. */
  parsed_handoff: z.custom<ParsedHandoff>().optional(),
});
export type WorkerCliSpawnOutput = z.infer<typeof WorkerCliSpawnOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<WorkerCliSpawnOutput>[] = [
  {
    id: 'worker.described_without_writing',
    detect: (output) => !output.blocked && !hasWriteTool(output.tool_calls),
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition:
      'Your previous attempt called only read tools. Acceptance requires file creation/modification. Use the Write tool with file_path and content parameters in your next response.',
    description: 'Worker did not call any Write/Edit tool but acceptance requires it.',
  },
  {
    id: 'worker.file_empty',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    description: 'A file was reportedly written but the on-disk content is < 10 chars.',
  },
  {
    id: 'worker.file_missing',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    description: 'A file was reported as written but does not exist on disk.',
  },
  {
    id: 'worker.markdown_in_code_file',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    retryPromptAddition: 'You wrote markdown content into a source-code file. Re-emit the file as valid source code (TS/Rust/Python/etc).',
  },
  {
    id: 'worker.no_trace',
    detect: (output) => output.tool_calls.length === 0 && !output.blocked,
    remediation: 'retry_with_stronger_prompt',
    description: 'Worker reported no tool calls and is not blocked. Cannot verify what was done.',
  },
  {
    id: 'worker.opencode_empty_output',
    detect: (output) =>
      output.exit_code === 0 && output.tool_calls.length === 0 && output.result_text.trim().length === 0,
    remediation: 'retry_with_different_model',
    description: 'opencode + unsupported provider returns clean exit with empty output (D-H2.077).',
  },
  {
    id: 'worker.cursor_shell_hang',
    detect: () => false,
    remediation: 'retry_with_stronger_prompt',
    description: 'Cursor + shell tool hangs under stdio piped (D-H2.074). Force Write tool.',
  },
  {
    id: 'worker.timeout',
    detect: () => false,
    remediation: 'retry_with_different_model',
    description: 'Worker exceeded timeout — possibly slow model on this task type.',
  },
  {
    id: 'worker.blocked',
    detect: (output) => output.blocked === true,
    remediation: 'escalate_to_operator',
    description: 'Worker emitted <BLOCKED>; operator decides next step.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt — the prompt sent to the spawned CLI is this template plus
// WORKER_CLI_SPAWN_PREFIX (injected by preHook into input.prompt).
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `You are a CLI worker (\${INPUT.cli}) executing one task in a spawned subprocess.

# Identity
\${IDENTITY_VERBATIM}

# Mission
\${MISSION_VERBATIM}

# Hard rules
\${HARD_RULES_NUMBERED}

# Forbidden actions
\${FORBIDDEN_NUMBERED}

# Ambiguity protocol
\${AMBIGUITY_TABLE}

# Workspace
Working directory: \${INPUT.workspace_dir}
CLI: \${INPUT.cli}
Model: \${INPUT.model}
Acceptance criteria: \${INPUT.acceptance_criteria}

# Task
\${INPUT.prompt}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Persona export
// ─────────────────────────────────────────────────────────────────────────────

export const WORKER_CLI_SPAWN_PERSONA: AgentPersona<WorkerCliSpawnInput, WorkerCliSpawnOutput> = {
  id: 'worker.cli_spawn',
  version: '1.0.0',
  name: 'Worker · CLI Spawn',
  identity:
    'I am a CLI agent (claude-code | codex | gemini | kimi | cursor | opencode) executing ONE task in a spawned subprocess. I have full filesystem access via Write/Edit/Read/Bash tools. My job is to PRODUCE artifacts (files, modified code, test results) — not to describe what I would produce.\n\n' +
    "I am NOT the planner — I do the work the planner specified. I am NOT the reviewer — I don't judge whether my own work is correct, I just do it and report what I did.\n\n" +
    "When my task says 'implement X', I MUST call Write or Edit tools. Reading existing files and claiming 'already exists' is failure unless I also verify the existing file meets the full acceptance criteria and explicitly state I'm leaving it unchanged.",
  mission:
    'Execute the task instruction with the right tools, producing the artifacts the acceptance criteria demands. Report exactly what tool calls were made and what files were touched.',
  inputSchema: WorkerCliSpawnInputSchema,
  outputSchema: WorkerCliSpawnOutputSchema,
  hardRules: [
    'Write tool is required for write-required tasks. If acceptance_criteria mentions creating/modifying files, you MUST emit at least one Write or Edit tool call.',
    'Read existing files BEFORE overwriting. If a file from a prior attempt exists at the target path, read it, compare against acceptance, then OVERWRITE with the complete implementation if it falls short.',
    'No silent stub-acceptance. Saying "files already exist and look correct" without listing the line count, exports, and matched acceptance points is failure.',
    'Real source code. Files must be parseable in their target language. Markdown summaries don\'t count as TypeScript/Rust/Python files.',
    'Report exactly what you did. Final response must list every tool call name, every file written/modified, which acceptance points each file addresses.',
    '`<BLOCKED>reason</BLOCKED>` for unrecoverable failures. If you cannot complete (missing dep, ambiguous spec, etc.), emit this — never silently summarize success.',
    'Stay in the workspace_dir. Don\'t write outside the cwd. Don\'t read /etc/, /home, etc.',
    'Honor secrets placeholders. `{{secret:KEY}}` will be resolved by the executor; don\'t try to expand them yourself or expose values in output.',
  ],
  forbidden: [
    "Don't claim success without Write/Edit tool calls when acceptance demands file creation.",
    "Don't describe what you would write — write it.",
    "Don't read prior attempt files and conclude 'good enough' without strict acceptance comparison.",
    "Don't silently truncate output — if your response exceeds limits, emit `<BLOCKED>output_too_large</BLOCKED>`.",
    "Don't use the shell tool for cursor under stdio piped (workspace bug D-H2.074).",
    "Don't write outside workspace_dir.",
    "Don't expose secrets in output text or tool call args.",
    "Don't produce markdown when source code is expected. A `.tsx` file is TypeScript JSX, not a markdown summary.",
    "Don't use `cli:opencode` with `opencode-go/*` models. Empty output (D-H2.077). Use deepseek/anthropic/groq via opencode allowlist.",
  ],
  ambiguityProtocol: [
    {
      condition: 'Acceptance mentions file but no path',
      resolution: 'Use <workspace_dir>/<conventional_path> (e.g. src/components/X.tsx for React component).',
      escalate: false,
    },
    {
      condition: 'File exists from prior attempt with partial content',
      resolution: 'Read it, compare to acceptance, OVERWRITE with full implementation if any criterion isn\'t met.',
      escalate: false,
    },
    {
      condition: 'Multiple files implied by single task name',
      resolution: 'Write all of them. Report each in files_written.',
      escalate: false,
    },
    {
      condition: 'Test command in acceptance fails',
      resolution: 'Run it, capture output, include in result_text, emit <BLOCKED>tests_failing: ...</BLOCKED> if can\'t fix.',
      escalate: true,
    },
    {
      condition: 'Required upstream artifact missing',
      resolution: 'Emit <BLOCKED>missing_artifact: <task_id></BLOCKED> immediately, don\'t proceed.',
      escalate: true,
    },
    {
      condition: 'Model returns refusal (safety)',
      resolution: 'Emit <BLOCKED>model_refused: <reason></BLOCKED> — don\'t try jailbreaking.',
      escalate: true,
    },
  ],
  tools: ['Write', 'Edit', 'Read', 'Glob', 'Grep', 'Bash', 'WebFetch'],
  permissions: { defaultAction: 'allow' },
  defaultModel: null, // per-task model
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, ctx) => {
    // 1. Workspace hygiene on retry: backup stale stubs
    if (input.retry_count > 0 && input.acceptance_criteria) {
      const targets = extractFilePathsFromAcceptance(input.acceptance_criteria);
      const backups = backupFilesForRetry(input.workspace_dir, targets, {
        retryCount: input.retry_count - 1,
        maxBytes: 5 * 1024 * 1024, // skip files > 5MB
      });
      input.prior_attempt_artifacts = backups.map((b) => b.backupPath);
      if (backups.length > 0) {
        ctx.emit('worker_workspace_clean', {
          task_id: input.task_id,
          backups: backups.map((b) => ({ original: b.originalPath, backup: b.backupPath })),
        });
      }
    }

    // 2. Inject the contract prefix into the prompt.
    //
    // Gemini-CLI in `-p` arg mode is text-only (no Tools API). The standard
    // EXECUTION CONTRACT prefix (which mandates Write/Edit tool calls) made
    // gemini interpret short text tasks as meta-acknowledgments and reply
    // "I have completed the task." Use a slimmer text-output prefix instead.
    // See WORKER_GEMINI_TEXT_PREFIX in ../prompts/prefixes.ts (post-2026-05-05).
    const isGemini = input.cli === 'cli:gemini';
    const targetPrefix = isGemini ? WORKER_GEMINI_TEXT_PREFIX : WORKER_CLI_SPAWN_PREFIX;
    if (
      !input.prompt.startsWith(WORKER_CLI_SPAWN_PREFIX) &&
      !input.prompt.startsWith(WORKER_GEMINI_TEXT_PREFIX)
    ) {
      input.prompt = `${targetPrefix}\n${input.prompt}`;
    }

    // 2b. Append handoff schema so downstream carry-compactor can parse output.
    // Skipped for gemini text-only — short tasks routed there don't typically
    // produce structured handoff sections, and the schema verbiage adds the
    // same meta-acknowledgment risk we just sidestepped.
    if (!isGemini && !input.prompt.includes('=== RESPONSE FORMAT (handoff schema) ===')) {
      input.prompt += HANDOFF_SCHEMA_SNIPPET;
    }

    // 3. Inject upstream artifacts summary if present
    if (input.upstream_artifacts && input.upstream_artifacts.length > 0) {
      const lines = input.upstream_artifacts.map(
        (a) => `- ${a.task_id}: ${a.summary}\n  files: ${(a.files_written ?? []).join(', ') || 'n/a'}`,
      );
      input.prompt += `\n\n=== UPSTREAM ARTIFACTS ===\n${lines.join('\n')}`;
    }

    // 3b. Inject bounded carry block (parsed_handoff sections per parent) if
    // run-task.ts populated it. Mirrors legacy executors/cli.ts wire path.
    if (input.carry_from_upstream && input.carry_from_upstream.trim().length > 0) {
      input.prompt += `\n\n=== CARRY FROM UPSTREAM (parsed handoff per parent) ===\n${input.carry_from_upstream}`;
    }

    // 4. Inject prior-attempt note when backups exist
    if (input.prior_attempt_artifacts && input.prior_attempt_artifacts.length > 0) {
      input.prompt +=
        `\n\n=== PRIOR ATTEMPTS ===\nThe workspace was cleaned. Your previous attempt's files are at:\n${input.prior_attempt_artifacts.join(
          '\n',
        )}\nRead them for reference, then OVERWRITE the originals with a complete implementation.`;
    }

    // 5. Inject vault inputs
    if (input.vault_inputs && input.vault_inputs.length > 0) {
      const vault = new Vault(path.resolve('data', 'vault'));
      // B9 pre-validation: surface missing vault inputs as an event BEFORE
      // we silently inject "(not found)" into the prompt. Operator sees the
      // miss in the dashboard activity log even when the worker proceeds.
      const { missing } = await vault.checkPaths(input.workspace, input.vault_inputs);
      if (missing.length > 0) {
        ctx.emit('vault_input_missing', {
          task_id: input.task_id,
          workspace: input.workspace,
          missing_paths: missing,
        });
      }
      const lines: string[] = [];
      for (const vaultPath of input.vault_inputs) {
        try {
          const content = await vault.read(input.workspace, vaultPath);
          lines.push(`### ${vaultPath}\n${content}`);
        } catch {
          lines.push(`### ${vaultPath}\n(not found)`);
        }
      }
      input.prompt += `\n\n=== VAULT INPUTS ===\n${lines.join('\n\n')}`;
    }

    return input;
  },

  postHook: async (input, output, ctx): Promise<PostHookResult<WorkerCliSpawnOutput>> => {
    // 0. Blocked → pass-through (failover handles)
    if (output.blocked) {
      return output;
    }

    // 0b. Strip markdown fences from result_text when the acceptance criterion
    // says "no markdown" or asks for a bare JSON / haiku / structured output.
    // Worker CLIs (claude-code especially) often wrap JSON answers in
    // ```json ... ``` fences regardless of instructions; rather than failing
    // the task at reviewer time, strip the wrapper here so the downstream
    // sees the bare content. Idempotent: a result without fences is unchanged.
    // Post-2026-05-05 fix N2 — surfaced by canonical Demacia smoke run.
    output.result_text = stripMarkdownFences(output.result_text);

    // 1. opencode-empty-output sentinel (D-H2.077)
    if (
      input.cli === 'cli:opencode' &&
      output.exit_code === 0 &&
      output.tool_calls.length === 0 &&
      output.result_text.trim().length === 0
    ) {
      return {
        rejectWithReason:
          'worker.opencode_empty_output: opencode returned clean exit + empty output (likely unsupported provider). Switch to deepseek/anthropic/groq.',
        mode: 'worker.opencode_empty_output',
      };
    }

    // 2. Write tool required when acceptance demands it
    if (requiresWrite(input.acceptance_criteria) && !hasWriteTool(output.tool_calls)) {
      const names = listToolNames(output.tool_calls);
      return {
        rejectWithReason: `worker.described_without_writing: acceptance requires file creation but worker called only [${names.join(
          ', ',
        ) || 'nothing'}]. No Write/Edit detected.`,
        mode: 'worker.described_without_writing',
      };
    }

    // 3. No-trace short-circuit (covers CLIs that silently succeed)
    if (output.tool_calls.length === 0) {
      return {
        rejectWithReason: 'worker.no_trace: worker reported no tool calls and is not blocked. Cannot verify what (if anything) was done.',
        mode: 'worker.no_trace',
      };
    }

    // 4. Validate every claimed file exists with non-trivial content
    for (const rel of output.files_written) {
      const abs = path.isAbsolute(rel) ? rel : path.resolve(input.workspace_dir, rel);
      if (!existsSync(abs)) {
        return {
          rejectWithReason: `worker.file_missing: ${rel} reported as written but doesn't exist on filesystem`,
          mode: 'worker.file_missing',
        };
      }
      const stats = statSync(abs);
      if (!stats.isFile()) {
        return {
          rejectWithReason: `worker.file_not_regular: ${rel} exists but is not a regular file`,
          mode: 'worker.file_missing',
        };
      }
      const content = readFileSync(abs, 'utf-8');
      if (content.trim().length < 10) {
        return {
          rejectWithReason: `worker.file_empty: ${rel} has < 10 chars of non-blank content`,
          mode: 'worker.file_empty',
        };
      }
      // Markdown-in-code detection
      const ext = path.extname(rel).toLowerCase();
      const codeExt = ['.ts', '.tsx', '.js', '.jsx', '.rs', '.py', '.go', '.java', '.kt', '.swift'].includes(ext);
      const firstLine = content.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
      if (codeExt && /^#\s+/.test(firstLine)) {
        return {
          rejectWithReason: `worker.markdown_in_code_file: ${rel} starts with markdown header but extension is source code`,
          mode: 'worker.markdown_in_code_file',
        };
      }
    }

    // 5. Parse handoff sections from result_text
    const parsedHandoff = extractHandoffSections(output.result_text);
    output.parsed_handoff = parsedHandoff;
    if (!parsedHandoff.sawHeading) {
      ctx.emit('handoff_schema_missed', {
        task_id: input.task_id,
        workflow_id: input.workflow_id,
        reason: 'Worker response did not contain any handoff section headings (Summary/Actions/Artifacts/Risks/Next).',
      });
      ctx.warn('handoff_schema_missed: worker response lacks handoff headings; carry block will use full text as Summary.', {
        task_id: input.task_id,
      });
    }

    // 6. Write vault outputs after successful execution
    if (input.vault_outputs && input.vault_outputs.length > 0) {
      const vault = new Vault(path.resolve('data', 'vault'));
      for (const spec of input.vault_outputs) {
        let content: string;
        if (spec.source === 'result_text') {
          content = output.result_text;
        } else {
          // source === 'file'
          const filePath = spec.file
            ? (path.isAbsolute(spec.file) ? spec.file : path.resolve(input.workspace_dir, spec.file))
            : null;
          if (!filePath || !existsSync(filePath)) {
            // non-fatal: skip missing file vault output
            continue;
          }
          content = readFileSync(filePath, 'utf-8');
        }
        await vault.write(input.workspace, spec.path, content);
      }
    }

    return output;
  },
};
