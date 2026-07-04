/**
 * Regression test for F-LIVE-23 / F-LIVE-7:
 *
 *   OMNIFORGE_USE_PERSONAS=false must be respected by all persona-gated code
 *   paths. Historically, setting the flag to false still triggered the
 *   DecomposerOutputSchema validation (which requires `confidence:
 *   'high'|'medium'|'low'`) because either:
 *     (a) the flag was read before the child env was set, or
 *     (b) an alternate code path bypassed getUsePersonas().
 *
 *   Fix applied (F-LIVE-7): `confidence` is now `.optional()` in
 *   DecomposerOutputSchema so a missing/absent `confidence` field never
 *   causes schema rejection — the postHook DAG-validation still runs.
 *
 *   This file pins:
 *   1. DecomposerOutputSchema accepts output without `confidence` field.
 *   2. DecomposerOutputSchema still rejects bad enum values when present.
 *   3. getUsePersonas() returns false when OMNIFORGE_USE_PERSONAS=false.
 *   4. getUsePersonas() returns true when OMNIFORGE_USE_PERSONAS=true.
 *   5. getUsePersonas() defaults to true when the var is unset (opt-out semantics).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DecomposerOutputSchema } from '../../src/v2/agents/personas/decomposer.js';
import { getUsePersonas } from '../../src/utils/config.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const VALID_TASK = {
  id: 't1',
  name: 'Extract JSON from text',
  kind: 'llm_call' as const,
  depends_on: [] as string[],
};

const BASE_OUTPUT = {
  tasks: [VALID_TASK],
  rationale: 'Single task to extract structured data.',
  recommends_hitl_gate: false,
};

// ── 1. Schema accepts output without confidence (F-LIVE-7 / F-LIVE-23) ───────

describe('DecomposerOutputSchema — confidence field is optional (F-LIVE-7)', () => {
  it('parses successfully when confidence is absent', () => {
    // This is the exact failure mode from F-LIVE-7: GPT-5.5 / Sonnet omit
    // the `confidence` field; the schema must still accept the output so the
    // postHook DAG validation can run.
    const result = DecomposerOutputSchema.safeParse(BASE_OUTPUT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBeUndefined();
    }
  });

  it('parses successfully when confidence is a valid enum value', () => {
    for (const val of ['high', 'medium', 'low'] as const) {
      const result = DecomposerOutputSchema.safeParse({ ...BASE_OUTPUT, confidence: val });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.confidence).toBe(val);
      }
    }
  });

  it('parses successfully when model emits complexity instead of confidence', () => {
    // Some models (GPT-5.5) emit `complexity` as an extra key instead of `confidence`.
    // Zod does not strip extra keys by default, so this must parse without error.
    const result = DecomposerOutputSchema.safeParse({
      ...BASE_OUTPUT,
      complexity: 'moderate',  // extra field the model invented
      // confidence intentionally absent
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid confidence enum value when the field IS present', () => {
    // Regression: making confidence optional must NOT silently accept bad values.
    const result = DecomposerOutputSchema.safeParse({
      ...BASE_OUTPUT,
      confidence: 'very-high',  // invalid
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('confidence');
    }
  });

  it('rejects when tasks array is empty', () => {
    const result = DecomposerOutputSchema.safeParse({ ...BASE_OUTPUT, tasks: [] });
    expect(result.success).toBe(false);
  });
});

// ── 2. getUsePersonas() respects OMNIFORGE_USE_PERSONAS (F-LIVE-23) ──────────

describe('getUsePersonas() — OMNIFORGE_USE_PERSONAS env flag', () => {
  const originalVal = process.env['OMNIFORGE_USE_PERSONAS'];

  afterEach(() => {
    if (originalVal === undefined) {
      delete process.env['OMNIFORGE_USE_PERSONAS'];
    } else {
      process.env['OMNIFORGE_USE_PERSONAS'] = originalVal;
    }
  });

  it('returns false when OMNIFORGE_USE_PERSONAS=false (the harness eval bypass)', () => {
    // This is the exact scenario from F-LIVE-23: the matrix runner sets
    // OMNIFORGE_USE_PERSONAS=false in the spawned child env, and
    // getUsePersonas() must honour it.
    process.env['OMNIFORGE_USE_PERSONAS'] = 'false';
    expect(getUsePersonas()).toBe(false);
  });

  it('returns true when OMNIFORGE_USE_PERSONAS=true', () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'true';
    expect(getUsePersonas()).toBe(true);
  });

  it('returns true when OMNIFORGE_USE_PERSONAS=1', () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = '1';
    expect(getUsePersonas()).toBe(true);
  });

  it('defaults to true (opt-out semantics) when OMNIFORGE_USE_PERSONAS is unset', () => {
    // The flag is opt-OUT: personas are on by default. A fresh spawn that
    // does NOT set the flag should have personas enabled.
    delete process.env['OMNIFORGE_USE_PERSONAS'];
    expect(getUsePersonas()).toBe(true);
  });

  it('returns false for mixed-case "False" (case-insensitive parse)', () => {
    process.env['OMNIFORGE_USE_PERSONAS'] = 'False';
    expect(getUsePersonas()).toBe(false);
  });
});
