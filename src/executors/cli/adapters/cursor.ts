// =============================================================================
// adapters/cursor.ts — `cli:cursor` spec builder.
//
// Cursor's CLI ships as `cursor-agent` (the `agent.cmd` and
// `cursor-agent.cmd` are aliases for the same .ps1 wrapper). `-p` /
// `--print` is non-interactive; `--force` (alias `--yolo`) auto-approves
// file edits. Stream-json is documented but its event shape diverges
// from Claude Code's — leaving disabled until we capture a dogfood
// sample for a Cursor-specific parser.
//
// Example smoke test 2026-05-01 — "cursor hang" bug fix:
//   Round 1 hypothesis: missing --trust → cursor was waiting on
//   workspace-trust prompts. Adding --trust didn't fix it.
//   Round 2 root cause: cursor-agent.cmd → cursor-agent.ps1 sets two
//   env vars before launching the inner node.exe + index.js:
//     • CURSOR_INVOKED_AS  = "<basename of the .cmd>"
//     • NODE_COMPILE_CACHE = "%LOCALAPPDATA%\cursor-compile-cache"
//   resolveSpawnTarget unwraps the .cmd shim down to node.exe + index.js
//   directly (bypassing the .ps1) so those env vars vanish from the
//   child's environment, and index.js hangs silently — empty stdout,
//   empty stderr, no exit, indefinitely. Reproduced via
//   scripts/cursor-env-test.mjs: setting the two env vars makes a
//   bypassed-shim spawn complete in ~14s with the expected stdout.
//   Also pin --output-format text so the parent reads plain stdout
//   consistently rather than whatever cursor's TTY heuristic chooses
//   for a pipe.
//
// LOAD-BEARING — these two env vars are the D-H2.074 Issue 1 fix.
// Do NOT remove CURSOR_INVOKED_AS or NODE_COMPILE_CACHE from `extraEnv`
// without re-validating against scripts/cursor-env-test.mjs; otherwise
// the inner node.exe + index.js hangs silently. The runtime-resume-cursor
// regression test (currently `describe.skip`-pending) pins this contract.
// =============================================================================

import type { CliSpec } from '../types.js';
import { cursorAgentBin } from '../bin-resolver.js';

export interface CursorSpecInputs {
  safeMode: boolean;
}

export function buildCursorSpec(inputs: CursorSpecInputs): CliSpec {
  const { safeMode } = inputs;
  const args = ['-p', '--output-format', 'text'];
  if (!safeMode) args.push('--force', '--trust');
  const localAppData = process.env.LOCALAPPDATA;
  const extraEnv: Record<string, string> = {
    CURSOR_INVOKED_AS: 'cursor-agent.cmd',
  };
  if (localAppData) {
    extraEnv.NODE_COMPILE_CACHE = `${localAppData}\\cursor-compile-cache`;
  }
  return {
    bin: cursorAgentBin(),
    args,
    streamJson: false,
    promptDelivery: 'arg',
    extraEnv,
  };
}
