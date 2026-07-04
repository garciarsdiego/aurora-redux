// =============================================================================
// adapters/codex.ts — `cli:codex` spec builder.
//
// Example smoke test 2026-04-30 — AETHER α-init resume bug (wf_770d763c):
// `codex exec` defaults to a READ-ONLY sandbox. The challenge port task
// ran for ~5 minutes reading sources but produced ZERO files. Reviewer
// correctly classified as hard_failure ("the Codex session is restricted
// by a read-only sandbox").
//
// First fix attempt used `--full-auto` (Codex docs: "low-friction
// sandboxed automatic execution" = workspace-write + skip approvals).
// That ALSO failed: Omniforge cli_spawn runs in `workspaces/<ws>/runs/
// <wfId>/` as cwd, but cli_spawn tasks routinely need to write to the
// ACTUAL repo (e.g. src/v2/advisors/<name>/handler.ts is the parent of
// the parent of the run dir). `workspace-write` correctly refuses
// anything above cwd. Codex stderr after --full-auto: "patch rejected:
// writing is blocked by read-only sandbox" with `sandbox_mode=read-only`
// (the [windows] config block in ~/.codex/config.toml further constrained).
//
// Every OTHER cli_spawn in Omniforge bypasses sandbox in non-safeMode:
//   claude-code: --dangerously-skip-permissions
//   kimi:        --dangerously-skip-permissions
//   opencode:    --dangerously-skip-permissions
//   gemini:      --yolo (auto-accept all actions, no separate sandbox)
//   cursor:      --force
//   kilo:        --auto
//
// Codex needs the same. Tried `--yolo` (Example's day-to-day flag); it
// sets `approval=never` but leaves `sandbox=read-only` because
// workspace-write only covers cwd descendants. Omniforge cli_spawn
// cwd is `workspaces/<ws>/runs/<wfId>/` while ports write to
// `src/v2/advisors/<name>/...` (above cwd) — workspace-write refuses.
// Empirical confirmation in wf_6c1b1ca2 debug retry: Codex banner
// showed `approval: never, sandbox: read-only`, exit 1, zero files.
//
// The full bypass flag (--dangerously-bypass-approvals-and-sandbox)
// sets BOTH approval=never AND sandbox=danger-full-access. That's
// the right shape for Omniforge's cli_spawn where the daemon already
// controls the parent process and externally sandboxes writes via
// workspace boundary checks (validated separately).
//
// Example smoke test 2026-04-30 — also pass `--ignore-user-config`. The
// beta-recovery (wf_2d6abe11) thinkdeep task failed with stderr:
//   "rmcp::transport::worker: worker quit with fatal:
//    Transport channel closed, when Deserialize(Error(...))"
// Example's ~/.codex/config.toml registers plugins (documents, spreadsheets,
// browser-use, etc.) that Codex tries to start via Rust-MCP transport
// on every `exec`. With Omniforge's stdin piped (prompt delivery), the
// child MCP transport handshake fails and Codex aborts. Skipping
// user config for cli_spawn invocations bypasses the plugin load —
// we don't need them for Omniforge ports anyway. Auth still uses
// CODEX_HOME per the flag's documented semantic, so login is preserved.
// =============================================================================

import type { CliSpec } from '../types.js';
import { codexBin } from '../bin-resolver.js';

export interface CodexSpecInputs {
  cliModel: string | null;
  safeMode: boolean;
}

export function buildCodexSpec(inputs: CodexSpecInputs): CliSpec {
  const { cliModel, safeMode } = inputs;
  const codexArgs = ['exec', ...(cliModel ? ['--model', cliModel] : [])];
  if (!safeMode) {
    codexArgs.push('--dangerously-bypass-approvals-and-sandbox');
    codexArgs.push('--ignore-user-config');
  }
  return {
    bin: codexBin(),
    args: codexArgs,
    streamJson: false,
    promptDelivery: 'stdin',
  };
}
