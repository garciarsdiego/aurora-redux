import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import type { Dag, ReviewResult, Workflow } from '../../src/types/index.js';
import {
  reviewerOutputToOutcome,
  reviewOutcomeToResult,
  type ReviewOutcome,
} from '../../src/v2/reviewer/outcome.js';
import type { ReviewerOutput } from '../../src/v2/agents/personas/reviewer.js';

function makeReviewerOutput(
  verdict: ReviewerOutput['verdict'],
  feedback = 'feedback',
): ReviewerOutput {
  return {
    verdict,
    feedback,
    evidence: [],
    filesystem_check_summary: { files_verified: [], files_missing: [], files_too_short: [] },
    llm_called: true,
  };
}

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('llm-output'),
}));

vi.mock('../../src/artifacts/store.js', () => ({
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  loadArtifactsForTask: vi.fn().mockResolvedValue([]),
  loadArtifactContent: vi.fn().mockResolvedValue(''),
  loadArtifactsForWorkflow: vi.fn().mockResolvedValue([]),
}));

// Bloco 1.8 — D-H2.019: every task emits task_review_outcome regardless of acceptance_criteria.

function outcomePayloads(db: Database.Database, wfId: string): ReviewOutcome[] {
  const rows = db
    .prepare("SELECT payload_json FROM events WHERE workflow_id = ? AND type = 'task_review_outcome' ORDER BY id")
    .all(wfId) as { payload_json: string | null }[];
  return rows.map((r) => (r.payload_json ? JSON.parse(r.payload_json) as ReviewOutcome : null)).filter(Boolean) as ReviewOutcome[];
}

function eventTypes(db: Database.Database, wfId: string): string[] {
  return (
    db.prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id').all(wfId) as { type: string }[]
  ).map((r) => r.type);
}

async function runSingleTask(
  kind: 'llm_call' | 'cli_spawn' | 'tool_call' | 'pal_call',
  outputFn: () => string,
): Promise<{ wfId: string; db: Database.Database }> {
  const db = initDb(':memory:');
  const dag: Dag = {
    tasks: [{ id: 't1', name: 'task', kind, depends_on: [], executor_hint: null, model: null }],
  };
  const wf = await executeWorkflow(db, dag, '__test__', 'x', {
    executeTaskFn: async () => outputFn(),
    consolidateFn: async () => 'done',
    autoApprove: true,
    sleepFn: async () => {},
  });
  return { wfId: wf.id, db };
}

// ---------------------------------------------------------------------------
// llm_call — basic review outcome
// ---------------------------------------------------------------------------

