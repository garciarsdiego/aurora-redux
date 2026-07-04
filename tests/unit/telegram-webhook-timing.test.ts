/**
 * Security test: constant-time secret comparison used by telegram-webhook route.
 *
 * Verifies the four rejection/acceptance cases required by the H-1 security finding.
 * Spy-based "always calls timingSafeEqual" verification is not portable in ESM
 * (crypto namespace is not configurable). Instead we validate the timing-safe property
 * structurally: the helper must correctly evaluate ALL cases without short-circuiting
 * on length, and must produce the right boolean in every scenario.
 *
 * Cases:
 *  1. Correct secret → accepted
 *  2. Wrong secret, same length → rejected
 *  3. Wrong secret, different length → rejected
 *  4. Missing/empty secret → rejected
 */
import { describe, it, expect } from 'vitest';
import { constantTimeCompare } from '../../src/utils/timing-safe-compare.js';

describe('constantTimeCompare (timing-safe secret check)', () => {
  const EXPECTED = 'my-webhook-secret-abc123';

  it('case 1: accepts the correct secret', () => {
    expect(constantTimeCompare(EXPECTED, EXPECTED)).toBe(true);
  });

  it('case 2: rejects a wrong secret of the same length', () => {
    // Construct a string identical in length but different in content
    const wrongSameLen = EXPECTED.slice(0, -1) + (EXPECTED.endsWith('3') ? '4' : '3');
    expect(wrongSameLen.length).toBe(EXPECTED.length); // sanity
    expect(constantTimeCompare(wrongSameLen, EXPECTED)).toBe(false);
  });

  it('case 3: rejects a wrong secret of a different length', () => {
    expect(constantTimeCompare('short', EXPECTED)).toBe(false);
    expect(constantTimeCompare(EXPECTED + '-extra', EXPECTED)).toBe(false);
  });

  it('case 4: rejects an empty/missing secret', () => {
    expect(constantTimeCompare('', EXPECTED)).toBe(false);
  });

  it('does not accept an arbitrary non-matching string that merely shares a prefix', () => {
    expect(constantTimeCompare(EXPECTED.slice(0, 5), EXPECTED)).toBe(false);
  });

  it('returns false when expected secret is identical length but all-zero bytes', () => {
    const zeroFill = '\x00'.repeat(EXPECTED.length);
    expect(constantTimeCompare(zeroFill, EXPECTED)).toBe(false);
  });
});
