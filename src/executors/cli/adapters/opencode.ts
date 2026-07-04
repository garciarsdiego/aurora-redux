// =============================================================================
// adapters/opencode.ts — `cli:opencode` spec builder (spawn-mode legacy path).
//
// `opencode run --dangerously-skip-permissions [-m provider/model] <prompt>`
// OpenCode uses the SAME flag name as Claude Code for auto-approval.
//
// Example smoke test 2026-05-01 — "empty output" bug fix: pre-fix this
// case took `task.model` raw (bypassing isModelCompatibleWithCli),
// so `model=cc/claude-sonnet-4-6` (Omniroute prefix) was passed via
// `-m cc/claude-sonnet-4-6`. OpenCode does not have a `cc` provider
// (its provider list is opencode-zen, kimi-for-coding, minimax, zai,
// ollama-cloud, openrouter, groq, openai, github-copilot, google,
// nvidia, etc). Result: silent rejection, exit 0, empty stdout.
//
// Now we use the same `cliModel` resolved above which already passed
// `isModelCompatibleWithCli` for opencode (provider must be in the
// known set). Foreign prefixes are dropped; OpenCode picks default.
// Operators who want a specific OpenCode model pass it as e.g.
// `model: "opencode-zen/glm-4.6"` or `"kimi-for-coding/kimi-k2"`.
// Conservative text output today: `--format json` is available but its
// event shape is not the same as Claude Code's stream-json; enabling
// needs a dogfood sample + parser (same followup as Cursor).
// Example smoke test 2026-05-05 (post-audit fix, supersedes D-H2.077):
//
// OpenCode 0.x's `run` subcommand has NO `--dangerously-skip-permissions`
// flag (verified via `opencode run --help` in scripts/repro-cli-failures.mjs).
// Yargs treated the bogus flag as "unknown", consumed the prompt as the
// (non-existent) flag's value, then dumped help text to stdout and exited
// 1 — the LLM round-trip never happened. That accounts for ~70% empty-
// output rate in Onda 2/3.
//
// Without that flag opencode `run` runs headless by design and does not
// prompt for permission interactively (the per-action gate is in the
// interactive TUI, not `run`). Removing the flag is enough; auth is
// configured via `~/.local/share/opencode/auth.json` or env vars
// (separate concern — fail loudly if missing instead of silently empty).
// =============================================================================

import type { Task } from '../../../types/index.js';
import type { CliSpec } from '../types.js';
import { opencodeBin } from '../bin-resolver.js';

export interface OpencodeSpecInputs {
  /** True when the raw task.model passes isModelCompatibleWithCli('opencode',...). */
  compatible: boolean;
  task?: Pick<Task, 'model'>;
}

export function buildOpencodeSpec(inputs: OpencodeSpecInputs): CliSpec {
  const { compatible, task } = inputs;
  const args = ['run'];
  // OpenCode wants the FULL `provider/model` string (not stripped).
  // We pass task.model raw IF compatible — `compatible` is the
  // already-resolved boolean from above for the same id+model pair,
  // so this is safe. If not compatible, foreign prefix drops.
  if (compatible && task?.model) args.push('-m', task.model);
  return { bin: opencodeBin(), args, streamJson: false, promptDelivery: 'arg' };
}
