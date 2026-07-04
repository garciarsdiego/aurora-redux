/**
 * OPP-R3 — pin `reviewer_profile` field through the DAG validator.
 *
 * The field is optional and the validator only checks for graph integrity,
 * required args, etc. — semantic interpretation of the profile is the
 * reviewer dispatcher's job. These tests pin that:
 *   1. A DAG carrying `reviewer_profile` on any task validates cleanly.
 *   2. The DagSchema accepts all 5 enum variants and rejects unknown ones.
 *   3. Absence of the field is still valid (back-compat).
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

describe('OPP-R3 reviewer_profile pass-through', () => {
  it('validates a DAG carrying reviewer_profile=strict', () => {
    const parsed = DagSchema.parse({
      tasks: [baseTask('t0', { reviewer_profile: 'strict' })],
    });
    const result = validateDag(parsed as Dag);
    expect(result.valid).toBe(true);
    expect(parsed.tasks[0].reviewer_profile).toBe('strict');
  });

  it('accepts all 5 enum variants', () => {
    const variants = ['strict', 'lenient', 'creative', 'code', 'data'] as const;
    for (const v of variants) {
      const parsed = DagSchema.parse({
        tasks: [baseTask('t0', { reviewer_profile: v })],
      });
      expect(parsed.tasks[0].reviewer_profile).toBe(v);
      const result = validateDag(parsed as Dag);
      expect(result.valid).toBe(true);
    }
  });

  it('rejects unknown reviewer_profile values at schema time', () => {
    const r = DagSchema.safeParse({
      tasks: [baseTask('t0', { reviewer_profile: 'paranoid' })],
    });
    expect(r.success).toBe(false);
  });

  it('omitting the field is still valid (back-compat)', () => {
    const parsed = DagSchema.parse({
      tasks: [baseTask('t0')],
    });
    expect(parsed.tasks[0].reviewer_profile).toBeUndefined();
    const result = validateDag(parsed as Dag);
    expect(result.valid).toBe(true);
  });
});
