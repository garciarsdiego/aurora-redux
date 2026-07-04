/**
 * D-H2.078 — Omniroute timeout regression tests.
 *
 * Two pieces:
 *   1. `computeOmnirouteTimeoutMs` — pure function, prompt-size scaling math.
 *   2. `callOmniroute` — actionable error message when AbortSignal fires.
 *
 * The 2026-05-04 multi-chat run hit the old 120s default with a 30K plan +
 * Opus decomposer. These tests pin the new behavior:
 *   - 300s base floor (5 min)
 *   - +12 ms per char of prompt (so 30K → 360s, 100K → 1200s)
 *   - 1800s hard ceiling (30 min) regardless of prompt size
 *   - Timeout error names the prompt size, model, current effective ms
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { computeOmnirouteTimeoutMs, getOmnirouteTimeoutMs } from '../../src/utils/config.js';
import { callOmniroute } from '../../src/utils/omniroute-call.js';

describe('computeOmnirouteTimeoutMs (prompt-size scaling)', () => {
  const originalTimeout = process.env['OMNIROUTE_TIMEOUT_MS'];

  beforeEach(() => {
    delete process.env['OMNIROUTE_TIMEOUT_MS'];
  });

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env['OMNIROUTE_TIMEOUT_MS'];
    else process.env['OMNIROUTE_TIMEOUT_MS'] = originalTimeout;
  });

  it('returns the new 300s base floor when prompt is small', () => {
    expect(computeOmnirouteTimeoutMs(0)).toBe(300_000);
    expect(computeOmnirouteTimeoutMs(500)).toBe(300_000);
    expect(computeOmnirouteTimeoutMs(10_000)).toBe(300_000); // 120s scaled — base wins
  });

  it('scales above the floor for ~25K+ char prompts', () => {
    // 25K * 12 = 300_000 — exactly the boundary
    expect(computeOmnirouteTimeoutMs(25_000)).toBe(300_000);
    // 30K * 12 = 360_000 — scaled wins
    expect(computeOmnirouteTimeoutMs(30_000)).toBe(360_000);
  });

  it('gives a 30K plan (~the multi-chat case) extra time over the old 120s', () => {
    expect(computeOmnirouteTimeoutMs(30_000)).toBeGreaterThan(120_000);
    expect(computeOmnirouteTimeoutMs(30_000)).toBe(360_000); // 6 min — opus has time to think
  });

  it('caps at 1800s (30 min) for very large prompts', () => {
    expect(computeOmnirouteTimeoutMs(150_000)).toBe(1_800_000);
    expect(computeOmnirouteTimeoutMs(500_000)).toBe(1_800_000);
    expect(computeOmnirouteTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(1_800_000);
  });

  it('treats negative or non-finite prompt sizes as base-floor (defensive math)', () => {
    expect(computeOmnirouteTimeoutMs(-1)).toBe(300_000);
    expect(computeOmnirouteTimeoutMs(Number.NaN)).toBe(300_000);
    // Infinity isn't finite either — falls through to base. We do NOT want
    // Infinity * MS_PER_CHAR to even enter the Math.min/Math.ceil path.
    expect(computeOmnirouteTimeoutMs(Number.POSITIVE_INFINITY)).toBe(300_000);
  });

  it('honors OMNIROUTE_TIMEOUT_MS env override as the new base floor', () => {
    process.env['OMNIROUTE_TIMEOUT_MS'] = '60000'; // 1 min
    expect(getOmnirouteTimeoutMs()).toBe(60_000);
    expect(computeOmnirouteTimeoutMs(1_000)).toBe(60_000); // base wins
    expect(computeOmnirouteTimeoutMs(30_000)).toBe(360_000); // scaled wins (still kicks in)
    expect(computeOmnirouteTimeoutMs(200_000)).toBe(1_800_000); // ceiling still enforced
  });

  it('lets operators raise the floor without losing dynamic scaling', () => {
    process.env['OMNIROUTE_TIMEOUT_MS'] = '600000'; // 10 min floor
    expect(computeOmnirouteTimeoutMs(1_000)).toBe(600_000);
    expect(computeOmnirouteTimeoutMs(80_000)).toBe(960_000); // 80K * 12 = scaled wins
    expect(computeOmnirouteTimeoutMs(200_000)).toBe(1_800_000); // ceiling
  });
});

describe('callOmniroute timeout error message (D-H2.078)', () => {
  const envKeys = [
    'OMNIROUTE_URL',
    'OMNIROUTE_API_KEY',
    'OMNIROUTE_TIMEOUT_MS',
    'OMNIROUTE_MAX_RETRIES',
  ] as const;
  const originalEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of envKeys) originalEnv.set(key, process.env[key]);
    process.env['OMNIROUTE_URL'] = 'http://omniroute.test';
    process.env['OMNIROUTE_API_KEY'] = 'test-key';
    process.env['OMNIROUTE_MAX_RETRIES'] = '0';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('includes prompt size, model, and remediation hints when timing out', async () => {
    // Simulate AbortSignal.timeout() firing — the spec name is TimeoutError.
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));

    // Build a 30K-char system prompt to mirror the real failure case.
    const bigSystem = 'x'.repeat(30_000);

    let caught: Error | null = null;
    try {
      await callOmniroute({
        systemPrompt: bigSystem,
        userPrompt: 'plan it',
        model: 'claude/claude-opus-4-6',
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeTruthy();
    const msg = caught!.message;
    expect(msg).toMatch(/timed out after \d+s/);
    expect(msg).toContain('claude/claude-opus-4-6');
    expect(msg).toMatch(/prompt.{0,5}\d+K chars/);
    expect(msg).toMatch(/faster model|haiku|sonnet/i);
    expect(msg).toMatch(/split the objective|sub-objectives/i);
    expect(msg).toContain('OMNIROUTE_TIMEOUT_MS');
  });

  it('falls back to the generic "Omniroute unreachable" message for non-timeout transport errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(
      callOmniroute({ systemPrompt: 's', userPrompt: 'u', model: 'cc/claude-sonnet-4-6' }),
    ).rejects.toThrow(/Omniroute request failed/);
  });
});
