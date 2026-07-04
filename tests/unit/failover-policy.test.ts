import { describe, it, expect } from 'vitest';
import type { FailoverReason } from '../../src/v2/failover/error.js';
import {
  shouldAllowCooldownProbe,
  shouldUseTransientCooldownProbeSlot,
  shouldPreserveTransientCooldownProbeSlot,
  selectBackoffMs,
  getFallbackChain,
  pickNextInChain,
  MAX_RETRY_AFTER_MS,
} from '../../src/v2/failover/policy.js';

describe('shouldAllowCooldownProbe', () => {
  it('allows probes for transient + billing reasons', () => {
    const reasons: FailoverReason[] = [
      'rate_limit',
      'overloaded',
      'timeout',
      'server_error',
      'unknown',
      'billing',
    ];
    for (const r of reasons) expect(shouldAllowCooldownProbe(r)).toBe(true);
  });

  it('disallows probes for input / routing / session reasons', () => {
    const reasons: FailoverReason[] = [
      'model_not_found',
      'format',
      'auth',
      'auth_permanent',
      'session_expired',
      'payload_too_large',
      'context_overflow',
      'long_context_tier',
      'thinking_signature',
    ];
    for (const r of reasons) expect(shouldAllowCooldownProbe(r)).toBe(false);
  });
});

describe('shouldUseTransientCooldownProbeSlot', () => {
  it('consumes transient slot only for runtime-pressure reasons', () => {
    const consuming: FailoverReason[] = ['rate_limit', 'overloaded', 'timeout', 'server_error', 'unknown'];
    for (const r of consuming) expect(shouldUseTransientCooldownProbeSlot(r)).toBe(true);
  });

  it('does NOT consume transient slot for billing (account-level)', () => {
    expect(shouldUseTransientCooldownProbeSlot('billing')).toBe(false);
  });

  it('does NOT consume slot for inert reasons', () => {
    expect(shouldUseTransientCooldownProbeSlot('format')).toBe(false);
    expect(shouldUseTransientCooldownProbeSlot('model_not_found')).toBe(false);
  });
});

describe('shouldPreserveTransientCooldownProbeSlot', () => {
  it('preserves slot for input / routing / session / auth reasons', () => {
    const preserving: FailoverReason[] = [
      'model_not_found',
      'format',
      'auth',
      'auth_permanent',
      'session_expired',
      'payload_too_large',
      'context_overflow',
      'long_context_tier',
      'thinking_signature',
    ];
    for (const r of preserving) expect(shouldPreserveTransientCooldownProbeSlot(r)).toBe(true);
  });

  it('does NOT preserve for transient reasons', () => {
    expect(shouldPreserveTransientCooldownProbeSlot('rate_limit')).toBe(false);
    expect(shouldPreserveTransientCooldownProbeSlot('server_error')).toBe(false);
  });
});

describe('selectBackoffMs', () => {
  it('returns 0 for reasons that require caller action (compact, rotate, recreate)', () => {
    const immediate: FailoverReason[] = [
      'context_overflow',
      'long_context_tier',
      'thinking_signature',
      'session_expired',
    ];
    for (const r of immediate) expect(selectBackoffMs(r, 1)).toBe(0);
  });

  it('rate_limit fixed 10s', () => {
    expect(selectBackoffMs('rate_limit', 1)).toBe(10_000);
    expect(selectBackoffMs('rate_limit', 4)).toBe(10_000);
  });

  it('auth fixed 1s', () => {
    expect(selectBackoffMs('auth', 1)).toBe(1_000);
  });

  it('billing long 60s (last-chance)', () => {
    expect(selectBackoffMs('billing', 1)).toBe(60_000);
  });

  it('overloaded exponential capped at 60s', () => {
    expect(selectBackoffMs('overloaded', 1)).toBe(1_000);
    expect(selectBackoffMs('overloaded', 2)).toBe(2_000);
    expect(selectBackoffMs('overloaded', 3)).toBe(4_000);
    expect(selectBackoffMs('overloaded', 10)).toBe(60_000); // capped
  });

  it('timeout exponential capped at 30s', () => {
    expect(selectBackoffMs('timeout', 1)).toBe(500);
    expect(selectBackoffMs('timeout', 2)).toBe(1_000);
    expect(selectBackoffMs('timeout', 10)).toBe(30_000); // capped
  });

  it('server_error exponential capped at 30s', () => {
    expect(selectBackoffMs('server_error', 1)).toBe(500);
    expect(selectBackoffMs('server_error', 10)).toBe(30_000);
  });

  it('unknown exponential capped at 60s', () => {
    expect(selectBackoffMs('unknown', 1)).toBe(1_000);
    expect(selectBackoffMs('unknown', 10)).toBe(60_000);
  });

  it('non-retryable reasons return 0 defensively', () => {
    expect(selectBackoffMs('auth_permanent', 1)).toBe(0);
    expect(selectBackoffMs('format', 1)).toBe(0);
    expect(selectBackoffMs('payload_too_large', 1)).toBe(0);
    expect(selectBackoffMs('model_not_found', 1)).toBe(0);
  });
});

