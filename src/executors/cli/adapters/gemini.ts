// =============================================================================
// adapters/gemini.ts — `cli:gemini` spec builder.
//
// Example smoke test 2026-05-05 (post-audit fix, supersedes 2026-04-30):
//
// Gemini-CLI 0.32.x failed ~70% of cli_spawn dispatches in Onda 2/3 with
// exit 1 + empty stdout. Root cause (repro in scripts/repro-cli-failures.mjs):
//
//   1. The previously-documented `--skip-trust` flag DOES NOT EXIST in
//      gemini-cli 0.32.x — gemini's argv parser rejects it as
//      "Unknown arguments: skip-trust, skipTrust" and exits before any
//      LLM round-trip. The earlier 2026-04-30 fix referenced
//      geminicli.com/docs/cli/trusted-folders but that flag was never
//      shipped in this build (or was renamed/removed).
//
//   2. stdin-delivered prompt did not survive after gemini's interactive
//      mode broke on the unknown flag. Empirically, `gemini --yolo -p
//      "<prompt>"` with `promptDelivery: 'arg'` exits 0 in ~30s and
//      returns the model's text — that's the path Omniforge now uses.
//
// Trust-folder note: gemini-cli does have a folderTrust gate, but in our
// repro the `-p` flag path did NOT hit it (case 2: cwd=fresh tmp dir,
// exit 0, 74-char haiku). We keep `--yolo` to bypass per-action
// confirmations; if a future gemini build does block on folderTrust
// here, the work-around is `~/.gemini/settings.json` { folderTrust:
// false } or whitelisting workspaces dir — neither needed today.
//
// CLI_SAFE_MODE=true reverts to bare gemini (no --yolo) for sandboxed
// exploration, but the prompt delivery stays the same.
//
// Aurora-Redux 2026-07-04 — MIGRATED to Antigravity CLI (`agy`). gemini-cli was
// shut down 2026-06-18 (IneligibleTierError on the individual free tier). The
// successor `agy` keeps the same non-interactive shape: `agy -p "<prompt>"`
// (prompt as arg, NOT stdin — verified), `--dangerously-skip-permissions` for
// auto-approve (replaces `--yolo`), and `--model <id>` (verified id:
// gemini-3.1-pro). Auth is via the operator's Google AI Ultra sign-in (system
// keyring). `-p` MUST stay last so runCliTask appends the prompt as its value.
// =============================================================================

import type { CliSpec } from '../types.js';
import { agyBin } from '../bin-resolver.js';

export interface GeminiSpecInputs {
  cliModel: string | null;
  safeMode: boolean;
}

const DEFAULT_AGY_MODEL = 'gemini-3.1-pro';

export function buildGeminiSpec(inputs: GeminiSpecInputs): CliSpec {
  const { cliModel, safeMode } = inputs;
  const args: string[] = [];
  if (!safeMode) args.push('--dangerously-skip-permissions');
  // Old gemini-cli ids ('gemini-3.1-pro-preview' etc.) are not agy ids —
  // normalize anything unrecognized to the verified default.
  const model = cliModel && !/preview/i.test(cliModel) ? cliModel : DEFAULT_AGY_MODEL;
  args.push('--model', model);
  // `-p <prompt>` — runCliTask appends the resolved prompt as the LAST argv
  // element when promptDelivery === 'arg', so `-p` must be last.
  args.push('-p');
  return {
    bin: agyBin(),
    args,
    streamJson: false,
    promptDelivery: 'arg',
  };
}
