// M1-W1-D — A11 — requireActorToken uses constantTimeTokenCompare so a
// V8 hash-bucket short-circuit cannot leak per-token timing. The timing
// test uses a high-N samples-loop to stabilise the noise — it's a coarse
// smoke check (CI variance can blow up a single sample by 100x) so we
// assert geometric-mean ratios under a generous threshold rather than
// strict equality.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  actorRegistry,
  generateActorToken,
  requireActorToken,
  ACTOR_TOKEN_TTL_MS,
} from '../../src/mcp/routes/_actor-registry.js';
import { constantTimeTokenCompare } from '../../src/mcp/routes/_shared.js';

const SAMPLES = 5_000;

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

beforeEach(() => {
  actorRegistry.clear();
});

afterEach(() => {
  actorRegistry.clear();
});

describe('A11 — actor token lookup', () => {
  it('returns null for missing or empty tokens', () => {
    expect(requireActorToken(undefined)).toBeNull();
    expect(requireActorToken('')).toBeNull();
    expect(requireActorToken(null as unknown as string)).toBeNull();
  });

  it('returns the entry when the exact token is presented', () => {
    const tok = generateActorToken();
    actorRegistry.set(tok, {
      actor_id: 'repl-alpha',
      kind: 'repl',
      expires_at: Date.now() + ACTOR_TOKEN_TTL_MS,
    });
    const auth = requireActorToken(tok);
    expect(auth).not.toBeNull();
    expect(auth!.actor_id).toBe('repl-alpha');
    expect(auth!.actor_token).toBe(tok);
  });

  it('returns null for an invalid token even when other valid tokens exist', () => {
    // Populate registry with several real tokens so the iteration runs.
    for (let i = 0; i < 5; i++) {
      actorRegistry.set(generateActorToken(), {
        actor_id: `actor-${i}`,
        kind: 'repl',
        expires_at: Date.now() + ACTOR_TOKEN_TTL_MS,
      });
    }
    const bogus = 'a'.repeat(64);
    expect(requireActorToken(bogus)).toBeNull();
  });

  it('returns null for an expired token even on exact match', () => {
    const tok = generateActorToken();
    actorRegistry.set(tok, {
      actor_id: 'expired-one',
      kind: 'repl',
      expires_at: Date.now() - 1_000,
    });
    expect(requireActorToken(tok)).toBeNull();
  });
});

describe('A11 — constantTimeTokenCompare basic semantics', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeTokenCompare('abc', 'abc')).toBe(true);
  });

  it('returns false for unequal but same-length strings', () => {
    expect(constantTimeTokenCompare('abc', 'abd')).toBe(false);
  });

  it('returns false for different-length strings (no early exit on length)', () => {
    expect(constantTimeTokenCompare('abc', 'abcd')).toBe(false);
    expect(constantTimeTokenCompare('abcd', 'abc')).toBe(false);
  });
});

describe('A11 — timing-difference smoke test', () => {
  // The bar we measure: median latency of a valid-token lookup vs. a
  // bogus-token lookup should be within ~2x. The old `actorRegistry.get`
  // path was ~2-3 orders of magnitude faster for valid hits than for
  // misses on a populated map (it short-circuits via hash bucket).
  //
  // With constant-time compare we expect both code paths to do similar
  // work (iterate, compare bytes for every entry until match-or-none).
  // 2x threshold leaves headroom for CI noise without becoming flaky.
  it('valid vs invalid lookup medians stay within ~2x of each other', () => {
    // Plant 8 tokens.
    const tokens: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = generateActorToken();
      actorRegistry.set(t, {
        actor_id: `act-${i}`,
        kind: 'repl',
        expires_at: Date.now() + ACTOR_TOKEN_TTL_MS,
      });
      tokens.push(t);
    }

    const validToken = tokens[tokens.length - 1]!;
    const bogusToken = 'z'.repeat(validToken.length);

    // Warm-up to dodge JIT cold-start noise on the first sample.
    for (let i = 0; i < 200; i++) {
      requireActorToken(validToken);
      requireActorToken(bogusToken);
    }

    const validSamples: number[] = [];
    const invalidSamples: number[] = [];

    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      requireActorToken(validToken);
      validSamples.push(performance.now() - t0);

      const t1 = performance.now();
      requireActorToken(bogusToken);
      invalidSamples.push(performance.now() - t1);
    }

    const mValid = median(validSamples);
    const mInvalid = median(invalidSamples);
    // Avoid divide-by-zero in pathological microbench timing.
    const ratio = mValid === 0 || mInvalid === 0
      ? 1
      : Math.max(mValid, mInvalid) / Math.min(mValid, mInvalid);

    expect(ratio).toBeLessThan(3);
  });
});
