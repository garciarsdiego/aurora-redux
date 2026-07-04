// PHASE-3 / Task 3.4 — pass@k metric.
//
// Reliability measurement borrowed from the code-generation eval literature:
// instead of "did the agent pass on a single shot?" (noisy for stochastic
// LLMs), run the generator K times and ask "did AT LEAST ONE of the K
// samples pass?". Per-case score is 1.0 if any sample passed, else 0.0;
// the aggregate `pass@k` is the mean across the suite.
//
// References: HumanEval (Chen et al. 2021) — equation 1 for unbiased
// pass@k estimation with sample reuse. We implement the straight-binary
// flavor by default; the unbiased estimator is also exported for callers
// who already have n>=k samples to score.

export interface PassAtKSample<R> {
  /** The k-th generated output. */
  readonly output: R;
  /** Whether the judge marked this output as passing. */
  readonly passed: boolean;
  /** Optional reason / score from the judge for the report. */
  readonly reason?: string;
}

export interface PassAtKResult<R> {
  /** 1.0 if any of the K samples passed; 0.0 otherwise. */
  readonly score: number;
  /** Count of samples that passed (0..k). */
  readonly passedCount: number;
  /** K — number of attempts. */
  readonly k: number;
  /** All sample outcomes for the report. */
  readonly samples: ReadonlyArray<PassAtKSample<R>>;
}

/**
 * Run the generator K times in parallel and ask the judge whether each
 * output passes. Returns `score = 1` if any sample passed.
 *
 * Generator + judge are caller-supplied so this works for decomposer
 * DAGs, planner outputs, advisor responses, anything. Failures inside
 * the generator (thrown errors) are caught and recorded as
 * `passed: false` with the error message — they never abort the K-run.
 */
export async function passAtK<R>(
  generate: () => Promise<R>,
  judge: (output: R) => Promise<{ passed: boolean; reason?: string }>,
  k: number,
): Promise<PassAtKResult<R>> {
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`passAtK requires k to be a positive integer, got ${k}`);
  }
  const runs = await Promise.all(
    Array.from({ length: k }, async (): Promise<PassAtKSample<R>> => {
      try {
        const output = await generate();
        const verdict = await judge(output);
        return { output, passed: verdict.passed, reason: verdict.reason };
      } catch (err) {
        return {
          output: undefined as unknown as R,
          passed: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  const passedCount = runs.filter((r) => r.passed).length;
  return {
    score: passedCount > 0 ? 1 : 0,
    passedCount,
    k,
    samples: runs,
  };
}

/**
 * Unbiased pass@k estimator (HumanEval eq. 1) — when you've already
 * sampled n >= k outputs for a case and c of them passed, this returns
 * the unbiased probability that a random k-subset contains at least one
 * passing sample.
 *
 *   pass@k = 1 - C(n-c, k) / C(n, k)
 *
 * Returns 1.0 when c >= n - k + 1 (every k-subset must include a pass).
 */
export function unbiasedPassAtK(n: number, c: number, k: number): number {
  if (n < k) throw new Error(`unbiasedPassAtK requires n>=k, got n=${n} k=${k}`);
  if (c < 0 || c > n) throw new Error(`unbiasedPassAtK requires 0<=c<=n, got c=${c} n=${n}`);
  if (n - c < k) return 1.0;
  let prod = 1;
  for (let i = 0; i < k; i += 1) {
    prod *= (n - c - i) / (n - i);
  }
  return 1 - prod;
}

/**
 * Aggregate per-case pass@k results into a suite-level pass@k rate.
 * Arithmetic mean of per-case scores. Convenient for report rendering
 * and CI threshold checks.
 */
export function aggregatePassAtK(
  perCase: ReadonlyArray<{ score: number }>,
): { rate: number; cases: number } {
  if (perCase.length === 0) return { rate: 0, cases: 0 };
  const sum = perCase.reduce((acc, r) => acc + r.score, 0);
  return { rate: sum / perCase.length, cases: perCase.length };
}
