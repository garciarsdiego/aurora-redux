import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { executeWorkflow } from '../../src/brain/executor.js';
import { initDb } from '../../src/db/client.js';
import type { Dag, Task, ReviewResult, Workflow } from '../../src/types/index.js';
import type { ReviewOutcome } from '../../src/v2/reviewer/outcome.js';
import { getFallbackChain } from '../../src/v2/failover/policy.js';

// Regression suite for Bloco 1 Tier 0 cirurgia:
//   - AUDIT F-D1-1 (executor retry loop): typed failover events, reason-driven branch
//   - AUDIT F-D1-2 (review failure): typed ReviewOutcome emission, no silent completion
//   - Extra swallow points (refine exhaust / budget / timeout / error, consolidate error)

function setupDb(): Database.Database {
  return initDb(':memory:');
}

interface EventRow {
  type: string;
  payload_json: string | null;
}

function eventTypes(db: Database.Database, wfId: string): string[] {
  const rows = db
    .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
    .all(wfId) as { type: string }[];
  return rows.map((r) => r.type);
}

function payloadsOfType(db: Database.Database, wfId: string, type: string): unknown[] {
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY id')
    .all(wfId, type) as EventRow[];
  return rows.map((r) => (r.payload_json ? JSON.parse(r.payload_json) : null));
}

const originalEnv = { ...process.env };

beforeEach(() => {
  // Keep tests fast — avoid multi-second retry backoffs.
  process.env.MAX_REVIEW_TIME_MS = '150';
  process.env.MAX_CONSOLIDATE_TIME_MS = '150';
  // Force fast failure for any Omniroute calls (e.g. engine.compact in context_overflow path).
  // Without this, a real Omniroute at 20228 would make the context_overflow test timeout.
  process.env.OMNIROUTE_URL = 'http://localhost:1';
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('executor retry loop — classifier-driven events', () => {
  it('context_overflow error emits task_needs_compaction and aborts retries', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'giant prompt',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: null,
        },
      ],
    };

    const failingExecute = async (_t: Task): Promise<string> => {
      throw new Error('Request exceeds maximum context length of 200000 tokens');
    };

    let thrown: unknown;
    try {
      await executeWorkflow(db, dag, '__test__', 'x', {
        executeTaskFn: failingExecute,
        consolidateFn: async () => 'c',
        autoApprove: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    const types = eventTypes(db, wfRow.id);
    expect(types).toContain('task_failover_classified');
    expect(types).toContain('task_needs_compaction');

    const classified = payloadsOfType(db, wfRow.id, 'task_failover_classified') as Array<{
      reason: string;
    }>;
    expect(classified[0]?.reason).toBe('context_overflow');

    db.close();
  });

  it('billing error (429 quota exceeded) emits task_credential_rotation_needed', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'x',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: null,
        },
      ],
    };

    const failingExecute = async (_t: Task): Promise<string> => {
      const err = Object.assign(new Error('Quota exceeded — upgrade plan to continue'), {
        status: 429,
      });
      throw err;
    };

    let thrown: unknown;
    try {
      await executeWorkflow(db, dag, '__test__', 'x', {
        executeTaskFn: failingExecute,
        consolidateFn: async () => 'c',
        autoApprove: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    const types = eventTypes(db, wfRow.id);
    expect(types).toContain('task_credential_rotation_needed');
    expect(types).not.toContain('task_needs_compaction');

    db.close();
  });

  it('model_not_found (404) emits task_fallback_model_needed', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'x',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: null,
        },
      ],
    };

    const failingExecute = async (_t: Task): Promise<string> => {
      const err = Object.assign(new Error('Model not found'), { status: 404 });
      throw err;
    };

    let thrown: unknown;
    try {
      await executeWorkflow(db, dag, '__test__', 'x', {
        executeTaskFn: failingExecute,
        consolidateFn: async () => 'c',
        autoApprove: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    const types = eventTypes(db, wfRow.id);
    expect(types).toContain('task_fallback_model_needed');

    db.close();
  });

  it('model_not_found falls back to best-combo when the operator chain is exhausted', async () => {
    // SAFE-02 wiring: the operator/role fallback chain is consulted FIRST; this
    // test exhausts that chain (model is the tail of the executor-llm-call-default
    // role chain) so the executor must reach the doBestCombo fallback. Personas
    // are disabled so SAFE-01 remediation does not pre-swap the model.
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
    const db = setupDb();

    const tailModel = getFallbackChain('executor-llm-call-default').at(-1)!;

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'fallback task',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: tailModel,
        },
      ],
    };

    const modelsSeen: Array<string | null | undefined> = [];
    const executeFn = async (task: Task): Promise<string> => {
      modelsSeen.push(task.model);
      if (modelsSeen.length === 1) {
        throw Object.assign(new Error('Model not found'), { status: 404 });
      }
      return `ok via ${task.model}`;
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'c',
      autoApprove: true,
      sleepFn: async () => {},
      bestComboFn: async () => ({
        ok: true,
        data: { model: 'fallback/provider-model', tier: 'standard' },
      }),
    });

    expect(wf.status).toBe('completed');
    expect(modelsSeen).toEqual([tailModel, 'fallback/provider-model']);

    const taskRow = db
      .prepare('SELECT status, model, model_used, output_json FROM tasks WHERE workflow_id = ?')
      .get(wf.id) as { status: string; model: string | null; model_used: string | null; output_json: string };
    expect(taskRow.status).toBe('completed');
    expect(taskRow.model).toBe('fallback/provider-model');
    expect(taskRow.model_used).toBe('fallback/provider-model');
    expect(taskRow.output_json).toContain('fallback/provider-model');

    const types = eventTypes(db, wf.id);
    expect(types).toContain('task_fallback_model_needed');
    expect(types).toContain('task_fallback_model_selected');

    const selected = payloadsOfType(db, wf.id, 'task_fallback_model_selected') as Array<{
      source?: string;
      fallback_model?: string;
    }>;
    expect(selected[0]?.source).toBe('best_combo');

    db.close();
  });

  it('retryable error (500) does classify and retry with backoff metadata', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'x',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: null,
        },
      ],
    };

    let calls = 0;
    const executeFn = async (_t: Task): Promise<string> => {
      calls += 1;
      if (calls < 2) {
        const err = Object.assign(new Error('Internal server error'), { status: 500 });
        throw err;
      }
      return 'ok';
    };

    // Execute without throwing — 2nd attempt should succeed.
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'c',
      autoApprove: true,
      sleepFn: async () => {}, // skip real backoff sleep
    });

    const types = eventTypes(db, wf.id);
    expect(types).toContain('task_failover_classified');
    expect(types).toContain('task_retrying');

    const classified = payloadsOfType(db, wf.id, 'task_failover_classified') as Array<{
      reason: string;
    }>;
    expect(classified[0]?.reason).toBe('server_error');

    const retrying = payloadsOfType(db, wf.id, 'task_retrying') as Array<{
      backoff_ms: number;
      reason: string;
    }>;
    expect(retrying[0]?.reason).toBe('server_error');
    expect(retrying[0]?.backoff_ms).toBeGreaterThan(0);

    db.close();
  });
});

