/**
 * Tier 0 Wave 4 (0.10) — wire all 4 validator profiles.
 *
 * Until this fix, `consolidation.ts:runFinalValidationStep` invoked the v2
 * validator only when the profile was 'code' AND a project path could be
 * detected in the objective. The other three profiles (content/data/analysis)
 * had implementations under `src/v2/validators/` but were dead code: the
 * `if (validatorProfile !== 'code')` early-return at L88-94 bypassed them.
 *
 * This suite verifies:
 *   1. Each profile's v2 validator is invoked with assembled task outputs.
 *   2. The result is persisted to `workflow.metadata.validation`.
 *   3. `validator_invoked` plus `validator_passed`/`validator_failed`
 *      events are emitted with profile + layer.
 *   4. For 'code' profile both layers must pass (or the legacy layer is N/A
 *      when no project path is in the objective).
 *
 * Tests run against `runFinalValidationStep` directly to avoid the noise
 * of the full executor pipeline. An integration test at the bottom of
 * the file exercises the end-to-end workflow path for one profile to
 * make sure orchestrate.ts wires the step in correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  insertTask,
  setTaskCompleted,
  newWorkflowId,
  newTaskId,
} from '../../src/db/persist.js';
import { runFinalValidationStep } from '../../src/brain/executor/consolidation.js';
import type { Workflow, Task } from '../../src/types/index.js';

// runFinalValidation (legacy build check) calls runCliTask which spawns
// child processes — mock it across the whole file so 'code' profile tests
// don't actually try to compile anything.
vi.mock('../../src/executors/cli.js', () => ({
  runCliTask: vi.fn().mockResolvedValue('VALIDATION OK'),
}));

// --- helpers ----------------------------------------------------------------

function makeWorkflow(opts: {
  validator_profile?: string;
  objective?: string;
  workspace?: string;
} = {}): Workflow {
  const id = newWorkflowId();
  const metadata =
    opts.validator_profile !== undefined
      ? JSON.stringify({ validator_profile: opts.validator_profile })
      : null;
  return {
    id,
    workspace: opts.workspace ?? 'internal',
    objective: opts.objective ?? 'do something simple',
    pattern_id: null,
    status: 'executing',
    started_at: Date.now(),
    completed_at: null,
    created_at: Date.now(),
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    metadata,
  };
}

function makeCompletedTask(workflow_id: string, output: string): Task {
  const id = newTaskId();
  return {
    id,
    workflow_id,
    name: 'A test task',
    kind: 'llm_call',
    input_json: null,
    output_json: output,
    status: 'completed',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 0,
    retry_count: 0,
    retry_policy: 'none',
    started_at: Date.now(),
    completed_at: Date.now(),
    created_at: Date.now(),
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 0,
    refine_feedback: null,
    model: null,
    hitl: false,
  };
}

function seed(workflow: Workflow, outputs: string[]) {
  const db = initDb(':memory:');
  insertWorkflow(db, workflow);
  for (const output of outputs) {
    const task = makeCompletedTask(workflow.id, output);
    insertTask(db, task);
    setTaskCompleted(db, task.id, output);
  }
  return db;
}

function readEvents(db: ReturnType<typeof initDb>, wfId: string) {
  return db
    .prepare(
      `SELECT type, payload_json FROM events WHERE workflow_id = ? ORDER BY id`,
    )
    .all(wfId) as Array<{ type: string; payload_json: string | null }>;
}

function readMetadata(db: ReturnType<typeof initDb>, wfId: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT metadata FROM workflows WHERE id = ?')
    .get(wfId) as { metadata: string | null };
  if (!row.metadata) return {};
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

// --- per-profile pass/fail --------------------------------------------------

describe('runFinalValidationStep — per-profile wiring (Tier 0 Wave 4 0.10)', () => {
  describe('content profile', () => {
    it('long task outputs → v2 validator passes, validation metadata recorded', async () => {
      const wf = makeWorkflow({ validator_profile: 'content', objective: 'write a blog post' });
      const longOutput = 'A'.repeat(200);
      const db = seed(wf, [longOutput]);

      await runFinalValidationStep(db, wf, wf.objective);

      const events = readEvents(db, wf.id);
      const types = events.map((e) => e.type);
      expect(types).toContain('validator_invoked');
      expect(types).toContain('validator_passed');
      expect(types).not.toContain('workflow_validation_skipped');

      const meta = readMetadata(db, wf.id);
      expect(meta).toHaveProperty('validation');
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(true);
      expect(validation['profile']).toBe('content');
      expect((validation['v2'] as Record<string, unknown>)['passed']).toBe(true);
      expect(validation['legacy']).toBeNull();

      db.close();
    });

    it('short task outputs → v2 validator fails (under 100 chars)', async () => {
      const wf = makeWorkflow({ validator_profile: 'content', objective: 'write a blog post' });
      const db = seed(wf, ['too short']);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('validator_invoked');
      expect(types).toContain('validator_failed');

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(false);
      const v2 = validation['v2'] as Record<string, unknown>;
      expect(v2['passed']).toBe(false);
      expect(String(v2['message'])).toMatch(/short/i);

      db.close();
    });
  });

  describe('data profile', () => {
    it('valid JSON array → v2 validator passes', async () => {
      const wf = makeWorkflow({ validator_profile: 'data', objective: 'extract data' });
      // Validator concatenates task outputs with `\n\n`. To produce a single
      // parseable JSON string we use ONE task whose output is the JSON.
      const json = JSON.stringify([{ name: 'A' }, { name: 'B' }]);
      const db = seed(wf, [json]);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('validator_invoked');
      expect(types).toContain('validator_passed');

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(true);
      expect(validation['profile']).toBe('data');

      db.close();
    });

    it('non-JSON output → v2 validator fails', async () => {
      const wf = makeWorkflow({ validator_profile: 'data', objective: 'extract data' });
      const db = seed(wf, ['not at all valid json']);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('validator_failed');

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(false);

      db.close();
    });
  });

  describe('analysis profile', () => {
    it('long output with conclusion marker → v2 validator passes', async () => {
      const wf = makeWorkflow({ validator_profile: 'analysis', objective: 'analyze the data' });
      const output =
        'A detailed look at the inputs. ' +
        'X'.repeat(220) +
        ' In conclusion, the trend is upward.';
      const db = seed(wf, [output]);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('validator_invoked');
      expect(types).toContain('validator_passed');

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(true);
      expect(validation['profile']).toBe('analysis');

      db.close();
    });

    it('long output WITHOUT conclusion → v2 validator fails', async () => {
      const wf = makeWorkflow({ validator_profile: 'analysis', objective: 'analyze the data' });
      const output = 'Some analysis without any wrap-up. ' + 'X'.repeat(250);
      const db = seed(wf, [output]);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('validator_failed');

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(false);
      const v2 = validation['v2'] as Record<string, unknown>;
      expect(String(v2['message'])).toMatch(/conclusion/i);

      db.close();
    });
  });

  describe('code profile', () => {
    it('clean task output AND no project path → v2 passes, legacy is N/A', async () => {
      const wf = makeWorkflow({ validator_profile: 'code', objective: 'do code stuff' });
      // No path in objective → detectProject returns null → legacy layer = null.
      const db = seed(wf, ['Build succeeded. 0 errors.']);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('validator_invoked');
      expect(types).toContain('validator_passed');

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(true);
      expect(validation['profile']).toBe('code');
      expect(validation['legacy']).toBeNull();

      db.close();
    });

    it('task output with TypeScript error → v2 fails, overall passed=false', async () => {
      const wf = makeWorkflow({ validator_profile: 'code', objective: 'fix the bug' });
      const db = seed(wf, [
        "error TS2345: Argument of type 'number' is not assignable to type 'string'.",
      ]);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('validator_failed');

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['passed']).toBe(false);
      const v2 = validation['v2'] as Record<string, unknown>;
      expect(v2['passed']).toBe(false);
      expect(String(v2['message'])).toMatch(/typescript/i);

      db.close();
    });

    it('defaults to code profile when validator_profile is not set in metadata', async () => {
      const wf = makeWorkflow({ objective: 'default profile test' }); // no validator_profile
      const db = seed(wf, ['Clean build. No errors found.']);

      await runFinalValidationStep(db, wf, wf.objective);

      const meta = readMetadata(db, wf.id);
      const validation = meta['validation'] as Record<string, unknown>;
      expect(validation['profile']).toBe('code');
      expect(validation['passed']).toBe(true);

      db.close();
    });
  });

  describe('none profile', () => {
    it('emits workflow_validation_skipped and does NOT write validation metadata', async () => {
      const wf = makeWorkflow({ validator_profile: 'none', objective: 'skip validation' });
      const db = seed(wf, ['anything goes here']);

      await runFinalValidationStep(db, wf, wf.objective);

      const types = readEvents(db, wf.id).map((e) => e.type);
      expect(types).toContain('workflow_validation_skipped');
      expect(types).not.toContain('validator_invoked');
      expect(types).not.toContain('validator_passed');
      expect(types).not.toContain('validator_failed');

      const meta = readMetadata(db, wf.id);
      expect(meta).not.toHaveProperty('validation');

      db.close();
    });
  });

  describe('environment kill-switch', () => {
    it('DISABLE_FINAL_VALIDATION=true → no-op (no events, no metadata write)', async () => {
      const original = process.env['DISABLE_FINAL_VALIDATION'];
      process.env['DISABLE_FINAL_VALIDATION'] = 'true';
      try {
        const wf = makeWorkflow({ validator_profile: 'content', objective: 'short.' });
        const db = seed(wf, ['too short to ever pass content profile']);

        await runFinalValidationStep(db, wf, wf.objective);

        const events = readEvents(db, wf.id);
        // No validator-related events at all
        expect(events.some((e) => e.type.startsWith('validator_'))).toBe(false);
        expect(events.some((e) => e.type === 'workflow_validation_skipped')).toBe(false);

        const meta = readMetadata(db, wf.id);
        expect(meta).not.toHaveProperty('validation');

        db.close();
      } finally {
        if (original === undefined) delete process.env['DISABLE_FINAL_VALIDATION'];
        else process.env['DISABLE_FINAL_VALIDATION'] = original;
      }
    });
  });

  describe('event payload shape', () => {
    it('validator_invoked + validator_passed payloads carry profile and layer', async () => {
      const wf = makeWorkflow({ validator_profile: 'content', objective: 'profile payload test' });
      const db = seed(wf, ['A'.repeat(200)]);

      await runFinalValidationStep(db, wf, wf.objective);

      const events = readEvents(db, wf.id);
      const invoked = events.find((e) => e.type === 'validator_invoked')!;
      const passed = events.find((e) => e.type === 'validator_passed')!;
      expect(invoked).toBeDefined();
      expect(passed).toBeDefined();

      const invokedPayload = JSON.parse(invoked.payload_json!) as Record<string, unknown>;
      expect(invokedPayload['profile']).toBe('content');

      const passedPayload = JSON.parse(passed.payload_json!) as Record<string, unknown>;
      expect(passedPayload['profile']).toBe('content');
      expect(passedPayload['layer']).toBe('v2');
      expect(typeof passedPayload['message']).toBe('string');

      db.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: executor pipeline picks up the validator step for non-code profiles
// ---------------------------------------------------------------------------

describe('executeWorkflow integration — validator profile end-to-end', () => {
  it('workflow with validator_profile=analysis writes analysis validation to metadata', async () => {
    const { executeWorkflow } = await import('../../src/brain/executor.js');
    const db = initDb(':memory:');

    const dag = {
      tasks: [
        { id: 'a', name: 'Task A', kind: 'llm_call' as const, depends_on: [] },
      ],
    };

    // Pre-insert the workflow row with our chosen validator_profile metadata,
    // then drive executeWorkflow with pre_workflow_id so the existing row
    // (and its metadata) is reused instead of overwritten.
    const wfId = newWorkflowId();
    insertWorkflow(db, {
      id: wfId,
      workspace: 'internal',
      objective: 'analysis integration test',
      pattern_id: null,
      status: 'executing',
      started_at: Date.now(),
      completed_at: null,
      created_at: Date.now(),
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: JSON.stringify({ validator_profile: 'analysis' }),
    });

    // Provide a long analysis-friendly output via the executeTaskFn so the
    // analysis validator passes (length >= 200 + conclusion marker).
    const longOutput =
      'Detailed comparative review. ' +
      'X'.repeat(220) +
      ' Therefore, option A wins.';

    const wf = await executeWorkflow(db, dag, 'internal', 'analysis integration test', {
      consolidateFn: async () => 'consolidated',
      executeTaskFn: async () => longOutput,
      pre_workflow_id: wfId,
    });

    expect(wf.status).toBe('completed');

    const wfRow = db
      .prepare('SELECT metadata FROM workflows WHERE id = ?')
      .get(wf.id) as { metadata: string };
    const meta = JSON.parse(wfRow.metadata) as Record<string, unknown>;
    expect(meta).toHaveProperty('validation');
    const validation = meta['validation'] as Record<string, unknown>;
    expect(validation['profile']).toBe('analysis');
    expect(validation['passed']).toBe(true);

    // Consolidator metadata must coexist with validation metadata (merge, not clobber).
    expect(meta['consolidated_output']).toBe('consolidated');

    const events = db
      .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
      .all(wf.id) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain('validator_invoked');
    expect(types).toContain('validator_passed');
    expect(types).toContain('workflow_consolidated');

    db.close();
  });
});
