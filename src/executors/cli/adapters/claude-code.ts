// =============================================================================
// adapters/claude-code.ts — `cli:claude-code` spec builder.
//
// Scope: build the `args` array for `claude --print [--output-format
// stream-json --verbose] [--model <id>] [--dangerously-skip-permissions]`.
//
// Stream-json is ON by default so tool calls (Agent dispatches, Read/Write/
// Bash, etc.) are observable; flip off by setting `CLI_OUTPUT_FORMAT=text`
// when raw text is preferred (debugging, legacy patterns, smaller logs).
//
// Permission flag is the canonical `--dangerously-skip-permissions`. Daemon
// child / MCP / explicit safe-mode contexts opt out automatically — see
// permission-context.ts for the gate logic.
// =============================================================================

import type { CliSpec } from '../types.js';
import { claudeBin } from '../bin-resolver.js';

export interface ClaudeCodeSpecInputs {
  /** Already-resolved CLI-side model id (provider prefix stripped) or null. */
  cliModel: string | null;
  /** Whether to emit `--output-format stream-json --verbose`. */
  useStreamJson: boolean;
  /** True when --dangerously-skip-permissions should be omitted. */
  safeMode: boolean;
}

export function buildClaudeCodeSpec(inputs: ClaudeCodeSpecInputs): CliSpec {
  const { cliModel, useStreamJson, safeMode } = inputs;
  const args: string[] = ['--print'];
  if (useStreamJson) args.push('--output-format', 'stream-json', '--verbose');
  if (cliModel) args.push('--model', cliModel);
  if (!safeMode) args.push('--dangerously-skip-permissions');
  return {
    bin: claudeBin(),
    args,
    streamJson: useStreamJson,
    promptDelivery: 'stdin',
  };
}
