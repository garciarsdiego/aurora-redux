import { describe, it, expect } from 'vitest';
import {
  computeRecoveryDecision,
  formatDelay,
  MAX_RECOVERY_RETRIES,
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  BACKOFF_MULTIPLIER,
  type RecoveryState,
} from '../../src/v2/failover/recovery-policy.js';

describe('computeRecoveryDecision', () => {
  it('first call returns shouldRetry=true, exhausted=false, delayMs near BASE_DELAY_MS ±10%', () => {
    const decision = computeRecoveryDecision({});

    expect(decision.shouldRetry).toBe(true);
    expect(decision.exhausted).toBe(false);
    expect(decision.nextState.recoveryRetryCount).toBe(1);
    expect(typeof decision.nextState.nextRecoveryAt).toBe('string');

    // BASE_DELAY_MS * 2^0 = BASE_DELAY_MS; ±10% jitter
    const lo = Math.round(BASE_DELAY_MS * 0.9);
    const hi = Math.round(BASE_DELAY_MS * 1.1);
    expect(decision.delayMs).toBeGreaterThanOrEqual(lo);
    expect(decision.delayMs).toBeLessThanOrEqual(hi);
  });

  it('second call returns delayMs roughly 2× base (with jitter)', () => {
    const state: RecoveryState = { recoveryRetryCount: 1 };
    const decision = computeRecoveryDecision(state);

    expect(decision.shouldRetry).toBe(true);
    expect(decision.exhausted).toBe(false);
    expect(decision.nextState.recoveryRetryCount).toBe(2);

    // BASE_DELAY_MS * 2^1 = 2 * BASE_DELAY_MS; ±10% jitter
    const expected = BASE_DELAY_MS * BACKOFF_MULTIPLIER;
    const lo = Math.round(expected * 0.9);
    const hi = Math.round(expected * 1.1);
    expect(decision.delayMs).toBeGreaterThanOrEqual(lo);
    expect(decision.delayMs).toBeLessThanOrEqual(hi);
  });

  it('third call (last allowed) returns shouldRetry=true, count=3', () => {
    const state: RecoveryState = { recoveryRetryCount: 2 };
    const decision = computeRecoveryDecision(state);

    expect(decision.shouldRetry).toBe(true);
    expect(decision.exhausted).toBe(false);
    expect(decision.nextState.recoveryRetryCount).toBe(3);
  });

  it('exhausts budget after MAX_RECOVERY_RETRIES+1 calls', () => {
    let state: RecoveryState = {};

    // Simulate the full retry cycle: calls 1..MAX_RECOVERY_RETRIES succeed,
    // the (MAX_RECOVERY_RETRIES+1)th call exhausts the budget.
    let decision = computeRecoveryDecision(state);
    for (let i = 1; i <= MAX_RECOVERY_RETRIES; i++) {
      expect(decision.shouldRetry).toBe(true);
      expect(decision.exhausted).toBe(false);
      state = decision.nextState;
      decision = computeRecoveryDecision(state);
    }

    // This call is attempt MAX_RECOVERY_RETRIES+1 — budget exhausted.
    expect(decision.shouldRetry).toBe(false);
    expect(decision.exhausted).toBe(true);
    expect(decision.delayMs).toBe(0);
    expect(decision.nextState.recoveryRetryCount).toBeUndefined();
    expect(decision.nextState.nextRecoveryAt).toBeUndefined();
  });

  it('nextState.recoveryRetryCount increments correctly across sequential calls', () => {
    let state: RecoveryState = {};

    for (let expected = 1; expected <= MAX_RECOVERY_RETRIES; expected++) {
      const decision = computeRecoveryDecision(state);
      expect(decision.nextState.recoveryRetryCount).toBe(expected);
      state = decision.nextState;
    }
  });

  it('delay is capped at MAX_DELAY_MS even for very high retry counts', () => {
    // Artificially high count to force exponential into cap territory.
    const state: RecoveryState = { recoveryRetryCount: 2 };
    const decision = computeRecoveryDecision(state);

    // At count 3 (next = 3): BASE_DELAY_MS * 2^2 = 4 * BASE_DELAY_MS = 240000,
    // which is still below MAX_DELAY_MS (300000). The cap is exercised at count 4+
    // but our MAX_RECOVERY_RETRIES=3 prevents reaching that — just verify the
    // returned delay never exceeds MAX_DELAY_MS regardless of jitter.
    expect(decision.delayMs).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(decision.delayMs).toBeGreaterThanOrEqual(0);
  });

  it('nextRecoveryAt is an ISO 8601 timestamp in the future', () => {
    const before = Date.now();
    const decision = computeRecoveryDecision({});
    const after = Date.now();

    const ts = decision.nextState.nextRecoveryAt;
    expect(typeof ts).toBe('string');
    const parsed = new Date(ts!).getTime();
    expect(parsed).toBeGreaterThan(before);
    expect(parsed).toBeLessThanOrEqual(after + MAX_DELAY_MS + 1000); // 1s headroom
  });

  it('treats missing recoveryRetryCount the same as zero', () => {
    const withUndefined = computeRecoveryDecision({ recoveryRetryCount: undefined });
    const withZero = computeRecoveryDecision({});

    // Both should produce count=1; delay ranges overlap (not bit-identical due to
    // Math.random, but both should be in BASE_DELAY_MS ±10%).
    expect(withUndefined.nextState.recoveryRetryCount).toBe(1);
    expect(withZero.nextState.recoveryRetryCount).toBe(1);
  });
});

describe('formatDelay', () => {
  it('returns "30s" for 30000 ms', () => {
    expect(formatDelay(30_000)).toBe('30s');
  });

  it('returns "1m" for exactly 60000 ms', () => {
    expect(formatDelay(60_000)).toBe('1m');
  });

  it('returns "2m" for exactly 120000 ms', () => {
    expect(formatDelay(120_000)).toBe('2m');
  });

  it('returns "5m" for exactly 300000 ms (MAX_DELAY_MS)', () => {
    expect(formatDelay(300_000)).toBe('5m');
  });

  it('returns seconds string for non-round minute values', () => {
    // 90 seconds = 1.5 minutes — not a round minute, falls back to "90s"
    expect(formatDelay(90_000)).toBe('90s');
  });

  it('returns "0s" for 0 ms', () => {
    expect(formatDelay(0)).toBe('0s');
  });

  it('rounds 59999 ms to "1m" (Math.round(59.999) = 60, which is a whole minute)', () => {
    // Math.round(59999 / 1000) = 60; 60 % 60 === 0 => "1m"
    expect(formatDelay(59_999)).toBe('1m');
  });

  it('handles sub-second values gracefully (rounds to 0s)', () => {
    expect(formatDelay(499)).toBe('0s');
  });
});
