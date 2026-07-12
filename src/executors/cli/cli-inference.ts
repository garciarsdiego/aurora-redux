// =============================================================================
// cli-inference.ts — map `task.model` ↔ `executor_hint` ↔ CLI id.
//
// Scope:
//   • `modelProvider` / `modelNameForCli` — parse Omniroute-style `provider/model`
//     prefixes and split them into the parts each CLI understands.
//   • `isModelCompatibleWithCli` — the AETHER α-init mismatch guard. If the
//     decomposer hands `cli:codex` a Claude model, we drop the model arg
//     instead of letting Codex crash (and the failover classifier loop).
//   • `inferCliIdFromTask` — resolve a `cli:<id>` hint or fall back to the
//     model's provider prefix.
//   • `runtimeFormatForCli` — map (cliId, streamJson) onto runtime-store
//     protocol/format tags so the dashboard's runtime tab shows the right
//     thing.
//
// IMPORTANT — preserve the AETHER α-init bug rationale block on
// `isModelCompatibleWithCli` and the OpenCode provider Set comment chain.
// Both record live-fire diagnoses that future operators NEED to see when a
// new provider gets added or a model arg starts being silently dropped.
// =============================================================================

import type { Task } from '../../types/index.js';
import type { RuntimeProtocolTier, RuntimeStreamFormat } from '../../runtime/capabilities.js';

export function modelProvider(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model.includes('/')) return model.split('/')[0] ?? null;
  if (model.includes(':')) return model.split(':')[0] ?? null;
  return null;
}

export function modelNameForCli(model: string | null | undefined): string | null {
  if (!model) return null;
  if (model.includes('/')) return model.split('/').slice(1).join('/') || model;
  if (model.includes(':')) return model.split(':').slice(1).join(':') || model;
  return model;
}

// Single source of truth for the provider-family ↔ CLI mapping. Both
// `isModelCompatibleWithCli` (CLI → providers it `accepts`) and
// `inferCliIdFromTask` (provider → CLI via `infers`) derive from this record
// so the two directions can never drift when a provider family grows.
//
// NOTE the deliberate accepts/infers asymmetry on gemini: a bare `gemini/`
// prefix is ACCEPTED when the caller explicitly hints cli:gemini (the model
// arg survives), but only the unambiguous `gemini-cli/` prefix INFERS the
// gemini CLI implicitly — bare `gemini/` models without a hint keep routing
// to the default CLI, exactly as before this table existed.
const CLI_PROVIDER_FAMILIES: Record<string, { accepts: readonly string[]; infers: readonly string[] }> = {
  'claude-code': { accepts: ['cc', 'claude'], infers: ['cc', 'claude'] },
  codex: { accepts: ['cx', 'codex'], infers: ['cx', 'codex'] },
  gemini: { accepts: ['gemini-cli', 'gemini'], infers: ['gemini-cli'] },
  kimi: {
    accepts: ['kimi', 'kmc', 'kmca', 'kimi-coding'],
    infers: ['kimi', 'kmc', 'kmca', 'kimi-coding'],
  },
};

