/**
 * FASE C (Visual Reviewer) item 4 — integration-level regression coverage
 * for the runQualityGate wiring in
 * src/brain/executor/run-task/quality-gate.ts.
 *
 * Goal: prove the new visual-gate branch is a strict no-op for every task
 * that does not opt in, so wiring it in cannot regress the pre-existing
 * hardened quality-gate path (already covered end-to-end by
 * executor-quality-gate.test.ts, which never sets reviewer_profile).
 *
 * A task declaring reviewer_profile:'visual' but with no architecture
 * contract in the DB (the common case for these lightweight in-memory
 * executor tests, which never call recordArchitectureContract) must fall
 * straight through to the existing LLM-backed light review path — i.e.
 * attemptTaskVisualGate's "no contract -> null" fail-open branch, exercised
 * here through the full executeWorkflow path rather than calling
 * attemptTaskVisualGate directly.
 */
import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import type { Dag } from '../../src/types/index.js';

describe('executor quality gate — visual reviewer_profile does not affect tasks without checks', () => {
  it('a "visual" task with no canvasRegionChecks/interactionChecks falls through to the normal enforced gate', async () => {
    const previousMode = process.env.OMNIFORGE_TASK_QUALITY_REVIEW;
    process.env.OMNIFORGE_TASK_QUALITY_REVIEW = 'enforced';
    const db = initDb(':memory:');
    try {
      const dag: Dag = {
        tasks: [
          {
            id: 'q1',
            name: 'Claim a missing file was created',
            kind: 'llm_call',
            depends_on: [],
            acceptance_criteria: 'src/Missing.tsx exists',
            reviewer_profile: 'visual',
          },
        ],
      };

      await expect(executeWorkflow(db, dag, 'internal', 'visual profile without checks still uses normal gate', {
        executeTaskFn: async () => 'Implemented src/Missing.tsx.',
        reviewFn: async () => ({ score: 1, feedback: 'legacy reviewer accepted', passed: true }),
        consolidateFn: async () => 'should not run',
      })).rejects.toThrow(/quality gate blocked/i);

      const task = db.prepare('SELECT status FROM tasks LIMIT 1').get() as { status: string };
      const events = db.prepare('SELECT type FROM events ORDER BY id').all() as Array<{ type: string }>;

      expect(task.status).toBe('failed');
      expect(events.map((event) => event.type)).toContain('task_quality_gate_blocked');
      // The visual gate never found a contract, so it never even reported a
      // "ran" event — this is the fail-open no-op branch, and the LLM/light
      // reviewer's own gate-blocked event should be the one on record.
      expect(events.map((event) => event.type)).not.toContain('task_visual_gate_ran');
    } finally {
      if (previousMode === undefined) delete process.env.OMNIFORGE_TASK_QUALITY_REVIEW;
      else process.env.OMNIFORGE_TASK_QUALITY_REVIEW = previousMode;
      db.close();
    }
  });

  it('a plain task (no reviewer_profile at all) behaves identically to before this change', async () => {
    const previousMode = process.env.OMNIFORGE_TASK_QUALITY_REVIEW;
    process.env.OMNIFORGE_TASK_QUALITY_REVIEW = 'enforced';
    const db = initDb(':memory:');
    try {
      const dag: Dag = {
        tasks: [
          {
            id: 'q1',
            name: 'Claim a missing file was created',
            kind: 'llm_call',
            depends_on: [],
            acceptance_criteria: 'src/Missing.tsx exists',
          },
        ],
      };

      await expect(executeWorkflow(db, dag, 'internal', 'no reviewer_profile at all', {
        executeTaskFn: async () => 'Implemented src/Missing.tsx.',
        reviewFn: async () => ({ score: 1, feedback: 'legacy reviewer accepted', passed: true }),
        consolidateFn: async () => 'should not run',
      })).rejects.toThrow(/quality gate blocked/i);

      const events = db.prepare('SELECT type FROM events ORDER BY id').all() as Array<{ type: string }>;
      expect(events.map((event) => event.type)).toContain('task_quality_gate_blocked');
      expect(events.map((event) => event.type)).not.toContain('task_visual_gate_ran');
      expect(events.map((event) => event.type)).not.toContain('task_visual_gate_error');
    } finally {
      if (previousMode === undefined) delete process.env.OMNIFORGE_TASK_QUALITY_REVIEW;
      else process.env.OMNIFORGE_TASK_QUALITY_REVIEW = previousMode;
      db.close();
    }
  });
});
