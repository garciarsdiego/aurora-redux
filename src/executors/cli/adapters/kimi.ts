// =============================================================================
// adapters/kimi.ts — `cli:kimi` spec builder.
//
// Example smoke test 2026-04-30 — Kimi failure investigation (β-2 wf_6c1b1ca2
// tracer + clink failed 4× each with `reason=unknown`). Direct CLI test
// showed: `kimi --print --dangerously-skip-permissions` returns
//   "Error: No such option: --dangerously-skip-permissions"
// Kimi uses Click-style options and accepts `--yolo / --yes / -y`
// (per `kimi -h`). Same idiom as Codex / Gemini.
//
// Example smoke test 2026-05-01 — Kimi "talks but no files" bug
// (wf_bcd154ca γ-4): kimi spawn produced 167KB of prose but ZERO file
// edits to the target advisors. Example confirmed kimi works fine when
// invoked direct from terminal in the project root.
//
// Root cause: Kimi has a workspace SCOPE (per `kimi -h`):
//   --work-dir / -w   Working directory for the agent. Default: cwd.
//   --add-dir         Add an additional directory to the workspace scope.
// Kimi limits file writes to its work-dir + any --add-dir entries.
// Omniforge cli_spawn cwd is `workspaces/<ws>/runs/<wfId>/` (a temp
// run dir); target files (e.g. src/v2/advisors/...) are ABOVE cwd.
// Kimi silently refuses out-of-scope writes and only describes what
// it would do via the response prose.
//
// Update 2026-05-01 — empirical wire.jsonl analysis revealed the deeper
// mechanic: Kimi DID call WriteFile with paths like
//   "src/v2/advisors/consensus/handler.ts"
// but those are RELATIVE to Kimi's work-dir (defaults to spawn cwd).
// Spawn cwd is `workspaces/<ws>/runs/<wfId>/`, so writes landed at
//   workspaces/<ws>/runs/<wfId>/src/v2/advisors/consensus/handler.ts
// (a shadow tree inside the run dir). Reviewer checked the real repo
// path → didn't find updates → marked task failed.
//
// Fix: pin Kimi's work-dir to the repo root via `-w <repo-root>` so
// relative paths in advisor prompts resolve correctly. Plus keep
// `--add-dir <run-dir>` in scope so scratch output in the per-task
// dir is also writable.
// process.cwd() returns the repo root because the daemon chdir'd there
// at startup (bin/omniforge ce649a3).
// kimi-cli still has no documented stream-json equivalent.
// =============================================================================

import { existsSync } from 'node:fs';
import type { CliSpec } from '../types.js';
import { kimiBin } from '../bin-resolver.js';

export interface KimiSpecInputs {
  safeMode: boolean;
  /**
   * Per-task execution-context cwd = `workspaces/<ws>/runs/<wfId>/...` (the run
   * dir). Distinct from repo-root (process.cwd()). When present and != repoRoot
   * we add it to Kimi's workspace SCOPE via --add-dir so scratch/output Kimi
   * writes under its spawn cwd is in-scope (see header comment, fix half 2).
   * Undefined for non-task callers (no per-task dir) — repoRoot scope only.
   */
  runDir?: string | null;
}

export function buildKimiSpec(inputs: KimiSpecInputs): CliSpec {
  const { safeMode, runDir } = inputs;
  const kimiArgs = ['--print'];
  if (!safeMode) kimiArgs.push('--yolo');
  const repoRoot = process.cwd();
  if (existsSync(repoRoot)) {
    kimiArgs.push('-w', repoRoot);
  }
  // Add the per-task run dir to Kimi's workspace scope when it is a real,
  // distinct directory. Without this, relative writes Kimi makes under its
  // spawn cwd land out-of-scope and are silently refused (γ-4 "talks but no
  // files" root cause, fix half 2). Guard against runDir === repoRoot to avoid
  // a redundant --add-dir, and existsSync to avoid scoping a path that the
  // pre-spawn mkdir in index.ts has not created yet on this code path.
  if (runDir && runDir !== repoRoot && existsSync(runDir)) {
    kimiArgs.push('--add-dir', runDir);
  }
  return {
    bin: kimiBin(),
    args: kimiArgs,
    streamJson: false,
    promptDelivery: 'stdin',
  };
}
