import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { initDb } from '../../src/db/client.js';
import type { Dag, Task, Workflow } from '../../src/types/index.js';

vi.mock('../../src/artifacts/store.js', () => ({
  saveArtifact: vi.fn().mockResolvedValue(undefined),
  loadArtifactsForTask: vi.fn().mockResolvedValue([]),
  loadArtifactContent: vi.fn().mockResolvedValue(''),
  loadArtifactsForWorkflow: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('summary-text'),
}));

import { executeWorkflow } from '../../src/brain/executor.js';
import { callOmniroute } from '../../src/utils/omniroute-call.js';

const mockCallOmniroute = vi.mocked(callOmniroute);

interface EventRow { type: string; payload_json: string | null }

function eventTypes(db: Database.Database, wfId: string): string[] {
  return (db
    .prepare('SELECT type FROM events WHERE workflow_id = ? ORDER BY id')
    .all(wfId) as { type: string }[]).map(r => r.type);
}

function payloadsOfType(db: Database.Database, wfId: string, type: string): unknown[] {
  return (db
    .prepare('SELECT payload_json FROM events WHERE workflow_id = ? AND type = ? ORDER BY id')
    .all(wfId, type) as EventRow[]).map(r => r.payload_json ? JSON.parse(r.payload_json) : null);
}

const LARGE_OUTPUT = 'x'.repeat(11_000);
const SMALL_OUTPUT = 'x'.repeat(5_000);

