// SAFE-01 + SAFE-02 wiring regression suite.
//
// SAFE-02: the operator-authored Setup → Fallback chain (and the hardcoded
// per-role chain) must be consulted BEFORE doBestCombo on a shouldFallback
// (model_not_found) error. This suite proves selectFallbackModel wins and that
// doBestCombo is only the last resort.
//
// SAFE-01: when OMNIFORGE_USE_PERSONAS is true, the persona failover classifier
// (classifyErrorWithPersona + applyClassifierMutations) runs on the failure
// path and applies its self-healing mutations (prompt-prefix hardening /
// model swap / workspace clean) to the live task. This suite proves the persona
// path is taken (via the deterministic known-pattern shortcut, no LLM call) and
// that the prompt-prefix hardening lands in the task objective.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { executeWorkflow } from '../../src/brain/executor.js';
import { initDb } from '../../src/db/client.js';
import type { Dag, Task } from '../../src/types/index.js';
import { setFallbackConfig } from '../../src/utils/setup-config.js';

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
let tmpDir: string;

beforeEach(() => {
  // Keep retries fast and force any incidental Omniroute calls (persona LLM,
  // engine.compact) to fail fast against a refused port.
  process.env.MAX_REVIEW_TIME_MS = '150';
  process.env.MAX_CONSOLIDATE_TIME_MS = '150';
  process.env.OMNIROUTE_URL = 'http://localhost:1';
  tmpDir = mkdtempSync(join(tmpdir(), 'omniforge-self-healing-'));
  process.env.OMNIFORGE_SETUP_CONFIG_PATH = join(tmpDir, 'setup-config.json');
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SAFE-02 — operator fallback chain consulted before doBestCombo', () => {
  it('uses the operator-authored chain and never calls doBestCombo when the chain advances', async () => {
    // Personas off so SAFE-01 remediation does not also touch the model — this
    // test isolates the SAFE-02 chain path.
    process.env.OMNIFORGE_USE_PERSONAS = 'false';

    setFallbackConfig({
      enabled: true,
      chain: [
        { provider: 'op', model: 'op/primary' },
        { provider: 'op', model: 'op/secondary' },
      ],
    });

    const db = setupDb();
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'operator chain task',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: 'op/primary',
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

    let bestComboCalls = 0;
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'c',
      autoApprove: true,
      sleepFn: async () => {},
      bestComboFn: async () => {
        bestComboCalls += 1;
        return { ok: true, data: { model: 'bestcombo/should-not-be-used', tier: 'standard' } };
      },
    });

    expect(wf.status).toBe('completed');
    // Second attempt used the operator chain's next entry, NOT best-combo.
    expect(modelsSeen).toEqual(['op/primary', 'op/secondary']);
    expect(bestComboCalls).toBe(0);

    const selected = payloadsOfType(db, wf.id, 'task_fallback_model_selected') as Array<{
      source?: string;
      fallback_model?: string;
    }>;
    expect(selected[0]?.source).toBe('operator_chain');
    expect(selected[0]?.fallback_model).toBe('op/secondary');

    db.close();
  });

  it('falls back to doBestCombo only once the operator chain is exhausted', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'false';

    setFallbackConfig({
      enabled: true,
      // Single-entry chain → current model is the tail → chain exhausted.
      chain: [{ provider: 'op', model: 'op/only' }],
    });

    const db = setupDb();
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'exhausted chain task',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: 'op/only',
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

    let bestComboCalls = 0;
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'c',
      autoApprove: true,
      sleepFn: async () => {},
      bestComboFn: async () => {
        bestComboCalls += 1;
        return { ok: true, data: { model: 'bestcombo/rescue', tier: 'standard' } };
      },
    });

    expect(wf.status).toBe('completed');
    expect(modelsSeen).toEqual(['op/only', 'bestcombo/rescue']);
    expect(bestComboCalls).toBe(1);

    const selected = payloadsOfType(db, wf.id, 'task_fallback_model_selected') as Array<{
      source?: string;
    }>;
    expect(selected[0]?.source).toBe('best_combo');

    db.close();
  });
});

describe('Aurora-parity Wave 2 — budget errors are terminal (never retried)', () => {
  it('a BudgetExceededError from the executor fails the task without retrying', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'false';
    const { BudgetExceededError } = await import('../../src/v2/budget/control.js');

    const db = setupDb();
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'budget gated task',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: 'op/x',
        },
      ],
    };

    let calls = 0;
    const executeFn = async (_t: Task): Promise<string> => {
      calls += 1;
      throw new BudgetExceededError('wf', 0.5, 0.1);
    };

    // A terminally-failed task rejects the workflow (orchestrate wraps lastErr
    // with the task name, so the raw type isn't preserved — the no-retry +
    // task_budget_terminal evidence below is the real signal).
    await expect(
      executeWorkflow(db, dag, '__test__', 'x', {
        executeTaskFn: executeFn,
        consolidateFn: async () => 'c',
        autoApprove: true,
        sleepFn: async () => {},
        bestComboFn: async () => ({ ok: true, data: { model: 'x', tier: 'standard' } }),
      }),
    ).rejects.toThrow();
    void BudgetExceededError; // imported for the throw in executeFn

    // Terminal: the executor ran exactly ONCE — the loop did NOT retry the gate.
    expect(calls).toBe(1);
    const retrying = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task_retrying'").get() as { n: number };
    expect(retrying.n).toBe(0);
    const terminal = db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'task_budget_terminal'").get() as { n: number };
    expect(terminal.n).toBe(1);

    db.close();
  });
});