describe('reviewer failure — typed ReviewOutcome emission', () => {
  it('hanging reviewer emits task_review_outcome with hard_failure', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'produce',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          acceptance_criteria: 'must be good',
          model: null,
        },
      ],
    };

    const hangingReviewer = () => new Promise<ReviewResult>(() => {});
    let thrown: unknown;
    try {
      await executeWorkflow(db, dag, '__test__', 'x', {
        executeTaskFn: async () => 'some output',
        reviewFn: hangingReviewer,
        consolidateFn: async () => 'c',
        autoApprove: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();

    const wfRow = db.prepare("SELECT * FROM workflows WHERE id != '_daemon' LIMIT 1").get() as Workflow;
    const outcomes = payloadsOfType(db, wfRow.id, 'task_review_outcome') as ReviewOutcome[];
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    expect(outcomes[0]?.outcome_type).toBe('hard_failure');
    expect(outcomes[0]?.confidence).toBe(0);
    expect(outcomes[0]?.next_action).toBe('abort');
    expect(outcomes[0]?.feedback).toMatch(/timeout/i);

    db.close();
  });

  it('refine exhausted emits soft_failure ReviewOutcome while keeping task completed', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'produce',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          acceptance_criteria: 'strict',
          max_refine: 1,
          model: null,
        },
      ],
    };

    const failingReviewer = async (): Promise<ReviewResult> => ({
      score: 0.3,
      feedback: 'not good enough',
      passed: false,
    });

    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: async () => 'best effort output',
      reviewFn: failingReviewer,
      consolidateFn: async () => 'c',
      autoApprove: true,
    });

    const types = eventTypes(db, wf.id);
    expect(types).toContain('task_refine_exhausted');
    expect(types).toContain('task_review_outcome');

    const outcomes = payloadsOfType(db, wf.id, 'task_review_outcome') as ReviewOutcome[];
    const softFail = outcomes.find((o) => o.outcome_type === 'soft_failure');
    expect(softFail).toBeDefined();
    expect(softFail?.caveats).toContain('refine_exhausted');

    // Task still marked completed (V1 best-effort semantic preserved)
    const tasks = db.prepare('SELECT status FROM tasks WHERE workflow_id = ?').all(wf.id) as {
      status: string;
    }[];
    expect(tasks[0]?.status).toBe('completed');

    db.close();
  });
});

describe('consolidation error — classified reason in payload', () => {
  it('consolidator throwing non-timeout error records classified reason', async () => {
    const db = setupDb();

    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'do',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          acceptance_criteria: null,
          model: null,
        },
      ],
    };

    const throwingConsolidator = async (): Promise<string> => {
      const err = Object.assign(new Error('Service unavailable'), { status: 503 });
      throw err;
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: async () => 'out',
      consolidateFn: throwingConsolidator,
      autoApprove: true,
    });

    expect(wf.status).toBe('completed'); // V1 semantic — non-fatal

    const payloads = payloadsOfType(db, wf.id, 'workflow_consolidation_error') as Array<{
      reason: string;
    }>;
    expect(payloads[0]?.reason).toBe('overloaded');

    db.close();
  });
});