// Aurora-parity Wave-1.5 #1 — honour the server `Retry-After` header.
// When the failover classifier captured a server-provided retry-after (in ms),
// the backoff for transient reasons MUST prefer it over the hardcoded
// 10s / blind-exponential defaults, so a 429/503 waits exactly as long as the
// provider asked (no hammering before the window resets, no idle over-waiting).
describe('selectBackoffMs — honours server Retry-After', () => {
  it('prefers the retry-after value over the rate_limit 10s default (longer)', () => {
    expect(selectBackoffMs('rate_limit', 1, 30_000)).toBe(30_000);
  });

  it('prefers the retry-after value over the rate_limit default (shorter — trust the server)', () => {
    expect(selectBackoffMs('rate_limit', 1, 5_000)).toBe(5_000);
  });

  it('honours retry-after for every transient reason', () => {
    expect(selectBackoffMs('overloaded', 1, 45_000)).toBe(45_000);
    expect(selectBackoffMs('server_error', 1, 20_000)).toBe(20_000);
    expect(selectBackoffMs('timeout', 1, 8_000)).toBe(8_000);
    expect(selectBackoffMs('unknown', 1, 15_000)).toBe(15_000);
  });

  it('clamps a pathological retry-after to MAX_RETRY_AFTER_MS', () => {
    expect(MAX_RETRY_AFTER_MS).toBe(120_000);
    expect(selectBackoffMs('rate_limit', 1, 86_400_000)).toBe(MAX_RETRY_AFTER_MS);
    // A value just over the ceiling is clamped too (belt-and-suspenders even
    // though extractRetryAfterMs already clamps before this point).
    expect(selectBackoffMs('overloaded', 1, 200_000)).toBe(MAX_RETRY_AFTER_MS);
  });

  it('ignores non-positive / non-finite retry-after (falls back to default)', () => {
    expect(selectBackoffMs('rate_limit', 1, 0)).toBe(10_000);
    expect(selectBackoffMs('rate_limit', 1, -5)).toBe(10_000);
    expect(selectBackoffMs('rate_limit', 1, Number.NaN)).toBe(10_000);
    expect(selectBackoffMs('rate_limit', 1, Number.POSITIVE_INFINITY)).toBe(10_000);
  });

  it('is backward-compatible when retry-after is undefined', () => {
    expect(selectBackoffMs('rate_limit', 1, undefined)).toBe(10_000);
    expect(selectBackoffMs('overloaded', 3, undefined)).toBe(4_000);
  });

  it('does NOT honour retry-after for non-transient reasons', () => {
    // context_overflow needs immediate corrective action — stays 0.
    expect(selectBackoffMs('context_overflow', 1, 30_000)).toBe(0);
    // auth is a fixed 1s window, not a transient-pressure reason.
    expect(selectBackoffMs('auth', 1, 30_000)).toBe(1_000);
    // billing keeps its 60s last-chance window.
    expect(selectBackoffMs('billing', 1, 30_000)).toBe(60_000);
    // non-retryable reasons stay 0.
    expect(selectBackoffMs('format', 1, 30_000)).toBe(0);
    expect(selectBackoffMs('model_not_found', 1, 30_000)).toBe(0);
  });
});

describe('getFallbackChain', () => {
  it('returns decomposer-complex top picks from matrix', () => {
    const chain = getFallbackChain('decomposer-complex');
    expect(chain[0]).toBe('cc/claude-opus-4-7');
    expect(chain).toHaveLength(3);
  });

  it('returns reviewer-primary chain ending in kimi thinking', () => {
    const chain = getFallbackChain('reviewer-primary');
    expect(chain).toEqual([
      'cc/claude-opus-4-6',
      'cx/gpt-5.3-codex-xhigh',
      'kmc/kimi-k2.5-thinking',
    ]);
  });

  it('returns validator chain with haiku first', () => {
    const chain = getFallbackChain('validator');
    expect(chain[0]).toBe('cc/claude-haiku-4-5-20251001');
  });

  it('all roles have at least one model in the chain', () => {
    const roles = [
      'decomposer-complex',
      'decomposer-simple',
      'reviewer-primary',
      'reviewer-fallback',
      'consolidator',
      'consolidator-complex',
      'executor-llm-call-default',
      'executor-llm-call-complex',
      'executor-cli-claude',
      'executor-cli-codex',
      'executor-cli-gemini',
      'pattern-matcher',
      'validator',
      'prompt-injection-scan',
      'hermes-conversation',
      'hermes-deep-thinking',
    ] as const;
    for (const r of roles) expect(getFallbackChain(r).length).toBeGreaterThanOrEqual(1);
  });
});

describe('pickNextInChain', () => {
  it('returns next model in chain when current is present', () => {
    const chain = ['a', 'b', 'c'];
    expect(pickNextInChain(chain, 'a')).toBe('b');
    expect(pickNextInChain(chain, 'b')).toBe('c');
  });

  it('returns undefined when chain is exhausted', () => {
    expect(pickNextInChain(['a', 'b'], 'b')).toBeUndefined();
  });

  it('returns first model when current is not in chain (bootstrap)', () => {
    expect(pickNextInChain(['a', 'b'], 'z')).toBe('a');
  });

  it('returns undefined for empty chain', () => {
    expect(pickNextInChain([], 'a')).toBeUndefined();
  });
});
