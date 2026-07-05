// Regression test for the decomposer prompt heuristics added in response to
// the 2026-05-23 harness-eval matrix run.
//
// Pins three changes so future edits don't silently regress them:
//   1. H20 TRIVIAL FAST PATH exists (closes F-LIVE-20 — decomposer over-engineers T1).
//   2. H13's "NEVER bake pre-computed values into criteria" rule exists
//      (closes F-LIVE-19 — decomposer poisons reviewer with wrong concrete values).
//   3. H11 references H20 as the trivial-exception escape hatch.
//
// These are prompt-string assertions because the decomposer's behaviour
// is steered entirely by the system prompt; if the rule text disappears,
// the model loses the steering. The golden eval suite (`pnpm eval:golden`)
// is the runtime regression check.

import { describe, expect, it } from 'vitest';
import { buildDecomposerSystemPrompt } from '../../src/brain/decomposer.js';

describe('decomposer prompt heuristics (F-LIVE-19 / F-LIVE-20)', () => {
  const prompt = buildDecomposerSystemPrompt('cc/claude-sonnet-4-6');

  it('includes H20 TRIVIAL FAST PATH that overrides H11', () => {
    expect(prompt).toContain('H20 TRIVIAL FAST PATH');
    expect(prompt).toContain('SKIP the t0 plan-gate');
  });

  it('strengthens H13 against decomposer-baked pre-computed values', () => {
    expect(prompt).toContain('NEVER bake pre-computed values into criteria');
    expect(prompt).toContain('F-LIVE-19');
  });

  it('updates H11 to point at the H20 trivial exception', () => {
    expect(prompt).toMatch(/H11 PLAN GATE \(MANDATORY[^\n]*see H20/);
  });

  it('includes H21 debug hook convention for interactive/visual projects', () => {
    expect(prompt).toContain('H21 DEBUG HOOK FOR INTERACTIVE/VISUAL PROJECTS');
    expect(prompt).toContain('window.__debug');
    expect(prompt).toContain('t0\'s acceptance_criteria');
  });
});