describe('ReviewOutcome universal — llm_call', () => {
  it('emits hard_success when output is non-empty', async () => {
    const { wfId, db } = await runSingleTask('llm_call', () => 'model response');
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('hard_success');
    expect(outcomes[0]!.confidence).toBe(1);
    db.close();
  });

  it('emits soft_failure when output is empty string', async () => {
    const { wfId, db } = await runSingleTask('llm_call', () => '');
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('soft_failure');
    expect(outcomes[0]!.feedback).toMatch(/empty/i);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// cli_spawn — basic review outcome
// ---------------------------------------------------------------------------

describe('ReviewOutcome universal — cli_spawn', () => {
  it('emits hard_success when output is non-empty', async () => {
    const { wfId, db } = await runSingleTask('cli_spawn', () => 'cli output line');
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('hard_success');
    db.close();
  });

  it('emits soft_failure when output is the sentinel "(empty output)"', async () => {
    const { wfId, db } = await runSingleTask('cli_spawn', () => '(empty output)');
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('soft_failure');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// tool_call — basic review outcome
// ---------------------------------------------------------------------------

describe('ReviewOutcome universal — tool_call', () => {
  it('emits hard_success when ToolResult.success is true', async () => {
    const { wfId, db } = await runSingleTask(
      'tool_call',
      () => JSON.stringify({ success: true, output: 'done', exitCode: 0 }),
    );
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('hard_success');
    db.close();
  });

  it('emits soft_failure when ToolResult.success is false', async () => {
    const { wfId, db } = await runSingleTask(
      'tool_call',
      () => JSON.stringify({ success: false, output: '', error: 'command not found' }),
    );
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('soft_failure');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// pal_call — basic review outcome
// ---------------------------------------------------------------------------

describe('ReviewOutcome universal — pal_call', () => {
  it('emits hard_success when output is non-empty', async () => {
    const { wfId, db } = await runSingleTask('pal_call', () => 'PAL response text');
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('hard_success');
    db.close();
  });

  it('emits soft_failure when output is the sentinel "(empty output)"', async () => {
    const { wfId, db } = await runSingleTask('pal_call', () => '(empty output)');
    const outcomes = outcomePayloads(db, wfId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.outcome_type).toBe('soft_failure');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Acceptance-criteria path — review passes → hard_success
// ---------------------------------------------------------------------------

describe('ReviewOutcome universal — acceptance_criteria review pass', () => {
  it('emits hard_success when reviewer passes (no refine needed)', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [{
        id: 't1',
        name: 'task',
        kind: 'llm_call',
        depends_on: [],
        executor_hint: null,
        model: null,
        acceptance_criteria: 'must be non-empty',
      }],
    };
    const passingReviewer = async (): Promise<ReviewResult> => ({
      score: 0.9,
      feedback: 'looks good',
      passed: true,
    });
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: async () => 'good output',
      reviewFn: passingReviewer,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const outcomes = outcomePayloads(db, wf.id);
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    const success = outcomes.find((o) => o.outcome_type === 'hard_success');
    expect(success).toBeDefined();
    expect(success!.confidence).toBe(0.9);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Ordering guarantee: task_review_outcome before task_completed
// ---------------------------------------------------------------------------

describe('ReviewOutcome ordering', () => {
  it('task_review_outcome appears before task_completed in event stream', async () => {
    const { wfId, db } = await runSingleTask('llm_call', () => 'some output');
    const types = eventTypes(db, wfId);
    const reviewIdx = types.lastIndexOf('task_review_outcome');
    const completedIdx = types.indexOf('task_completed');
    expect(reviewIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(reviewIdx).toBeLessThan(completedIdx);
    db.close();
  });

  it('all tasks in a multi-task workflow emit task_review_outcome', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'a', name: 'A', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 'b', name: 'B', kind: 'tool_call', depends_on: ['a'], executor_hint: null, model: null },
        { id: 'c', name: 'C', kind: 'pal_call', depends_on: ['a'], executor_hint: null, model: null },
      ],
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: async (t) => {
        if (t.kind === 'tool_call') return JSON.stringify({ success: true, output: 'ok' });
        return 'output';
      },
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const wfRow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(wf.id) as Workflow;
    const outcomeCount = (db
      .prepare("SELECT COUNT(*) as n FROM events WHERE workflow_id = ? AND type = 'task_review_outcome'")
      .get(wfRow.id) as { n: number }).n;
    expect(outcomeCount).toBe(3);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Opt 2b — reviewerOutputToOutcome mapping: verdict 'fail' is RECOVERABLE.
// A single LLM reviewer 'fail' must map to soft_failure + refine (so the
// worker gets refine retries) rather than hard_failure + abort. Genuine hard
// failures only surface AFTER refine exhausts (handled in refine.ts).
// ---------------------------------------------------------------------------

describe('reviewerOutputToOutcome — verdict mapping (Opt 2b)', () => {
  it('maps verdict "pass" to hard_success', () => {
    const outcome = reviewerOutputToOutcome(makeReviewerOutput('pass'));
    expect(outcome.outcome_type).toBe('hard_success');
    expect(outcome.confidence).toBe(1);
  });

  it('maps verdict "soft_fail" to soft_success', () => {
    const outcome = reviewerOutputToOutcome(makeReviewerOutput('soft_fail'));
    expect(outcome.outcome_type).toBe('soft_success');
  });

  it('maps verdict "refine" to soft_failure with next_action refine', () => {
    const outcome = reviewerOutputToOutcome(makeReviewerOutput('refine'));
    expect(outcome.outcome_type).toBe('soft_failure');
    expect(outcome.next_action).toBe('refine');
  });

  it('maps a single verdict "fail" to soft_failure + refine (NOT hard_failure/abort)', () => {
    const outcome = reviewerOutputToOutcome(makeReviewerOutput('fail', 'cosmetic miss'));
    // The key regression guard: a single cosmetic 'fail' must be recoverable.
    expect(outcome.outcome_type).toBe('soft_failure');
    expect(outcome.next_action).toBe('refine');
    expect(outcome.next_action).not.toBe('abort');
    expect(outcome.outcome_type).not.toBe('hard_failure');
  });

  it('a single cosmetic-miss "fail" does NOT throw an abort via reviewOutcomeToResult', () => {
    // reviewOutcomeToResult throws on hard_failure/scope_conflict (instant
    // abort). Proving soft_failure does not throw confirms the worker reaches
    // the refine loop instead of aborting the workflow on the first miss.
    const outcome = reviewerOutputToOutcome(makeReviewerOutput('fail', 'one cosmetic miss'));
    expect(() => reviewOutcomeToResult(outcome)).not.toThrow();
    const result = reviewOutcomeToResult(outcome);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Genuine hard-failure coverage is preserved: reviewOutcomeToResult still
// aborts (throws) for outcome_type hard_failure / scope_conflict. Refine
// exhaustion (handled in refine.ts) is what ultimately fails a stuck task —
// this guard ensures the abort path itself was not weakened.
// ---------------------------------------------------------------------------

describe('reviewOutcomeToResult — genuine hard failures still abort', () => {
  it('throws (aborts) on hard_failure outcome', () => {
    const outcome: ReviewOutcome = {
      outcome_type: 'hard_failure',
      confidence: 0.95,
      feedback: 'fundamentally wrong',
      next_action: 'abort',
    };
    expect(() => reviewOutcomeToResult(outcome)).toThrow(/hard_failure/);
  });

  it('throws (aborts) on scope_conflict outcome', () => {
    const outcome: ReviewOutcome = {
      outcome_type: 'scope_conflict',
      confidence: 0.9,
      feedback: 'went beyond scope',
    };
    expect(() => reviewOutcomeToResult(outcome)).toThrow(/scope_conflict/);
  });
});
