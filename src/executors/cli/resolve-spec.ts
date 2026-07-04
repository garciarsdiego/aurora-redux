// =============================================================================
// resolve-spec.ts — dispatch from (hint, task) to the per-CLI adapter.
//
// Scope: the central `resolveCliSpec` entrypoint. Reads hint + task model,
// applies the `isModelCompatibleWithCli` guard (AETHER α-init fix), routes
// to the matching `adapters/<cli>` module. Default case falls back to
// claude-code so historical callers without an `executor_hint` keep working.
//
// IMPORTANT — preserve the "dropping incompatible model" stderr surfacing.
// It's the only signal an operator gets when the decomposer assigns a model
// that doesn't match the requested CLI (e.g. cc/claude-* + cli:codex).
// Without it the model arg gets silently dropped and the operator sees a
// "CLI used its native default" mystery on the dashboard.
// =============================================================================

import type { Task } from '../../types/index.js';
import type { CliSpec } from './types.js';
import {
  inferCliIdFromTask,
  isModelCompatibleWithCli,
  modelNameForCli,
} from './cli-inference.js';
import { isCliSafeMode, isImplicitDaemonSafeMode } from './permission-context.js';
import { buildClaudeCodeSpec } from './adapters/claude-code.js';
import { buildCodexSpec } from './adapters/codex.js';
import { buildGeminiSpec } from './adapters/gemini.js';
import { buildKimiSpec } from './adapters/kimi.js';
import { buildCursorSpec } from './adapters/cursor.js';
import { buildKiloSpec } from './adapters/kilo.js';
import { buildOpencodeSpec } from './adapters/opencode.js';

export function resolveCliSpec(
  hint: string | null | undefined,
  task?: Pick<Task, 'model'>,
  cwd?: string | null,
): CliSpec {
  const id = inferCliIdFromTask(hint, task);
  const safeMode = isCliSafeMode();
  // EXEC-02 (Opt B) — make the IMPLICIT daemon safe-mode gate VISIBLE per task.
  // When the daemon defaults CLIs to safe-mode (no --dangerously-skip-permissions),
  // interactive CLIs (claude/kimi) can hang and codex/cursor write nothing. Surface
  // it loudly so the operator knows why a cli_spawn task stalled and how to opt in.
  if (safeMode && isImplicitDaemonSafeMode()) {
    process.stderr.write(
      `[cli-spawn] cli:${id} running in IMPLICIT daemon SAFE MODE — permission ` +
      `prompts are NOT auto-approved, so interactive CLIs may hang or produce no ` +
      `file edits. Set CLI_SAFE_MODE=false to grant autonomous mode.\n`,
    );
  }
  // Drop incompatible model rather than feeding e.g. cc/claude-sonnet-4-6
  // into `codex exec --model …`. See isModelCompatibleWithCli rationale.
  // The mismatch is surfaced via stderr so the daemon log captures it.
  const compatible = isModelCompatibleWithCli(id, task?.model);
  if (!compatible && task?.model) {
    process.stderr.write(
      `[cli-spawn] dropping incompatible model "${task.model}" for cli:${id} ` +
      `— CLI will use its native default. Hint: align decomposer model ` +
      `assignment with executor_hint, or set model=null for cli_spawn tasks.\n`,
    );
  }
  const cliModel = compatible ? modelNameForCli(task?.model) : null;
  // Default stream-json ON for claude-code so tool calls (Agent dispatches,
  // Read/Write/Bash, etc.) are observable. CLI_OUTPUT_FORMAT=text disables it
  // when raw text is preferred (debugging, legacy patterns, smaller logs).
  const useStreamJson = process.env.CLI_OUTPUT_FORMAT !== 'text';

  switch (id) {
    case 'claude-code':
      return buildClaudeCodeSpec({ cliModel, useStreamJson, safeMode });
    case 'gemini':
      return buildGeminiSpec({ cliModel, safeMode });
    case 'codex':
      return buildCodexSpec({ cliModel, safeMode });
    case 'kimi':
      return buildKimiSpec({ safeMode, runDir: cwd ?? null });
    case 'cursor':
      return buildCursorSpec({ safeMode });
    case 'kilo':
      return buildKiloSpec({ safeMode });
    case 'opencode':
      return buildOpencodeSpec({ compatible, task });
    default:
      return buildClaudeCodeSpec({ cliModel, useStreamJson, safeMode });
  }
}
