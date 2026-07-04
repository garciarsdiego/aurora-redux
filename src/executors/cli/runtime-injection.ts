// =============================================================================
// runtime-injection.ts — opt-in runtime-mode argv mutations.
//
// Scope: when a caller passes `opts.runtime.{streamJson,nativeSessionId}`,
// some CLIs need extra flags spliced into the argv at very specific
// positions. This file isolates that logic from `resolveCliSpec` (which
// stays pure: spec-time inputs only) and from `runCliTask` (which keeps
// its orchestration shape).
//
// Today only gemini has an injection path here. Wave 2 Agent H wires this
// when callers opt into the experimental jsonl-headless tier; production
// defaults stay text-pty-fallback. Other CLIs may grow injection rules in
// later waves (cursor `--resume=<id>`, codex `exec resume <id>`, etc.).
//
// IMPORTANT — the `-p` splice rationale is load-bearing. Gemini's argv
// parser treats anything AFTER `-p` as the prompt body, so injection MUST
// land before that trailing `-p`. Re-splicing recomputes the index because
// the first splice may have shifted positions.
// =============================================================================

import type { RunCliOpts } from './types.js';

export interface RuntimeInjectionInputs {
  cliId: string;
  baseArgs: string[];
  baseStreamJson: boolean;
  opts: RunCliOpts;
}

export interface RuntimeInjectionResult {
  args: string[];
  streamJson: boolean;
}

export function applyRuntimeInjections(inputs: RuntimeInjectionInputs): RuntimeInjectionResult {
  const { cliId, baseArgs, baseStreamJson, opts } = inputs;
  let effectiveArgs = baseArgs;
  let effectiveStreamJson = baseStreamJson;

  // Wave 2 Agent H — opt-in runtime adapter for gemini stream-json + resume.
  // When opts.runtime.streamJson is true AND the CLI is gemini, we flip to
  // the experimental jsonl-headless tier (defaultProtocolTier stays
  // text-pty-fallback per Wave 2 plan — this is opt-in only). The resume
  // flag is injected BEFORE the prompt arg so gemini's argv parser sees it
  // as a flag rather than the prompt body. resolveCliSpec stays pure: all
  // runtime mutations live here.
  if (cliId === 'gemini') {
    const wantsStreamJson = opts.runtime?.streamJson === true;
    const resumeId = opts.runtime?.nativeSessionId ?? null;
    if (wantsStreamJson || resumeId) {
      // gemini's resolveCliSpec block ends with `geminiArgs.push('-p')` so the
      // last arg is `-p` and the prompt is appended later. To inject flags we
      // must splice them in BEFORE that trailing `-p`.
      const next = [...baseArgs];
      const pIdx = next.lastIndexOf('-p');
      const insertAt = pIdx === -1 ? next.length : pIdx;
      if (wantsStreamJson) {
        next.splice(insertAt, 0, '--output-format', 'stream-json');
        effectiveStreamJson = true;
      }
      if (resumeId) {
        // Re-find -p after the splice above (insertAt may have shifted by 2).
        const pIdx2 = next.lastIndexOf('-p');
        const insertAt2 = pIdx2 === -1 ? next.length : pIdx2;
        next.splice(insertAt2, 0, '--resume', resumeId);
      }
      effectiveArgs = next;
    }
  }

  return { args: effectiveArgs, streamJson: effectiveStreamJson };
}