describe('Aurora-parity Wave-1.5 #1 — server Retry-After honoured end-to-end', () => {
  it('backs off for the server retry-after window, not the rate_limit 10s default', async () => {
    // Personas off — rate_limit is transient (persona remediation is skipped
    // for it anyway), but disabling keeps the path minimal and deterministic.
    process.env.OMNIFORGE_USE_PERSONAS = 'false';

    const db = setupDb();
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'rate limited task',
          kind: 'llm_call',
          depends_on: [],
          executor_hint: null,
          model: 'op/primary',
        },
      ],
    };

    let calls = 0;
    const executeFn = async (_task: Task): Promise<string> => {
      calls += 1;
      if (calls === 1) {
        // Mirrors what omniroute-call attaches on a non-OK 429 response.
        throw Object.assign(new Error('Omniroute HTTP 429: rate limited'), {
          status: 429,
          responseHeaders: { 'retry-after': '7' },
        });
      }
      return `ok via ${_task.model}`;
    };

    const sleeps: number[] = [];
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'c',
      autoApprove: true,
      sleepFn: async (ms: number) => {
        sleeps.push(ms);
      },
      bestComboFn: async () => ({ ok: true, data: { model: 'unused/model', tier: 'standard' } }),
    });

    expect(wf.status).toBe('completed');
    expect(calls).toBeGreaterThanOrEqual(2);

    const retrying = payloadsOfType(db, wf.id, 'task_retrying') as Array<{
      backoff_ms?: number;
      reason?: string;
      retry_after_ms?: number | null;
    }>;
    expect(retrying.length).toBeGreaterThanOrEqual(1);
    expect(retrying[0]?.reason).toBe('rate_limit');
    // Honoured the 7s server window — NOT the hardcoded 10_000 rate_limit default.
    expect(retrying[0]?.backoff_ms).toBe(7_000);
    expect(retrying[0]?.retry_after_ms).toBe(7_000);
    // And the executor actually slept that long before the retry.
    expect(sleeps).toContain(7_000);
    expect(sleeps).not.toContain(10_000);

    db.close();
  });
});

describe('SAFE-01 — persona classifier path taken under getUsePersonas', () => {
  it('runs the persona remediation and hardens the prompt via the known-pattern shortcut', async () => {
    // Personas ON (default). The failure message matches the deterministic
    // `worker.described_without_writing` known-pattern shortcut, so the persona
    // classifier resolves WITHOUT an LLM call and returns a prompt_prefix +
    // workspace mutation. We prove the persona path is taken (events emitted)
    // and the objective is hardened on the retry.
    process.env.OMNIFORGE_USE_PERSONAS = 'true';

    const db = setupDb();
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'persona heal task',
          kind: 'cli_spawn',
          depends_on: [],
          executor_hint: 'cli:claude-code',
          model: 'cc/claude-sonnet-4-6',
        },
      ],
    };

    const objectivesSeen: Array<string | undefined> = [];
    let calls = 0;
    const executeFn = async (task: Task): Promise<string> => {
      calls += 1;
      const parsed = task.input_json ? (JSON.parse(task.input_json) as Record<string, unknown>) : {};
      objectivesSeen.push(typeof parsed['objective'] === 'string' ? parsed['objective'] : undefined);
      if (calls === 1) {
        // Message that trips the described_without_writing shortcut.
        throw new Error('worker described_without_writing: read files but never wrote.');
      }
      return 'wrote the file this time';
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'c',
      autoApprove: true,
      sleepFn: async () => {},
      // doBestCombo should not be needed; the error is `unknown` (retryable),
      // not model_not_found. Provide a stub anyway.
      bestComboFn: async () => ({ ok: true, data: { model: 'unused/model', tier: 'standard' } }),
    });

    expect(wf.status).toBe('completed');
    expect(calls).toBeGreaterThanOrEqual(2);

    const types = eventTypes(db, wf.id);
    // (b) the persona classifier path was taken.
    expect(types).toContain('task_persona_remediation');
    expect(types).toContain('task_persona_prompt_hardened');

    const remediation = payloadsOfType(db, wf.id, 'task_persona_remediation') as Array<{
      strategy?: string;
      shortcut_id?: string | null;
    }>;
    expect(remediation[0]?.strategy).toBe('retry_with_stronger_prompt');
    expect(remediation[0]?.shortcut_id).toBe('worker.described_without_writing');

    // The retry attempt saw the hardening prefix prepended to its objective.
    const retryObjective = objectivesSeen[1];
    expect(retryObjective).toBeDefined();
    expect(retryObjective).toMatch(/Write tool/i);

    db.close();
  });

  it('does NOT run persona remediation when personas are disabled', async () => {
    process.env.OMNIFORGE_USE_PERSONAS = 'false';

    const db = setupDb();
    const dag: Dag = {
      tasks: [
        {
          id: 't1',
          name: 'legacy only task',
          kind: 'cli_spawn',
          depends_on: [],
          executor_hint: 'cli:claude-code',
          model: 'cc/claude-sonnet-4-6',
        },
      ],
    };

    let calls = 0;
    const executeFn = async (_t: Task): Promise<string> => {
      calls += 1;
      if (calls === 1) {
        throw new Error('worker described_without_writing: read files but never wrote.');
      }
      return 'ok';
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'c',
      autoApprove: true,
      sleepFn: async () => {},
    });

    const types = eventTypes(db, wf.id);
    expect(types).not.toContain('task_persona_remediation');
    expect(types).not.toContain('task_persona_prompt_hardened');
    // Legacy classification still fires.
    expect(types).toContain('task_failover_classified');

    db.close();
  });
});
