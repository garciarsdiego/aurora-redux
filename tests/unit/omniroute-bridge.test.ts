import { describe, it, expect, afterEach, vi } from 'vitest';
import { initDb } from '../../src/db/client.js';
import { executeWorkflow } from '../../src/brain/executor.js';
import {
  checkQuota,
  costReport,
  bestComboForTask,
  memorySearch,
  webSearch,
} from '../../src/v2/omniroute-bridge/client.js';
import type { Dag } from '../../src/types/index.js';

// Suppress callOmniroute (context compaction) in executor tests.
vi.mock('../../src/utils/omniroute-call.js', () => ({
  callOmniroute: vi.fn().mockResolvedValue('mock compact summary'),
}));

// ---------------------------------------------------------------------------
// Bridge client — HTTP happy/sad paths
// ---------------------------------------------------------------------------

describe('omniroute-bridge client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('check_quota returns ok:true with { allowed, remaining_pct } when Omniroute up', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ allowed: true, remaining_pct: 85 }),
    }));
    const result = await checkQuota('my-workspace');
    expect(result.ok).toBe(true);
    expect(result.data?.allowed).toBe(true);
    expect(result.data?.remaining_pct).toBe(85);
    expect(result.error).toBeUndefined();
  });

  it('check_quota returns ok:false with error when Omniroute down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await checkQuota('my-workspace');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('circuit breaker: TimeoutError returns fallback data without throw', async () => {
    const timeoutErr = Object.assign(
      new Error('The operation timed out.'),
      { name: 'TimeoutError' },
    );
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));
    const result = await checkQuota('ws');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/i);
    // Quota checks fail closed by default so missing bridge auth/network cannot
    // silently permit expensive workflows.
    expect(result.data).toEqual({ allowed: false, remaining_pct: 0 });
  });

  it('cost_report returns typed { total_usd, by_task } structure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        total_usd: 1.25,
        by_task: [{ task_id: 'tk_abc', cost_usd: 1.25 }],
      }),
    }));
    const result = await costReport('wf_123');
    expect(result.ok).toBe(true);
    expect(typeof result.data?.total_usd).toBe('number');
    expect(Array.isArray(result.data?.by_task)).toBe(true);
    expect(result.data?.by_task[0]?.task_id).toBe('tk_abc');
  });

  it('best_combo_for_task returns { model, tier }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ model: 'cc/claude-sonnet-4-6', tier: 'premium' }),
    }));
    const result = await bestComboForTask('llm_call', 'high');
    expect(result.ok).toBe(true);
    expect(result.data?.model).toBe('cc/claude-sonnet-4-6');
    expect(result.data?.tier).toBe('premium');
  });

  it('memory_search returns array (may be empty)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    }));
    const result = await memorySearch('my query', 'workspace');
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data?.results)).toBe(true);
  });

  it('web_search HTTP error returns ok:false with fallback data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    }));
    const result = await webSearch('test query');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    // Fallback data is still present so consumers don't crash.
    expect(Array.isArray(result.data?.results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DB migrations
// ---------------------------------------------------------------------------

describe('DB migrations', () => {
  it('tasks table has input_tokens column after initDb', () => {
    const db = initDb(':memory:');
    const info = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    expect(info.map(r => r.name)).toContain('input_tokens');
    db.close();
  });

  it('workflows table has total_cost_usd column after initDb', () => {
    const db = initDb(':memory:');
    const info = db.prepare('PRAGMA table_info(workflows)').all() as { name: string }[];
    expect(info.map(r => r.name)).toContain('total_cost_usd');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// Executor integration
// ---------------------------------------------------------------------------

describe('executor integration', () => {
  it('does not pre-block large workflows when quota guard is off by default', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        name: `Task ${i}`,
        kind: 'llm_call' as const,
        depends_on: i === 0 ? [] : [`t${i - 1}`],
      })),
    };
    const checkQuotaFn = vi.fn().mockResolvedValue({
      ok: true,
      data: { allowed: false, remaining_pct: 0 },
    });

    const wf = await executeWorkflow(db, dag, '__test__', 'quota off test', {
      executeTaskFn: async () => 'ok',
      consolidateFn: async () => 'ok',
      autoApprove: true,
      checkQuotaFn,
    });

    expect(wf.status).toBe('completed');
    expect(checkQuotaFn).not.toHaveBeenCalled();
    db.close();
  });

  it('emits workflow_quota_blocked when check_quota returns !allowed', async () => {
    const db = initDb(':memory:');
    // Need >5 tasks to trigger quota check.
    const dag: Dag = {
      tasks: Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        name: `Task ${i}`,
        kind: 'llm_call' as const,
        depends_on: i === 0 ? [] : [`t${i - 1}`],
      })),
    };

    let thrown: unknown;
    try {
      await executeWorkflow(db, dag, '__test__', 'quota test', {
        executeTaskFn: async () => 'ok',
        consolidateFn: async () => 'ok',
        autoApprove: true,
        quotaGuardMode: 'enforce',
        checkQuotaFn: async () => ({ ok: true, data: { allowed: false, remaining_pct: 5 } }),
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    expect((thrown as Error).message).toMatch(/quota/i);

    const wfRow = db.prepare("SELECT id FROM workflows WHERE id != '_daemon' LIMIT 1").get() as { id: string };
    const blocked = db
      .prepare("SELECT type FROM events WHERE workflow_id = ? AND type = 'workflow_quota_blocked'")
      .all(wfRow.id) as { type: string }[];
    expect(blocked.length).toBeGreaterThan(0);
    db.close();
  });

  it('total_cost_usd persists in workflow row after execution', async () => {
    const db = initDb(':memory:');
    const dag: Dag = {
      tasks: [{ id: 't1', name: 'Task 1', kind: 'llm_call', depends_on: [] }],
    };

    const wf = await executeWorkflow(db, dag, '__test__', 'cost test', {
      executeTaskFn: async () => 'output',
      consolidateFn: async () => 'ok',
      autoApprove: true,
      costReportFn: async () => ({ ok: true, data: { total_usd: 3.14, by_task: [] } }),
    });

    const row = db
      .prepare('SELECT total_cost_usd FROM workflows WHERE id = ?')
      .get(wf.id) as { total_cost_usd: number };
    expect(row.total_cost_usd).toBeCloseTo(3.14, 5);
    db.close();
  });
});
