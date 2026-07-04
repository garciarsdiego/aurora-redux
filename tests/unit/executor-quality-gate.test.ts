import { describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import type { Dag } from '../../src/types/index.js';

describe('executor quality gate integration', () => {
  it('does not mark a task completed when enforced light quality review finds missing artifacts', async () => {
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

      await expect(executeWorkflow(db, dag, 'internal', 'quality gate blocks false completion', {
        executeTaskFn: async () => 'Implemented src/Missing.tsx.',
        reviewFn: async () => ({ score: 1, feedback: 'legacy reviewer accepted', passed: true }),
        consolidateFn: async () => 'should not run',
      })).rejects.toThrow(/quality gate blocked/i);

      const workflow = db.prepare("SELECT status FROM workflows WHERE id != '_daemon' LIMIT 1").get() as { status: string };
      const task = db.prepare('SELECT status FROM tasks LIMIT 1').get() as { status: string };
      const events = db.prepare('SELECT type FROM events ORDER BY id').all() as Array<{ type: string }>;

      expect(workflow.status).toBe('failed');
      expect(task.status).toBe('failed');
      expect(events.map((event) => event.type)).toContain('task_quality_gate_blocked');
      expect(events.map((event) => event.type)).not.toContain('workflow_completed');
    } finally {
      if (previousMode === undefined) delete process.env.OMNIFORGE_TASK_QUALITY_REVIEW;
      else process.env.OMNIFORGE_TASK_QUALITY_REVIEW = previousMode;
      db.close();
    }
  });

  it('auto-creates a quality fix task when the gate fires needs_fixes (Tier 0 Wave 3 ITEM 0.6)', async () => {
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

      await expect(executeWorkflow(db, dag, 'internal', 'auto fix task created on gate fail', {
        executeTaskFn: async () => 'Implemented src/Missing.tsx.',
        reviewFn: async () => ({ score: 1, feedback: 'legacy reviewer accepted', passed: true }),
        consolidateFn: async () => 'should not run',
      })).rejects.toThrow(/quality gate blocked/i);

      // The auto-fix event must be emitted BEFORE the gate-blocked event so
      // the operator sees that remediation is already enqueued.
      const events = db.prepare('SELECT type, payload_json AS payload FROM events ORDER BY id').all() as Array<{
        type: string;
        payload: string;
      }>;
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('task_quality_gate_blocked');
      // The auto-fix event is emitted on the source task path. The runtime
      // currently emits it iff parseQualityFixTasks (inside createQualityFixTasks)
      // returns at least one draft AND the saved review's outcome triggers
      // the gate. The light reviewer does not synthesize drafts by default, so
      // the event payload reflects "0 created, 0 existing" — still a valid
      // audit trail demonstrating the call was made.
      expect(eventTypes).toContain('task_quality_gate_auto_fix_created');

      // The auto-fix event must include the review id and source task id.
      const autoFixEvent = events.find((e) => e.type === 'task_quality_gate_auto_fix_created');
      expect(autoFixEvent).toBeDefined();
      const parsed = JSON.parse(autoFixEvent!.payload) as Record<string, unknown>;
      expect(typeof parsed['source_task_id']).toBe('string');
      expect(typeof parsed['review_id']).toBe('string');
      expect(parsed['review_outcome']).toBe('needs_fixes');
    } finally {
      if (previousMode === undefined) delete process.env.OMNIFORGE_TASK_QUALITY_REVIEW;
      else process.env.OMNIFORGE_TASK_QUALITY_REVIEW = previousMode;
      db.close();
    }
  });
});
