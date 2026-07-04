import { describe, it, expect, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import {
  recordModelCall,
  listModelCallsForWorkflow,
} from '../../src/v2/llm-ledger/store.js';
import {
  getCostByModel,
  getCostByTask,
  getCostSummary,
} from '../../src/db/persist.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import type { Dag } from '../../src/types/index.js';

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('legacy output'),
  callOmnirouteWithUsage: vi.fn().mockResolvedValue({
    content: 'llm output',
    model_used: 'cc/claude-sonnet-4-6',
    usage: { input_tokens: 12, output_tokens: 8, total_cost_usd: 0.02 },
  }),
}));

describe('LLM ledger', () => {
  it('creates model_calls table through migrations', () => {
    const db = initDb(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('model_calls');
    db.close();
  });

  it('records model call usage for replay and cost inspection', () => {
    const db = initDb(':memory:');
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES ('wf_ledger', 'internal', 'ledger', 'pending', ?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO tasks
       (id, workflow_id, name, kind, status, depends_on_json,
        max_retries, retry_count, retry_policy, refine_count, max_refine,
        hitl, created_at)
       VALUES ('tk_ledger', 'wf_ledger', 'Task', 'llm_call', 'pending', '[]',
               0, 0, 'none', 0, 0, 0, ?)`,
    ).run(Date.now());

    const row = recordModelCall(db, {
      workflowId: 'wf_ledger',
      taskId: 'tk_ledger',
      model: 'cc/claude-sonnet-4-6',
      provider: 'cc',
      inputTokens: 12,
      outputTokens: 8,
      costUsd: 0.02,
      latencyMs: 123,
      source: 'executor',
    });

    expect(row.id).toMatch(/^mc_/);
    expect(row.model).toBe('cc/claude-sonnet-4-6');
    expect(row.cost_usd).toBeCloseTo(0.02, 6);
    expect(listModelCallsForWorkflow(db, 'wf_ledger')).toHaveLength(1);
    db.close();
  });

  it('aggregates workflow model-call cost by task and model', () => {
    const db = initDb(':memory:');
    db.prepare(
      `INSERT INTO workflows (id, workspace, objective, status, created_at)
       VALUES ('wf_costs', 'internal', 'costs', 'pending', ?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO tasks
       (id, workflow_id, name, kind, status, depends_on_json,
        max_retries, retry_count, retry_policy, refine_count, max_refine,
        hitl, created_at)
       VALUES
       ('tk_a', 'wf_costs', 'Draft', 'llm_call', 'completed', '[]', 0, 0, 'none', 0, 0, 0, ?),
       ('tk_b', 'wf_costs', 'Review', 'llm_call', 'completed', '[]', 0, 0, 'none', 0, 0, 0, ?)`,
    ).run(Date.now(), Date.now());

    recordModelCall(db, {
      workflowId: 'wf_costs',
      taskId: 'tk_a',
      model: 'cc/claude-sonnet-4-6',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.03,
    });
    recordModelCall(db, {
      workflowId: 'wf_costs',
      taskId: 'tk_a',
      model: 'cc/claude-sonnet-4-6',
      inputTokens: 20,
      outputTokens: 10,
      costUsd: 0.07,
    });
    recordModelCall(db, {
      workflowId: 'wf_costs',
      taskId: 'tk_b',
      model: 'cx/gpt-5.5',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.4,
    });

    expect(getCostSummary(db, 'wf_costs')).toMatchObject({
      workflow_id: 'wf_costs',
      call_count: 3,
      input_tokens: 130,
      output_tokens: 65,
      total_tokens: 195,
      total_cost_usd: 0.5,
    });
    expect(getCostByTask(db, 'wf_costs')).toEqual([
      expect.objectContaining({ task_id: 'tk_b', task_name: 'Review', total_cost_usd: 0.4, call_count: 1 }),
      expect.objectContaining({ task_id: 'tk_a', task_name: 'Draft', total_cost_usd: 0.1, call_count: 2 }),
    ]);
    expect(getCostByModel(db, 'wf_costs')).toEqual([
      expect.objectContaining({ model: 'cx/gpt-5.5', provider: 'cx', total_cost_usd: 0.4, call_count: 1 }),
      expect.objectContaining({ model: 'cc/claude-sonnet-4-6', provider: 'cc', total_cost_usd: 0.1, call_count: 2 }),
    ]);
    db.close();
  });

  it('executor persists Omniroute usage on task row and model_calls ledger', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [{ id: 't1', name: 'LLM task', kind: 'llm_call', depends_on: [] }],
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'ledger workflow', {
      consolidateFn: async () => 'done',
      reviewFn: async () => ({ score: 1, feedback: 'ok', passed: true }),
      autoApprove: true,
      sleepFn: async () => {},
      costReportFn: async () => ({ ok: true, data: { total_usd: 0.02, by_task: [] } }),
    });

    const task = db
      .prepare('SELECT input_tokens, output_tokens, model_used FROM tasks WHERE workflow_id = ?')
      .get(wf.id) as { input_tokens: number; output_tokens: number; model_used: string };
    expect(task.input_tokens).toBe(12);
    expect(task.output_tokens).toBe(8);
    expect(task.model_used).toBe('cc/claude-sonnet-4-6');

    const calls = listModelCallsForWorkflow(db, wf.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cost_usd).toBeCloseTo(0.02, 6);
    db.close();
  });
});
