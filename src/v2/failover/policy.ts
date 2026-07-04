import type { FailoverReason } from "./error.js";
import { loadSetupConfig } from "../../utils/setup-config.js";

// Port of OpenClaw `failover-policy*.ts` + role→model chains
// derived from docs/08-AI-PROVIDER-MATRIX.md § 3 (D-H2.013).
//
// Decisions that consume this file:
//   - brain/executor.ts retry loop (selectBackoffMs, pickNextInChain)
//   - future omniroute-bridge/cooldown probe slot management (Bloco 3)
//
// M1 Wave 2 (2026-05-12, gap B3): the operator-authored chain persisted by
// `/api/setup/fallback` (data/setup-config.json) now takes precedence over
// the hardcoded role chain. See `selectFallbackModel` below.

// --- Cooldown probe semantics ---------------------------------------------

// Shared transient conditions: worth testing whether provider recovered.
const TRANSIENT_REASONS: ReadonlySet<FailoverReason> = new Set([
  'rate_limit',
  'overloaded',
  'timeout',
  'server_error',
  'unknown',
]);

// Billing allows a probe because credential rotation may restore service,
// but does NOT consume a transient slot (it is an account condition).
const PROBE_ALLOWED_REASONS: ReadonlySet<FailoverReason> = new Set<FailoverReason>([
  ...TRANSIENT_REASONS,
  'billing',
]);

// Conditions where a probe does not help at all — a different request must
// be made (new model, new session, fixed input).
const PROBE_INERT_REASONS: ReadonlySet<FailoverReason> = new Set<FailoverReason>([
  'model_not_found',
  'format',
  'auth',
  'auth_permanent',
  'session_expired',
  'payload_too_large',
  'context_overflow',
  'long_context_tier',
  'thinking_signature',
]);

export function shouldAllowCooldownProbe(reason: FailoverReason): boolean {
  return PROBE_ALLOWED_REASONS.has(reason);
}

export function shouldUseTransientCooldownProbeSlot(reason: FailoverReason): boolean {
  return TRANSIENT_REASONS.has(reason);
}

export function shouldPreserveTransientCooldownProbeSlot(reason: FailoverReason): boolean {
  return PROBE_INERT_REASONS.has(reason);
}

// --- Backoff ---------------------------------------------------------------

/**
 * Safety ceiling for a server-provided `Retry-After` window (2 minutes). A
 * provider's explicit guidance is honoured up to this bound; a pathological
 * value (e.g. `Retry-After: 86400`) is clamped so a single transient 429 can
 * never stall a workflow for hours.
 */
export const MAX_RETRY_AFTER_MS = 120_000;

/**
 * @param reason       Classified failover reason.
 * @param attempt      1-based retry number being prepared.
 * @param retryAfterMs Server-provided retry window (ms), captured by the
 *   classifier from the HTTP `Retry-After` header. When present (finite, > 0)
 *   AND the reason is transient (rate_limit / overloaded / timeout /
 *   server_error / unknown), it is PREFERRED over the hardcoded default and
 *   clamped to MAX_RETRY_AFTER_MS — trusting the provider's own window avoids
 *   both hammering it before reset and idly over-waiting. Ignored for
 *   corrective-action reasons (context_overflow et al. stay immediate) and
 *   for non-transient/non-retryable reasons.
 */
export function selectBackoffMs(
  reason: FailoverReason,
  attempt: number,
  retryAfterMs?: number,
): number {
  // `attempt` is 1-based — the retry number being prepared.
  const attemptIdx = Math.max(0, attempt - 1);

  // Aurora-parity Wave-1.5 #1 — honour the server's explicit Retry-After window
  // for transient pressure. Restricted to TRANSIENT_REASONS so that reasons
  // requiring immediate caller action (context_overflow → 0) or a fixed window
  // (auth/billing) keep their tuned semantics.
  if (
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0 &&
    TRANSIENT_REASONS.has(reason)
  ) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  }

  switch (reason) {
    // Immediate — caller is expected to take corrective action (compact,
    // rotate creds, recreate session) before the next attempt fires.
    case 'context_overflow':
    case 'long_context_tier':
    case 'thinking_signature':
    case 'session_expired':
      return 0;

    // Fixed windows tuned to typical provider retry-after values.
    case 'rate_limit':
      return 10_000;
    case 'auth':
      return 1_000;
    case 'billing':
      return 60_000;

    // Exponential with soft cap — transient infra pressure.
    case 'overloaded':
      return Math.min(60_000, 1_000 * 2 ** attemptIdx);
    case 'server_error':
      return Math.min(30_000, 500 * 2 ** attemptIdx);
    case 'timeout':
      return Math.min(30_000, 500 * 2 ** attemptIdx);

    // Non-retryable — caller should not invoke this but defensive value.
    case 'auth_permanent':
    case 'format':
    case 'payload_too_large':
    case 'model_not_found':
      return 0;

    case 'unknown':
      return Math.min(60_000, 1_000 * 2 ** attemptIdx);
  }
}

// --- Fallback chain by role -----------------------------------------------

export type OmniforgeRole =
  | 'decomposer-complex'
  | 'decomposer-simple'
  | 'reviewer-primary'
  | 'reviewer-fallback'
  | 'consolidator'
  | 'consolidator-complex'
  | 'executor-llm-call-default'
  | 'executor-llm-call-complex'
  | 'executor-cli-claude'
  | 'executor-cli-codex'
  | 'executor-cli-gemini'
  | 'pattern-matcher'
  | 'validator'
  | 'prompt-injection-scan'
  | 'hermes-conversation'
  | 'hermes-deep-thinking';