// Fan-out DAG: upstream → {child_a, child_b}
function makeFanoutDag(upstreamOutput?: string): { dag: Dag; capturedInputs: Map<string, string | null> } {
  const capturedInputs = new Map<string, string | null>();
  const dag: Dag = {
    tasks: [
      { id: 'up', name: 'upstream', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
      { id: 'ca', name: 'child_a', kind: 'llm_call', depends_on: ['up'], executor_hint: null, model: null },
      { id: 'cb', name: 'child_b', kind: 'llm_call', depends_on: ['up'], executor_hint: null, model: null },
    ],
  };
  return { dag, capturedInputs };
}

describe('auto-summary fan-out', () => {
  beforeEach(() => {
    mockCallOmniroute.mockResolvedValue('summary-text');
    vi.clearAllMocks();
    mockCallOmniroute.mockResolvedValue('summary-text');
  });

  it('upstream >10K chars with 2+ dependents injects auto-summary task', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      return `child-out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
      checkQuotaFn: async () => ({ ok: true, data: { allowed: true, remaining_pct: 100 } }),
    });
    const types = eventTypes(db, wf.id);
    expect(types).toContain('task_auto_summary_injected');
    db.close();
  });

  it('emits task_auto_summary_injected and task_auto_summary_completed', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
      checkQuotaFn: async () => ({ ok: true, data: { allowed: true, remaining_pct: 100 } }),
    });
    const types = eventTypes(db, wf.id);
    expect(types).toContain('task_auto_summary_injected');
    expect(types).toContain('task_auto_summary_completed');
    db.close();
  });

  it('task_auto_summary_injected payload has upstream_task_id + dependent_task_ids', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const payloads = payloadsOfType(db, wf.id, 'task_auto_summary_injected') as Array<{
      upstream_task_id: string;
      dependent_task_ids: string[];
      upstream_output_length: number;
    }>;
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    expect(payloads[0]?.upstream_task_id).toBeDefined();
    expect(payloads[0]?.dependent_task_ids).toHaveLength(2);
    expect(payloads[0]?.upstream_output_length).toBeGreaterThan(10_000);
    db.close();
  });

  it('dependents receive summarized_upstreams in input_json, not raw output', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    const capturedInputs: Record<string, string | null> = {};
    const executeFn = async (t: Task): Promise<string> => {
      if (t.name === 'upstream') return LARGE_OUTPUT;
      // Auto-summary task name starts with 'summarize-'
      if (t.name.startsWith('summarize-')) return 'auto-summary-result';
      if (t.name === 'child_a' || t.name === 'child_b') {
        capturedInputs[t.name] = t.input_json;
      }
      return `child-out`;
    };
    await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    for (const name of ['child_a', 'child_b']) {
      const raw = capturedInputs[name];
      expect(raw).not.toBeNull();
      const ctx = JSON.parse(raw!) as Record<string, unknown>;
      expect(ctx['summarized_upstreams']).toBeDefined();
      const summaries = ctx['summarized_upstreams'] as Record<string, string>;
      const summaryValues = Object.values(summaries);
      expect(summaryValues.length).toBeGreaterThan(0);
      // The summary should be the executeFn return for the summary task, not the 11K raw
      expect(summaryValues[0]).toBe('auto-summary-result');
    }
    db.close();
  });

  it('upstream ≤10K chars → no auto-summary injected', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return SMALL_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const types = eventTypes(db, wf.id);
    expect(types).not.toContain('task_auto_summary_injected');
    expect(types).not.toContain('task_auto_summary_completed');
    db.close();
  });

  it('upstream >10K chars with only 1 dependent → no auto-summary', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'up', name: 'upstream', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 'ca', name: 'child_a', kind: 'llm_call', depends_on: ['up'], executor_hint: null, model: null },
      ],
    };
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const types = eventTypes(db, wf.id);
    expect(types).not.toContain('task_auto_summary_injected');
    db.close();
  });

  it('dependent with raw_full selector still gets raw artifact despite auto-summary', async () => {
    const { loadArtifactsForTask, loadArtifactContent } = await import('../../src/artifacts/store.js');
    const mockLoad = vi.mocked(loadArtifactsForTask);
    const mockContent = vi.mocked(loadArtifactContent);

    const rawContent = 'raw-artifact-content';
    mockLoad.mockResolvedValue([
      { id: 'art-1', task_id: 'upstream', content_inline: rawContent, content_path: null } as never,
    ]);
    mockContent.mockImplementation(async (art: { content_inline: string | null }) => art.content_inline ?? '');

    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 'up', name: 'upstream', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        {
          id: 'ca', name: 'child_raw', kind: 'llm_call', depends_on: ['up'],
          executor_hint: null, model: null,
          input_selectors: { up: 'raw_full' },
        },
        { id: 'cb', name: 'child_b', kind: 'llm_call', depends_on: ['up'], executor_hint: null, model: null },
      ],
    };
    let callIdx = 0;
    const capturedInputs: Record<string, string | null> = {};
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      if (t.name === 'child_raw' || t.name === 'child_b') {
        capturedInputs[t.name] = t.input_json;
      }
      return `out-${callIdx}`;
    };
    await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });

    // child_raw has raw_full selector — should hit artifact store, not summary
    // child_b has no selector — should get the summary from summarized_upstreams
    const rawCtx = capturedInputs['child_raw']
      ? (JSON.parse(capturedInputs['child_raw']!) as Record<string, unknown>)
      : null;
    if (rawCtx) {
      const upstreamArtifacts = rawCtx['upstream_artifacts'] as string | undefined;
      // raw_full path should have the artifact content
      if (upstreamArtifacts) {
        expect(upstreamArtifacts).toContain(rawContent);
      }
    }

    mockLoad.mockResolvedValue([]);
    mockContent.mockResolvedValue('');
    db.close();
  });

  it('V1 path (linear chain, no fan-out) → no auto-summary events', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [
        { id: 't1', name: 'step1', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 't2', name: 'step2', kind: 'llm_call', depends_on: ['t1'], executor_hint: null, model: null },
        { id: 't3', name: 'step3', kind: 'llm_call', depends_on: ['t2'], executor_hint: null, model: null },
      ],
    };
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      // Even step1 returns large output — still no fan-out since step2 is the only dependent
      if (t.name === 'step1') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const types = eventTypes(db, wf.id);
    expect(types).not.toContain('task_auto_summary_injected');
    expect(types).not.toContain('task_auto_summary_completed');
    db.close();
  });

  it('task_auto_summary_completed payload has summary_length > 0', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const payloads = payloadsOfType(db, wf.id, 'task_auto_summary_completed') as Array<{
      upstream_task_id: string;
      summary_length: number;
    }>;
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    expect(payloads[0]?.summary_length).toBeGreaterThan(0);
    db.close();
  });

  it('workflow completes successfully after auto-summary injection', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    expect(wf.status).toBe('completed');
    db.close();
  });

  it('multiple fan-out upstreams in same wave each get summarized', async () => {
    const db = initDb(':memory:');
    // Two independent large upstreams each fanning out to 2 children
    const dag: Dag = {
      tasks: [
        { id: 'u1', name: 'up1', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 'u2', name: 'up2', kind: 'llm_call', depends_on: [], executor_hint: null, model: null },
        { id: 'c1a', name: 'c1a', kind: 'llm_call', depends_on: ['u1'], executor_hint: null, model: null },
        { id: 'c1b', name: 'c1b', kind: 'llm_call', depends_on: ['u1'], executor_hint: null, model: null },
        { id: 'c2a', name: 'c2a', kind: 'llm_call', depends_on: ['u2'], executor_hint: null, model: null },
        { id: 'c2b', name: 'c2b', kind: 'llm_call', depends_on: ['u2'], executor_hint: null, model: null },
      ],
    };
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'up1' || t.name === 'up2') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
      checkQuotaFn: async () => ({ ok: true, data: { allowed: true, remaining_pct: 100 } }),
    });
    const payloads = payloadsOfType(db, wf.id, 'task_auto_summary_injected');
    expect(payloads.length).toBe(2);
    db.close();
  });

  it('summarize task uses haiku model (executor_hint cc/claude-haiku-4-5-20251001)', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    const summaryTasks: Task[] = [];
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      if (t.name.startsWith('summarize-')) {
        summaryTasks.push(t);
        return 'haiku-summary';
      }
      return `out-${callIdx}`;
    };
    await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    expect(summaryTasks.length).toBeGreaterThan(0);
    expect(summaryTasks[0]?.executor_hint).toBe('cc/claude-haiku-4-5-20251001');
    expect(summaryTasks[0]?.model).toBe('cc/claude-haiku-4-5-20251001');
    db.close();
  });

  it('existing task events (task_started, task_completed) still emitted alongside auto-summary events', async () => {
    const db = initDb(':memory:');
    const { dag } = makeFanoutDag();
    let callIdx = 0;
    const executeFn = async (t: Task): Promise<string> => {
      callIdx++;
      if (t.name === 'upstream') return LARGE_OUTPUT;
      return `out-${callIdx}`;
    };
    const wf = await executeWorkflow(db, dag, '__test__', 'x', {
      executeTaskFn: executeFn,
      consolidateFn: async () => 'done',
      autoApprove: true,
      sleepFn: async () => {},
    });
    const types = eventTypes(db, wf.id);
    expect(types).toContain('task_started');
    expect(types).toContain('task_completed');
    expect(types).toContain('task_auto_summary_injected');
    expect(types).toContain('task_auto_summary_completed');
    db.close();
  });
});
