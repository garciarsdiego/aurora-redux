/**
 * Tier 0 Wave 4 (0.19) — F-D1-2 compliance regression tests.
 *
 * Each of the 4 catch blocks listed in CLAUDE.md F-D1-2 must now emit a
 * low-noise event via `insertEvent` when the metadata payload is malformed.
 * The fallback behavior MUST be preserved (defaults / empty string / etc.).
 *
 * Sites covered:
 *   1. src/brain/executor/cost-cap.ts        — estimateUpcomingCost
 *   2. src/brain/executor/consolidation.ts:78  — validator_profile_lookup
 *   3. src/brain/executor/consolidation.ts:104 — validation_metadata_merge
 *   4. src/brain/executor/hitl-gate.ts         — readGateFeedback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  insertWorkflow,
  insertTask,
  insertHitlGate,
  newWorkflowId,
} from '../../src/db/persist.js';
import {
  estimateUpcomingCost,
} from '../../src/brain/executor/cost-cap.js';
import { readGateFeedback } from '../../src/brain/executor/hitl-gate.js';
import { runFinalValidationStep } from '../../src/brain/executor/consolidation.js';
import { detectProject } from '../../src/brain/projectDetector.js';
import { runFinalValidation } from '../../src/brain/validator.js';
import type { Task, Workflow } from '../../src/types/index.js';

vi.mock('../../src/brain/projectDetector.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/brain/projectDetector.js')>(
    '../../src/brain/projectDetector.js',
  );
  return {
    ...actual,
    detectProject: vi.fn(),
  };
});

vi.mock('../../src/brain/validator.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/brain/validator.js')>(
    '../../src/brain/validator.js',
  );
  return {
    ...actual,
    runFinalValidation: vi.fn(),
  };
});

function makeWorkflow(db: import('better-sqlite3').Database, metadata: string | null): Workflow {
  const id = newWorkflowId();
  const now = Date.now();
  const wf: Workflow = {
    id,
    workspace: 'internal',
    objective: 'silent-catch test',
    pattern_id: null,
    status: 'executing',
    started_at: now,
    completed_at: null,
    created_at: now,
    created_by: null,
    estimated_cost_usd: null,
    actual_cost_usd: null,
    max_total_cost_usd: null,
    metadata,
  };
  insertWorkflow(db, wf);
  return wf;
}

function makeTask(overrides: Partial<Task>): Task {
  const now = Date.now();
  return {
    id: 'tk_silent_catch',
    workflow_id: 'wf_silent_catch',
    name: 'silent-catch test',
    kind: 'llm_call',
    input_json: null,
    output_json: null,
    status: 'pending',
    depends_on: [],
    executor_hint: null,
    timeout_seconds: 300,
    max_retries: 3,
    retry_count: 0,
    retry_policy: 'exponential',
    started_at: null,
    completed_at: null,
    created_at: now,
    acceptance_criteria: null,
    refine_count: 0,
    max_refine: 3,
    refine_feedback: null,
    model: null,
    hitl: false,
    ...overrides,
  };
}

function eventsOfType(
  db: import('better-sqlite3').Database,
  workflowId: string,
  type: string,
): Array<{ type: string; payload_json: string | null; task_id: string | null }> {
  return db
    .prepare(
      `SELECT type, payload_json, task_id FROM events
       WHERE workflow_id = ? AND type = ?
       ORDER BY id ASC`,
    )
    .all(workflowId, type) as Array<{
      type: string;
      payload_json: string | null;
      task_id: string | null;
    }>;
}

describe('F-D1-2 compliance — silent-catch insertEvent', () => {
  beforeEach(() => {
    // Default: detectProject returns null (no project) so most tests skip
    // the inner validation block. Individual tests override as needed.
    vi.mocked(detectProject).mockReturnValue(null);
    vi.mocked(runFinalValidation).mockReset();
  });

  describe('cost-cap.estimateUpcomingCost', () => {
    it('emits cost_cap_metadata_parse_failed when input_json is malformed and db/wfId provided', () => {
      const db = initDb(':memory:');
      const wf = makeWorkflow(db, null);
      const task = makeTask({
        workflow_id: wf.id,
        kind: 'llm_call',
        input_json: 'not-json{{{',
      });
      // FK requires the task row exist before insertEvent can reference it.
      insertTask(db, task);

      const result = estimateUpcomingCost(task, db, wf.id);

      // Fallback preserved: falls back to llm_call default.
      expect(result).toBeGreaterThan(0);

      const events = eventsOfType(db, wf.id, 'cost_cap_metadata_parse_failed');
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload_json!) as { error: string };
      expect(typeof payload.error).toBe('string');
      expect(payload.error.length).toBeGreaterThan(0);
      expect(events[0]!.task_id).toBe(task.id);

      db.close();
    });

    it('does NOT emit when input_json is valid JSON', () => {
      const db = initDb(':memory:');
      const wf = makeWorkflow(db, null);
      const task = makeTask({
        workflow_id: wf.id,
        kind: 'llm_call',
        input_json: JSON.stringify({ estimated_cost_usd: 0.07 }),
      });

      const result = estimateUpcomingCost(task, db, wf.id);
      expect(result).toBe(0.07);

      const events = eventsOfType(db, wf.id, 'cost_cap_metadata_parse_failed');
      expect(events).toHaveLength(0);

      db.close();
    });

    it('preserves behaviour when db/wfId omitted (no event, fallback default)', () => {
      const db = initDb(':memory:');
      const wf = makeWorkflow(db, null);
      const task = makeTask({
        workflow_id: wf.id,
        kind: 'llm_call',
        input_json: '%%%not-json',
      });

      // Called without db/wfId — still returns default fallback, just no event.
      const result = estimateUpcomingCost(task);
      expect(result).toBeGreaterThan(0);

      const events = eventsOfType(db, wf.id, 'cost_cap_metadata_parse_failed');
      expect(events).toHaveLength(0);

      db.close();
    });
  });

  describe('consolidation.runFinalValidationStep (validator_profile_lookup)', () => {
    it('emits consolidation_metadata_parse_failed when metadata is malformed', async () => {
      const db = initDb(':memory:');
      // Malformed metadata triggers the catch at validator_profile_lookup site.
      const wf = makeWorkflow(db, '{not valid json');
      // Use a non-existent objective so detectProject returns null → no
      // downstream validation; the function exits after the catch.
      await runFinalValidationStep(db, wf, '/nonexistent/path/no-project-here');

      const events = eventsOfType(db, wf.id, 'consolidation_metadata_parse_failed');
      const profileLookup = events.filter((e) => {
        const p = JSON.parse(e.payload_json!) as { site: string };
        return p.site === 'validator_profile_lookup';
      });
      expect(profileLookup).toHaveLength(1);
      const payload = JSON.parse(profileLookup[0]!.payload_json!) as {
        error: string;
        site: string;
      };
      expect(payload.site).toBe('validator_profile_lookup');
      expect(typeof payload.error).toBe('string');
      expect(payload.error.length).toBeGreaterThan(0);

      db.close();
    });

    it('does NOT emit when metadata is valid JSON', async () => {
      const db = initDb(':memory:');
      const wf = makeWorkflow(db, JSON.stringify({ validator_profile: 'code' }));

      await runFinalValidationStep(db, wf, '/nonexistent/path/no-project-here');

      const events = eventsOfType(db, wf.id, 'consolidation_metadata_parse_failed');
      expect(events).toHaveLength(0);

      db.close();
    });
  });

  describe('consolidation.runFinalValidationStep (validation_metadata_merge)', () => {
    it('emits consolidation_metadata_parse_failed when metadata is malformed at merge time', async () => {
      const db = initDb(':memory:');
      // Malformed metadata triggers BOTH catch sites: first at
      // validator_profile_lookup (line ~123) then at validation_metadata_merge
      // (line ~165 inside the inner IIFE). The first one falls back to the
      // default 'code' profile so control reaches the second site after the
      // mocked runFinalValidation succeeds.
      const wf = makeWorkflow(db, '{not valid json');

      // Force detectProject to return a recognised project so we enter the
      // inner try block where the second parse lives.
      vi.mocked(detectProject).mockReturnValue({
        type: 'typescript',
        rootDir: '/fake/project',
      });
      vi.mocked(runFinalValidation).mockResolvedValue({
        passed: true,
        summary: 'mocked validation',
        attempts: 1,
        lastOutput: '',
      });

      await runFinalValidationStep(db, wf, '/fake/project');

      const events = eventsOfType(db, wf.id, 'consolidation_metadata_parse_failed');
      const mergeSite = events.filter((e) => {
        const p = JSON.parse(e.payload_json!) as { site: string };
        return p.site === 'validation_metadata_merge';
      });
      expect(mergeSite).toHaveLength(1);
      const payload = JSON.parse(mergeSite[0]!.payload_json!) as {
        error: string;
        site: string;
      };
      expect(payload.site).toBe('validation_metadata_merge');
      expect(typeof payload.error).toBe('string');
      expect(payload.error.length).toBeGreaterThan(0);

      db.close();
    });

    it('does NOT emit at merge site when metadata is valid JSON before merge', async () => {
      const db = initDb(':memory:');
      // Valid metadata — first catch skipped, second IIFE parses cleanly.
      const wf = makeWorkflow(db, JSON.stringify({ existing_key: 'value' }));

      vi.mocked(detectProject).mockReturnValue({
        type: 'typescript',
        rootDir: '/fake/project',
      });
      vi.mocked(runFinalValidation).mockResolvedValue({
        passed: true,
        summary: 'ok',
        attempts: 1,
        lastOutput: '',
      });

      await runFinalValidationStep(db, wf, '/fake/project');

      const events = eventsOfType(db, wf.id, 'consolidation_metadata_parse_failed');
      expect(events).toHaveLength(0);

      db.close();
    });
  });

  describe('hitl-gate.readGateFeedback', () => {
    it('emits mcp_feedback_extract_failed when context_json is malformed', () => {
      const db = initDb(':memory:');
      const wf = makeWorkflow(db, null);
      const gateId = 'gate_silent_catch_test';

      insertHitlGate(db, {
        id: gateId,
        workflow_id: wf.id,
        task_id: null,
        gate_type: 'cli',
        prompt: 'test',
        context_json: 'not-json{{{',
        channel: 'cli',
      });

      const feedback = readGateFeedback(db, gateId);
      // Fallback preserved: empty string.
      expect(feedback).toBe('');

      const events = eventsOfType(db, wf.id, 'mcp_feedback_extract_failed');
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload_json!) as {
        error: string;
        gate_id: string;
      };
      expect(payload.gate_id).toBe(gateId);
      expect(typeof payload.error).toBe('string');
      expect(payload.error.length).toBeGreaterThan(0);

      db.close();
    });

    it('does NOT emit when context_json is valid JSON', () => {
      const db = initDb(':memory:');
      const wf = makeWorkflow(db, null);
      const gateId = 'gate_silent_catch_ok';

      insertHitlGate(db, {
        id: gateId,
        workflow_id: wf.id,
        task_id: null,
        gate_type: 'cli',
        prompt: 'test',
        context_json: JSON.stringify({ mcp_feedback: 'looks good' }),
        channel: 'cli',
      });

      const feedback = readGateFeedback(db, gateId);
      expect(feedback).toBe('looks good');

      const events = eventsOfType(db, wf.id, 'mcp_feedback_extract_failed');
      expect(events).toHaveLength(0);

      db.close();
    });

    it('returns empty string when gate has no context_json (no event)', () => {
      const db = initDb(':memory:');
      const wf = makeWorkflow(db, null);
      const gateId = 'gate_no_context';

      insertHitlGate(db, {
        id: gateId,
        workflow_id: wf.id,
        task_id: null,
        gate_type: 'cli',
        prompt: 'test',
        context_json: null,
        channel: 'cli',
      });

      const feedback = readGateFeedback(db, gateId);
      expect(feedback).toBe('');

      // No event — empty context isn't a parse failure, it's expected.
      const events = eventsOfType(db, wf.id, 'mcp_feedback_extract_failed');
      expect(events).toHaveLength(0);

      db.close();
    });
  });
});