// Derived from docs/08-AI-PROVIDER-MATRIX.md § 3. Keep in sync when matrix moves.
const FALLBACK_CHAINS: Record<OmniforgeRole, readonly string[]> = {
  'decomposer-complex': [
    'cc/claude-opus-4-7',
    'gemini-cli/gemini-3.1-pro-preview',
    'cx/gpt-5.4',
  ],
  'decomposer-simple': [
    'cu/claude-4.6-opus',
    'gh/gpt-5',
    'kmc/kimi-k2.5',
  ],
  'reviewer-primary': [
    'cc/claude-opus-4-6',
    'cx/gpt-5.3-codex-xhigh',
    'kmc/kimi-k2.5-thinking',
  ],
  'reviewer-fallback': [
    'kmc/kimi-k2.5-thinking',
    'cu/claude-4.6-sonnet-high-thinking',
    'ollamacloud/deepseek-r2:671b',
  ],
  'consolidator': [
    'cc/claude-sonnet-4-6',
    'cx/gpt-5.2-codex',
    'gh/gpt-5.2',
  ],
  'consolidator-complex': [
    'cc/claude-opus-4-6',
    'cx/gpt-5.3-codex',
  ],
  'executor-llm-call-default': [
    'cc/claude-sonnet-4-5-20250929',
    'gh/claude-sonnet-4.5',
    'gemini-cli/gemini-2.5-pro',
  ],
  'executor-llm-call-complex': [
    'kmc/kimi-k2.5-thinking',
    'cu/claude-4.6-opus-high-thinking',
    'nvidia/deepseek/deepseek-r1',
  ],
  'executor-cli-claude': [
    'cc/claude-opus-4-7',
    'cc/claude-opus-4-6',
    'cc/claude-sonnet-4-6',
  ],
  'executor-cli-codex': [
    'cx/gpt-5.2-codex',
    'cx/gpt-5.3-codex',
    'cx/gpt-5.1-codex-max',
  ],
  'executor-cli-gemini': [
    'gemini-cli/gemini-3.1-pro-preview',
    'gemini-cli/gemini-3-pro-preview',
    'gemini-cli/gemini-2.5-pro',
  ],
  'pattern-matcher': [
    'cu/claude-4.5-haiku',
    'gh/gpt-5-mini',
    'kmc/kimi-k2.5',
  ],
  'validator': [
    'cc/claude-haiku-4-5-20251001',
    'gemini-cli/gemini-2.5-flash',
    'gh/gpt-4o-mini',
  ],
  'prompt-injection-scan': [
    'groq/meta-llama/llama-prompt-guard-2-86m',
    'groq/meta-llama/llama-prompt-guard-2-22m',
    'groq/openai/gpt-oss-safeguard-20b',
  ],
  'hermes-conversation': [
    'cc/claude-sonnet-4-6',
    'cx/gpt-5.2',
    'gh/claude-sonnet-4.5',
  ],
  'hermes-deep-thinking': [
    'cc/claude-opus-4-7',
    'gemini-cli/gemini-3.1-pro-preview',
    'cx/gpt-5.4',
  ],
};

export function getFallbackChain(role: OmniforgeRole): readonly string[] {
  return FALLBACK_CHAINS[role] ?? [];
}

// Picks the next model after `currentModel` in the chain. Returns undefined
// once the chain is exhausted. If `currentModel` is outside the chain, starts
// at the top — useful when the runner was bootstrapped with an ad-hoc model
// not listed in the matrix.
export function pickNextInChain(
  chain: readonly string[],
  currentModel: string,
): string | undefined {
  if (chain.length === 0) return undefined;
  const idx = chain.indexOf(currentModel);
  if (idx === -1) return chain[0];
  if (idx >= chain.length - 1) return undefined;
  return chain[idx + 1];
}

// --- Effective chain resolution (setup-config override + role default) -----
//
// M1 Wave 2 (gap B3): the Setup → Fallback pane lets the operator author a
// custom chain that takes precedence over the per-role hardcoded chain. The
// override is persisted in `data/setup-config.json` as
// `fallback.chain: { provider, model }[]` with a master `fallback.enabled`
// toggle that, when false, skips fallback entirely.
//
// Precedence:
//   1. setup-config has `fallback.enabled: true` AND non-empty `chain` → use it.
//   2. Otherwise → fall back to the role-derived hardcoded chain.
//
// The fallback to hardcoded preserves prior behaviour for fresh installs and
// for operators who never visited the Setup pane.
function loadSetupFallbackChain(): readonly string[] | null {
  try {
    const cfg = loadSetupConfig();
    if (!cfg.fallback.enabled) return null;
    const models = cfg.fallback.chain
      .map((e) => e.model)
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
    if (models.length === 0) return null;
    return models;
  } catch {
    // setup-config read failures must NOT take down the executor's fallback
    // path — degrade gracefully to the hardcoded role chain. loadSetupConfig
    // already logs malformed-JSON to stderr.
    return null;
  }
}

/**
 * Resolve the effective fallback chain that the executor should walk for a
 * given role. Setup-config override (when enabled and non-empty) wins over
 * the per-role hardcoded chain.
 */
export function getEffectiveFallbackChain(role: OmniforgeRole): readonly string[] {
  return loadSetupFallbackChain() ?? getFallbackChain(role);
}

/**
 * Select the next fallback model after `currentModel`, consulting the
 * operator-authored setup-config chain first. Returns undefined when the
 * chain is exhausted or both sources are empty.
 *
 * Used by the executor retry loop on `classified.shouldFallback` to advance
 * past a failing model while honouring the Setup → Fallback pane.
 */
export function selectFallbackModel(
  role: OmniforgeRole,
  currentModel: string,
): string | undefined {
  return pickNextInChain(getEffectiveFallbackChain(role), currentModel);
}
