// =============================================================================
// permission-context.ts — CLI permission scoping via AsyncLocalStorage.
//
// Scope: hosts the `safe | autonomous` permission mode pinned to an async
// call stack and the `isCliSafeMode()` predicate every adapter reads.
//
// D34.5 Bug D — Code-gen tasks must be able to write files. Claude Code in
// --print mode blocks Write/Edit tool use awaiting interactive approval that
// never comes in a spawned subprocess. --dangerously-skip-permissions turns
// the CLI into a trusted automation agent. Acceptable here because:
//   1. Omniforge is a personal tool under the user's full control
//   2. The decomposer prompt is authored by us, not untrusted input
//   3. Tasks run one-shot with timeouts; no persistent privilege elevation
// Opt out with CLI_SAFE_MODE=true — tasks that require writes will then fail
// with "permission blocked" messages (current pre-fix behaviour). Daemon/MCP
// contexts default to safe mode unless CLI_SAFE_MODE=false is explicitly set.
//
// Cursor's `--force` / `--yolo`, Kilo's `--auto`, and OpenCode's
// `--dangerously-skip-permissions` serve the same purpose and are all gated
// by the same CLI_SAFE_MODE toggle for consistency.
// =============================================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CliPermissionMode } from './types.js';

const cliPermissionContext = new AsyncLocalStorage<CliPermissionMode>();

export function withCliPermissionMode<T>(mode: CliPermissionMode, fn: () => T): T {
  return cliPermissionContext.run(mode, fn);
}

// Prompt delivery convention matrix (per-CLI, from each vendor's headless docs):
//
// claude:   `claude --print --output-format stream-json --verbose`  stdin  (NDJSON)
// gemini:   `gemini`                                                stdin  (text)
// codex:    `codex exec`                                            stdin  (text)
// kimi:     `kimi --print`                                          stdin  (text)
// cursor:   `agent -p --force`                                      arg    (text; stream-json available but shape differs from Claude's)
// kilo:     `kilo run --auto`                                       arg    (text; no JSON output documented)
// opencode: `opencode run --dangerously-skip-permissions` [-m m/b]  arg    (text today; --format json available, shape TBD)
export function isCliSafeMode(): boolean {
  const scopedMode = cliPermissionContext.getStore();
  if (scopedMode === 'safe') return true;
  if (scopedMode === 'autonomous') return false;
  if (process.env.CLI_SAFE_MODE === 'true') return true;
  if (process.env.CLI_SAFE_MODE === 'false') return false;
  return process.env.OMNIFORGE_DAEMON_CHILD === '1' || process.env.OMNIFORGE_MCP_SAFE_MODE === 'true';
}

/**
 * EXEC-02 — true when safe mode is in effect SOLELY because of the implicit
 * daemon-child / MCP default (i.e. the operator never made an explicit choice).
 * resolve-spec.ts uses this to emit a one-line, actionable warning per
 * cli_spawn so a Hermes-driven write task does not silently hang/no-op.
 * Returns false when the operator explicitly chose safe (scoped 'safe' or
 * CLI_SAFE_MODE=true) — that is an intentional, expected gate, not a surprise.
 */
export function isImplicitDaemonSafeMode(): boolean {
  if (!isCliSafeMode()) return false;
  const scopedMode = cliPermissionContext.getStore();
  if (scopedMode === 'safe') return false; // explicit per-run choice
  if (process.env.CLI_SAFE_MODE === 'true') return false; // explicit env choice
  return process.env.OMNIFORGE_DAEMON_CHILD === '1' || process.env.OMNIFORGE_MCP_SAFE_MODE === 'true';
}
