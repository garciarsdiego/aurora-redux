// PHASE-3 / Task 3.4 — pass@k metric unit tests.

import { describe, it, expect } from 'vitest';
import {
  passAtK,
  unbiasedPassAtK,
  aggregatePassAtK,
} from '../../src/v2/evals/metrics/pass-at-k.js';

describe('passAtK', () => {
  it('returns score=1 when any sample passes', async () => {
    let call = 0;
    const result = await passAtK(
      async () => ++call,
      async (n: number) => ({ passed: n === 3 }), // only the 3rd attempt passes
      5,
    );
    expect(result.score).toBe(1);
    expect(result.passedCount).toBe(1);
    expect(result.k).toBe(5);
    expect(result.samples).toHaveLength(5);
  });

  it('returns score=0 when no sample passes', async () => {
    const result = await passAtK(
      async () => 'output',
      async () => ({ passed: false, reason: 'never passes' }),
      3,
    );
    expect(result.score).toBe(0);
    expect(result.passedCount).toBe(0);
  });

  it('treats generator errors as non-passing samples (does not abort the run)', async () => {
    let call = 0;
    const result = await passAtK(
      async () => {
        call += 1;
        if (call === 1) throw new Error('flaky');
        return call;
      },
      async (n: number) => ({ passed: n === 2 }),
      3,
    );
    expect(result.score).toBe(1);
    expect(result.passedCount).toBe(1);
    expect(result.samples.find((s) => s.reason === 'flaky')).toBeDefined();
  });

  it('rejects non-positive integer k', async () => {
    await expect(passAtK(async () => 1, async () => ({ passed: true }), 0)).rejects.toThrow(/positive integer/);
    await expect(passAtK(async () => 1, async () => ({ passed: true }), -2)).rejects.toThrow(/positive integer/);
    await expect(passAtK(async () => 1, async () => ({ passed: true }), 1.5)).rejects.toThrow(/positive integer/);
  });
});

describe('unbiasedPassAtK', () => {
  it('returns 1.0 when every k-subset must include a pass (c >= n-k+1)', () => {
    expect(unbiasedPassAtK(10, 8, 3)).toBe(1.0);
    expect(unbiasedPassAtK(5, 5, 1)).toBe(1.0);
  });

  it('returns 0.0 when no samples passed', () => {
    expect(unbiasedPassAtK(10, 0, 3)).toBe(0);
  });

  it('matches HumanEval formula for typical values', () => {
    // n=10, c=2, k=1 → 1 - C(8,1)/C(10,1) = 1 - 8/10 = 0.2
    expect(unbiasedPassAtK(10, 2, 1)).toBeCloseTo(0.2, 6);
    // n=10, c=2, k=5 → 1 - (8*7*6*5*4)/(10*9*8*7*6) = 1 - 20/90 ≈ 0.7778
    expect(unbiasedPassAtK(10, 2, 5)).toBeCloseTo(7 / 9, 4);
  });

  it('rejects invalid inputs', () => {
    expect(() => unbiasedPassAtK(2, 1, 5)).toThrow(/n>=k/);
    expect(() => unbiasedPassAtK(5, -1, 2)).toThrow(/0<=c<=n/);
    expect(() => unbiasedPassAtK(5, 7, 2)).toThrow(/0<=c<=n/);
  });
});

describe('aggregatePassAtK', () => {
  it('returns rate=0 and cases=0 for empty input', () => {
    expect(aggregatePassAtK([])).toEqual({ rate: 0, cases: 0 });
  });

  it('computes the arithmetic mean across cases', () => {
    const res = aggregatePassAtK([{ score: 1 }, { score: 1 }, { score: 0 }, { score: 1 }]);
    expect(res.rate).toBe(0.75);
    expect(res.cases).toBe(4);
  });
});