// Example smoke test 2026-04-30 — AETHER α-init bug: a cli_spawn task with
// `executor_hint=cli:codex` and `model=cc/claude-sonnet-4-6` (the H10 default
// for cli_spawn) was being spawned as `codex exec --model claude-sonnet-4-6
// "..."`. Codex CLI does not recognise Claude model names, so it errored out
// in 12-15 seconds per attempt. The failover classifier had no pattern for
// the "unknown model" stderr Codex emits, so it landed in `reason=unknown`
// and retried with the SAME broken combo. Symptom: 4 fast failures back to
// back, no recovery.
//
// The right invariant: each CLI knows its own default model. If the caller
// hands us a `model` that does not match the CLI's provider namespace, we
// should NOT pass `--model` at all and let the CLI use its native default.
// The task can still be configured (timeout, prompt, executor_hint preserved
// — we just drop the incompatible model arg). An event surfaces the mismatch
// so the operator sees the silent demotion.
//
// Each CLI accepts only models from its own provider family — sourced from
// CLI_PROVIDER_FAMILIES above, shared with `inferCliIdFromTask`.
export function isModelCompatibleWithCli(cliId: string, model: string | null | undefined): boolean {
  if (!model) return true; // no model → CLI default is always fine
  const provider = modelProvider(model)?.toLowerCase();
  if (!provider) return true; // unprefixed model — pass through (CLI will validate)
  const family = CLI_PROVIDER_FAMILIES[cliId];
  if (family) return family.accepts.includes(provider);
  switch (cliId) {
    case 'cursor':
    case 'kilo':
      // These CLIs accept `provider/model` as-is via their own routing
      // (Cursor relays to its own subscription backend).
      return true;
    case 'opencode': {
      // Example smoke test 2026-05-01 — OpenCode "empty output" bug:
      // wf_e84181d3 t6 had `model = "cc/claude-sonnet-4-6"` (Omniroute prefix)
      // passed via `-m cc/claude-sonnet-4-6`. OpenCode rejected silently
      // (exit 0, empty stdout, ~93s wall clock).
      //
      // OpenCode has its OWN provider namespace populated via `opencode
      // providers list` — typical credentials: opencode-zen, kimi-for-coding,
      // minimax, zai, ollama-cloud, openrouter, groq, openai, github-copilot,
      // google, nvidia. NO `cc/` or `cx/` (those are Omniroute prefixes).
      //
      // If we are handed an Omniroute-style or unknown prefix, drop the
      // model arg — OpenCode will pick its default (typically OpenCode Zen
      // or Z.AI Coding Plan depending on operator config). Operators who
      // genuinely want a specific OpenCode model can pass it as
      // `model: "opencode-zen/glm-4.6"` etc.
      // Example smoke test 2026-05-04 — DeepSeek/Xiaomi auth-list bug:
      // wf_73be90b1 t1 had `model=deepseek-v4` (no prefix) and wf_a255becd t1
      // had `model=deepseek/deepseek-v4-pro` (with prefix) — both produced
      // empty output. Root cause: this hardcoded Set was missing providers
      // that DO exist in the local `~/.local/share/opencode/auth.json`. When
      // a credential is present locally but not declared here, the model arg
      // is dropped and opencode falls back to its default model (broken in
      // many configs → empty stdout, exit 0). Confirmed by `opencode
      // providers list` output: 17 credentials including DeepSeek, Xiaomi,
      // and kimi-for-coding-oauth, none of which were in the prior Set.
      const opencodeProviders = new Set([
        'opencode-zen', 'kimi-for-coding', 'kimi-for-coding-oauth',
        'minimax', 'zai', 'z.ai', 'ollama-cloud', 'openrouter', 'groq',
        'openai', 'anthropic', 'github-copilot', 'google', 'nvidia',
        'kilo-gateway', 'opencode-go', 'deepseek', 'xiaomi',
        'xiaomi-token-plan-europe',
      ]);
      return opencodeProviders.has(provider);
    }
    default:
      return true; // unknown CLI — leave the model alone, let it surface
  }
}

export function inferCliIdFromTask(hint: string | null | undefined, task?: Pick<Task, 'model'>): string {
  const explicit = hint?.startsWith('cli:') ? hint.slice(4) : null;
  if (explicit && explicit !== 'claude-code' && explicit !== 'auto' && explicit !== 'default') return explicit;
  const provider = modelProvider(task?.model)?.toLowerCase();
  if (provider) {
    // Provider prefixes are disjoint across families, so lookup order is
    // irrelevant. See CLI_PROVIDER_FAMILIES for the gemini infers carve-out.
    for (const [cliId, family] of Object.entries(CLI_PROVIDER_FAMILIES)) {
      if (family.infers.includes(provider)) return cliId;
    }
  }
  return explicit ?? 'claude-code';
}

export function runtimeFormatForCli(cliId: string, streamJson: boolean): {
  protocolTier: RuntimeProtocolTier;
  streamFormat: RuntimeStreamFormat;
  fallbackReason: string | null;
} {
  if (cliId === 'claude-code' && streamJson) {
    return { protocolTier: 'jsonl-headless', streamFormat: 'claude-stream-json', fallbackReason: null };
  }
  if (cliId === 'codex') {
    return {
      protocolTier: 'text-pty-fallback',
      streamFormat: 'plain-text',
      fallbackReason: 'codex exec is currently spawned without --json in this path',
    };
  }
  if (cliId === 'gemini') {
    if (streamJson) {
      // Wave 2 Agent H — opt-in jsonl-headless tier. Maps to the
      // experimental capability entry registered in src/runtime/capabilities.ts
      // for `cli:gemini`. Production callers stay on text-pty-fallback.
      return {
        protocolTier: 'jsonl-headless',
        streamFormat: 'gemini-stream-json',
        fallbackReason: null,
      };
    }
    return { protocolTier: 'text-pty-fallback', streamFormat: 'gemini-text', fallbackReason: 'gemini ACP not probed in production path' };
  }
  if (cliId === 'kimi') {
    return { protocolTier: 'text-pty-fallback', streamFormat: 'kimi-text', fallbackReason: 'kimi ACP not probed in production path' };
  }
  return {
    protocolTier: 'text-pty-fallback',
    streamFormat: 'plain-text',
    fallbackReason: streamJson ? null : 'structured output not enabled for this CLI path',
  };
}
