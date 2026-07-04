import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TOOLS } from '../../src/mcp/server.js';

const mockDb = { close: vi.fn() };

vi.mock('../../src/db/client.js', () => ({
  initDb: vi.fn(() => mockDb),
}));

vi.mock('../../src/utils/config.js', () => ({
  getDbPath: vi.fn(() => ':memory:'),
}));

vi.mock('../../src/db/persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/persist.js')>();
  return {
    ...actual,
    loadWorkflowById: vi.fn(),
    loadWorkflowTasks: vi.fn(),
  };
});

const workflow = (status: string, overrides: Record<string, unknown> = {}) => ({
  id: 'wf_async',
  workspace: 'internal',
  objective: 'async task',
  status,
  pattern_id: null,
  started_at: 1000,
  completed_at: status === 'executing' ? null : 3000,
  created_at: 900,
  created_by: null,
  estimated_cost_usd: null,
  actual_cost_usd: null,
  metadata: null,
  ...overrides,
});

const task = (id: string, status: string) => ({
  id,
  workflow_id: 'wf_async',
  name: id,
  kind: 'llm_call',
  status,
  input_json: null,
  output_json: null,
  depends_on: [],
  executor_hint: null,
  timeout_seconds: 60,
  max_retries: 2,
  retry_count: 0,
  retry_policy: 'linear',
  started_at: 1100,
  completed_at: status === 'completed' ? 1900 : null,
  created_at: 950,
  acceptance_criteria: null,
  refine_count: 0,
  max_refine: 0,
  refine_feedback: null,
  model: null,
  hitl: false,
});

describe('task async MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    delete process.env.OMNIFORGE_DAEMON_TOKEN;
    delete process.env.OMNIFORGE_DAEMON_PORT;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('registers omniforge_task_await and omniforge_task_cancel', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('omniforge_task_await');
    expect(names).toContain('omniforge_task_cancel');
  });

  it('task_await returns immediately when workflow is already completed', async () => {
    const { loadWorkflowById, loadWorkflowTasks } = await import('../../src/db/persist.js');
    vi.mocked(loadWorkflowById).mockReturnValue(workflow('completed') as never);
    vi.mocked(loadWorkflowTasks).mockReturnValue([task('tk_1', 'completed')] as never);

    const { omniforgeTaskAwait } = await import('../../src/mcp/tools/task_async.js');
    const result = JSON.parse(await omniforgeTaskAwait({ task_id: 'wf_async' }));

    expect(result).toMatchObject({
      workflow_id: 'wf_async',
      status: 'completed',
      task_count: 1,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.summary).toContain('completed');
    expect(loadWorkflowById).toHaveBeenCalledTimes(1);
  });

  it('task_await polls every 2s until workflow reaches a terminal state', async () => {
    vi.useFakeTimers();
    const { loadWorkflowById, loadWorkflowTasks } = await import('../../src/db/persist.js');
    vi.mocked(loadWorkflowById)
      .mockReturnValueOnce(workflow('executing') as never)
      .mockReturnValueOnce(workflow('completed') as never);
    vi.mocked(loadWorkflowTasks).mockReturnValue([task('tk_1', 'completed'), task('tk_2', 'completed')] as never);

    const { omniforgeTaskAwait } = await import('../../src/mcp/tools/task_async.js');
    const pending = omniforgeTaskAwait({ task_id: 'wf_async', timeout_ms: 10_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = JSON.parse(await pending);

    expect(result.status).toBe('completed');
    expect(result.task_count).toBe(2);
    expect(loadWorkflowById).toHaveBeenCalledTimes(2);
  });

  it('task_await returns timeout status when deadline passes before completion', async () => {
    vi.useFakeTimers();
    const { loadWorkflowById, loadWorkflowTasks } = await import('../../src/db/persist.js');
    vi.mocked(loadWorkflowById).mockReturnValue(workflow('executing') as never);
    vi.mocked(loadWorkflowTasks).mockReturnValue([task('tk_1', 'running')] as never);

    const { omniforgeTaskAwait } = await import('../../src/mcp/tools/task_async.js');
    const pending = omniforgeTaskAwait({ task_id: 'wf_async', timeout_ms: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = JSON.parse(await pending);

    expect(result).toMatchObject({
      workflow_id: 'wf_async',
      status: 'timeout',
      task_count: 1,
    });
  });

  it('task_cancel calls the daemon cancel endpoint and returns normalized count', async () => {
    process.env.OMNIFORGE_DAEMON_TOKEN = 'unit-test-token';
    process.env.OMNIFORGE_DAEMON_PORT = '14567';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      wf_id: 'wf_async',
      cancelled: true,
      tasks_cancelled: 3,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const { omniforgeTaskCancel } = await import('../../src/mcp/tools/task_async.js');
    const result = JSON.parse(await omniforgeTaskCancel({ task_id: 'wf_async' }));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:14567/workflow/wf_async/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer unit-test-token' }),
      }),
    );
    expect(result).toEqual({ workflow_id: 'wf_async', cancelled: true, tasks_cancelled: 3 });
  });
});
