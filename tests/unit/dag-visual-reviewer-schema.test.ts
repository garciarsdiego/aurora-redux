/**
 * FASE C (Visual Reviewer) item 2 — schema coverage for:
 *   1. 'visual' being accepted as a reviewer_profile enum variant.
 *   2. canvasRegionChecks / interactionChecks on a DAG task, mirroring the
 *      CanvasRegionCheck / InteractionCheck shapes from
 *      src/quality/playwright-product-harness.ts, structurally validated
 *      (label/selector/waitMs required) rather than a loose z.any() blob.
 *   3. Back-compat: a DAG task with reviewer_profile='visual' but no checks
 *      configured, and a DAG task with neither field at all, both still
 *      validate cleanly (purely additive schema change).
 */
import { describe, it, expect } from 'vitest';
import { validateDag } from '../../src/brain/dag-validator.js';
import { DagSchema } from '../../src/types/schemas.js';
import type { Dag } from '../../src/types/index.js';

function baseTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Task ${id}`,
    kind: 'llm_call' as const,
    depends_on: [],
    acceptance_criteria:
      'Output contains "done" and length between 5 and 500 chars to satisfy validator length floor.',
    ...overrides,
  };
}

describe('DagTaskSchema — reviewer_profile "visual"', () => {
  it('accepts "visual" as a reviewer_profile value', () => {
    const parsed = DagSchema.parse({
      tasks: [baseTask('t0', { reviewer_profile: 'visual' })],
    });
    expect(parsed.tasks[0].reviewer_profile).toBe('visual');
    const result = validateDag(parsed as Dag);
    expect(result.valid).toBe(true);
  });

  it('still rejects unknown reviewer_profile values', () => {
    const r = DagSchema.safeParse({
      tasks: [baseTask('t0', { reviewer_profile: 'nonsense' })],
    });
    expect(r.success).toBe(false);
  });
});

describe('DagTaskSchema — canvasRegionChecks / interactionChecks pass-through', () => {
  it('parses a visual task carrying both canvasRegionChecks and interactionChecks', () => {
    const parsed = DagSchema.parse({
      tasks: [baseTask('t0', {
        reviewer_profile: 'visual',
        canvasRegionChecks: [
          {
            selector: 'canvas',
            region: 'top',
            expectedLuminanceAbove: 150,
            label: 'sky should be bright at the top',
          },
          {
            selector: 'canvas',
            region: { x: 0, y: 0, w: 64, h: 8 },
            expectedHueRange: [180, 240],
            label: 'top sliver is blue',
          },
        ],
        interactionChecks: [
          {
            label: 'space makes player jump',
            key: 'Space',
            waitMs: 200,
            // Assumes a world/physics coordinate system where +y is UP, so
            // jumping increases player.y. (In screen-space y grows downward
            // — a screen-space debug hook would use expect: 'decrease'.)
            debugHookAssertion: { path: 'window.__debug.player.y', expect: 'increase' },
          },
          {
            label: 'clicking restart resets score',
            clickSelector: '[data-testid="restart"]',
            waitMs: 100,
            domAssertion: { selector: '[data-testid="score"]', property: 'textContent', expect: { equals: '0' } },
            screenshotBeforeAfter: true,
          },
        ],
      })],
    });

    expect(parsed.tasks[0].canvasRegionChecks).toHaveLength(2);
    expect(parsed.tasks[0].interactionChecks).toHaveLength(2);
    const result = validateDag(parsed as Dag);
    expect(result.valid).toBe(true);
  });

  it('requires label/selector on canvasRegionChecks entries', () => {
    const r = DagSchema.safeParse({
      tasks: [baseTask('t0', {
        reviewer_profile: 'visual',
        canvasRegionChecks: [{ region: 'top', expectedLuminanceAbove: 100 }],
      })],
    });
    expect(r.success).toBe(false);
  });

  it('requires label/waitMs on interactionChecks entries', () => {
    const r = DagSchema.safeParse({
      tasks: [baseTask('t0', {
        reviewer_profile: 'visual',
        interactionChecks: [{ key: 'Space' }],
      })],
    });
    expect(r.success).toBe(false);
  });

  it('a visual task with no checks configured is still valid', () => {
    const parsed = DagSchema.parse({
      tasks: [baseTask('t0', { reviewer_profile: 'visual' })],
    });
    expect(parsed.tasks[0].canvasRegionChecks).toBeUndefined();
    expect(parsed.tasks[0].interactionChecks).toBeUndefined();
    const result = validateDag(parsed as Dag);
    expect(result.valid).toBe(true);
  });

  it('omitting reviewer_profile and both check fields entirely is still valid (back-compat)', () => {
    const parsed = DagSchema.parse({
      tasks: [baseTask('t0')],
    });
    expect(parsed.tasks[0].reviewer_profile).toBeUndefined();
    expect(parsed.tasks[0].canvasRegionChecks).toBeUndefined();
    expect(parsed.tasks[0].interactionChecks).toBeUndefined();
    const result = validateDag(parsed as Dag);
    expect(result.valid).toBe(true);
  });
});
