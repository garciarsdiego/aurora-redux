/**
 * FASE C item 1 — Unit tests for the deterministic InteractionCheck logic.
 *
 * `evaluateInteraction` is the pure comparison function extracted from the
 * Playwright interaction-check flow (read value BEFORE -> dispatch key/click
 * -> wait -> read value AFTER -> compare). It is exercised directly here with
 * no Playwright/Chromium involved — the harness itself (which drives the
 * actual page) is covered separately by integration-style skip-path tests.
 *
 * Deterministic — zero LLM cost. Never throws: an `increase`/`decrease`
 * expectation against non-numeric values fails closed with a reason instead
 * of throwing or silently passing.
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateInteraction,
  type InteractionExpect,
} from '../../src/quality/playwright-product-harness.js';

describe('evaluateInteraction — increase', () => {
  it('passes when after > before (real numeric increase)', () => {
    const result = evaluateInteraction(10, 15, 'increase');
    expect(result.pass).toBe(true);
  });

  it('fails when after === before (no movement)', () => {
    const result = evaluateInteraction(10, 10, 'increase');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/did not increase/i);
  });

  it('fails when after < before (decreased instead)', () => {
    const result = evaluateInteraction(10, 5, 'increase');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/did not increase/i);
  });
});

describe('evaluateInteraction — decrease', () => {
  it('passes when after < before (real numeric decrease)', () => {
    const result = evaluateInteraction(15, 10, 'decrease');
    expect(result.pass).toBe(true);
  });

  it('fails when after === before (no movement)', () => {
    const result = evaluateInteraction(10, 10, 'decrease');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/did not decrease/i);
  });

  it('fails when after > before (increased instead)', () => {
    const result = evaluateInteraction(10, 15, 'decrease');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/did not decrease/i);
  });
});

describe('evaluateInteraction — equals', () => {
  it('passes on an exact match', () => {
    const result = evaluateInteraction('idle', 'jumping', { equals: 'jumping' });
    expect(result.pass).toBe(true);
  });

  it('fails on a mismatch', () => {
    const result = evaluateInteraction('idle', 'idle', { equals: 'jumping' });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/did not equal/i);
  });

  it('matches numeric equality too', () => {
    const result = evaluateInteraction(0, 1, { equals: 1 });
    expect(result.pass).toBe(true);
  });
});

describe('evaluateInteraction — fail-closed on non-numeric values', () => {
  it('fails increase when after is non-numeric', () => {
    const result = evaluateInteraction(10, 'not-a-number' as unknown as number, 'increase');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/numeric/i);
  });

  it('fails increase when before is non-numeric', () => {
    const result = evaluateInteraction(undefined, 15, 'increase');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/numeric/i);
  });

  it('fails decrease when values are non-numeric (e.g. objects)', () => {
    const result = evaluateInteraction({ x: 1 }, { x: 2 }, 'decrease');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/numeric/i);
  });

  it('fails increase when values are NaN', () => {
    const result = evaluateInteraction(Number.NaN, Number.NaN, 'increase');
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/numeric/i);
  });
});

describe('evaluateInteraction — never throws', () => {
  it('does not throw for any combination of exotic inputs', () => {
    const exoticValues: unknown[] = [undefined, null, NaN, {}, [], 'x', Symbol('s')];
    const expectations: InteractionExpect[] = ['increase', 'decrease', { equals: 'x' }];
    for (const before of exoticValues) {
      for (const after of exoticValues) {
        for (const expectation of expectations) {
          expect(() => evaluateInteraction(before, after, expectation)).not.toThrow();
        }
      }
    }
  });
});
