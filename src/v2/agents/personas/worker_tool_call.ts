/**
 * WORKER_TOOL_CALL_PERSONA — deterministic, allow-listed tool invocation.
 *
 * No LLM at this stage. The runner invokes a built-in tool (bash, file_read,
 * file_write, http_request, sql_query) with operator-supplied args. The
 * persona's job is to enforce safety (no `rm -rf /`, no sudo, no global
 * mutations) and contractually report the result.
 *
 * Failure modes:
 *   - worker_tool.timeout         — duration exceeded; do NOT retry blindly
 *   - worker_tool.bash_dangerous  — preHook rejected dangerous bash
 *   - worker_tool.exit_nonzero    — non-zero exit; failover decides
 *
 * Reference: docs/notes/2026-05-04-omniforge-agents-spec.md §5.
 */

import { z } from 'zod';

import type { AgentPersona, FailureMode } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// IO contracts
// ─────────────────────────────────────────────────────────────────────────────

export const ToolNameSchema = z.enum([
  'bash',
  'file_read',
  'file_write',
  'http_request',
  'sql_query',
]);
export type ToolKind = z.infer<typeof ToolNameSchema>;

export const WorkerToolCallInputSchema = z.object({
  task_id: z.string(),
  tool_name: ToolNameSchema,
  args: z.record(z.string(), z.unknown()),
  timeout_seconds: z.number().int().min(5).max(600).default(120),
  /** Workspace root — bash commands and file operations are bounded inside. */
  workspace_dir: z.string().min(1).optional(),
});
export type WorkerToolCallInput = z.infer<typeof WorkerToolCallInputSchema>;

export const WorkerToolCallOutputSchema = z.object({
  tool_name: z.string(),
  result: z.unknown(),
  exit_code: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  duration_ms: z.number().nonnegative(),
});
export type WorkerToolCallOutput = z.infer<typeof WorkerToolCallOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Safety patterns
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reject obvious filesystem-destruction commands. Whitelisted prefixes:
 *   /tmp, /var/tmp, /home/<user>/(tmp|workspace)
 * Anything outside those — including `rm -rf /` and `rm -rf ~/` — gets killed.
 */
const DANGEROUS_RM_RE = /\brm\s+(?:-[rRf]+\s+)+\/(?!tmp|var\/tmp|home\/[^/]+\/(?:tmp|workspace))/;
const SUDO_RE = /\bsudo\b/;
const GLOBAL_NPM_RE = /\bnpm\s+install\s+(?:-g|--global)\b/;
const CHMOD_777_RE = /\bchmod\s+(?:-R\s+)?777\b/;
const WIPE_DISK_RE = /\b(mkfs|dd\s+if=\/dev\/zero)\b/;

function classifyDangerousBash(command: string): string | null {
  if (DANGEROUS_RM_RE.test(command)) return 'rm -rf outside workspace allowlist';
  if (SUDO_RE.test(command)) return 'sudo not allowed';
  if (GLOBAL_NPM_RE.test(command)) return 'global npm install rejected (use local install)';
  if (CHMOD_777_RE.test(command)) return 'chmod 777 rejected (insecure permissions)';
  if (WIPE_DISK_RE.test(command)) return 'disk-wipe command rejected';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure modes
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_MODES: readonly FailureMode<WorkerToolCallOutput>[] = [
  {
    id: 'worker_tool.timeout',
    detect: () => false, // resolved at runtime by the executor
    remediation: 'soft_fail',
    description: 'Tool exceeded timeout — usually upstream issue; do not blindly retry.',
  },
  {
    id: 'worker_tool.bash_dangerous',
    detect: () => false, // resolved in preHook
    remediation: 'escalate_to_operator',
    description: 'Bash command matches a dangerous-pattern allowlist breach.',
  },
  {
    id: 'worker_tool.exit_nonzero',
    detect: (output) => typeof output.exit_code === 'number' && output.exit_code !== 0,
    remediation: 'retry_with_stronger_prompt',
    description: 'Tool exited non-zero — failover classifier decides next move.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Persona export — note: defaultModel is null because there is no LLM call
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEMPLATE = `# Tool-call worker (deterministic, no LLM)
# This persona has no system prompt because the runner does not call an LLM.
# It is included so renderSystemPrompt() never returns empty when this kind
# is invoked through the generic runAgent path during tests.
Tool: \${INPUT.tool_name}
Args: \${INPUT.args|json}`;

export const WORKER_TOOL_CALL_PERSONA: AgentPersona<WorkerToolCallInput, WorkerToolCallOutput> = {
  id: 'worker.tool_call',
  version: '1.0.0',
  name: 'Worker · Tool Call',
  identity:
    'I invoke a built-in tool (bash, file_read, file_write, http_request, sql_query) deterministically. No LLM is involved at this stage — I run the tool with the args provided and return its result.',
  mission: 'Execute the named tool with given args, return result + status.',
  inputSchema: WorkerToolCallInputSchema,
  outputSchema: WorkerToolCallOutputSchema,
  hardRules: [
    'Args must match the tool\'s schema. Pre-validate. No retry on schema fail — it\'s a programming error upstream.',
    'No long-running processes. Use cli_spawn for those.',
    'Bash limited to workspace_dir. No network mutations, no rm -rf /, no chmod 777.',
    'HTTP requests only to allowlisted domains.',
  ],
  forbidden: [
    'No interactive commands (no `read`, no `vim`, no prompts).',
    'No `sudo`.',
    'No global state mutations (no `npm install -g`).',
    'No disk-wipe commands (mkfs, dd if=/dev/zero, etc.).',
  ],
  ambiguityProtocol: [
    { condition: 'Tool name unknown', resolution: 'Return error immediately', escalate: false },
    { condition: 'Args missing required field', resolution: 'Return error immediately', escalate: false },
    { condition: 'Bash command exceeds timeout', resolution: 'Kill, return partial output', escalate: false },
  ],
  tools: ['Bash', 'Read', 'Write', 'http_request', 'sql_query'],
  permissions: { defaultAction: 'allow', tools: { Bash: 'ask' } },
  defaultModel: null,
  systemPromptTemplate: SYSTEM_PROMPT_TEMPLATE,
  failureModes: FAILURE_MODES,

  preHook: async (input, _ctx) => {
    if (input.tool_name === 'bash') {
      const cmd = String(input.args['command'] ?? '');
      const danger = classifyDangerousBash(cmd);
      if (danger) {
        return {
          skipWithResult: {
            tool_name: 'bash',
            result: null,
            exit_code: 1,
            stderr: `worker_tool.bash_dangerous: ${danger}`,
            duration_ms: 0,
          },
        };
      }
    }
    return input;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers used by tests + executor
// ─────────────────────────────────────────────────────────────────────────────

export function classifyDangerousBashCommand(command: string): string | null {
  return classifyDangerousBash(command);
}
