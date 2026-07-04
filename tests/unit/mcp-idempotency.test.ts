import { describe, it, expect, vi, beforeEach } from 'vitest';

// D34.5 Bug B regression — same workspace+objective must not spawn duplicate workflows.

const mockDb = { close: vi.fn() };

vi.mock('../../src/db/client.js', () => ({
  initDb: vi.fn(() => mockDb),
}));

vi.mock('../../src/utils/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/config.js')>();
  return { ...actual, getDbPath: vi.fn(() => ':memory:') };
});

vi.mock('../../src/utils/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/workspace.js')>();
  return {
    ...actual,
    loadWorkspaceEnv: vi.fn(),
  };
});

vi.mock('../../src/db/persist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/persist.js')>();
  return {
    ...actual,
    findExecutingWorkflow: vi.fn(),
    loadWorkflowTasks: vi.fn(),
    insertEvent: vi.fn(),
    setWorkflowDone: vi.fn(),
    // Bloco 5.3 added a pre-execution insertWorkflow (idempotency guard) —
    // mock it so the test does not exercise the SQL layer here.
    insertWorkflow: vi.fn(),
  };
});

vi.mock('../../src/patterns/store.js', () => ({
  listPatterns: vi.fn(() => []),
  bumpPatternUsage: vi.fn(),
}));

vi.mock('../../src/brain/patternMatcher.js', () => ({
  matchPattern: vi.fn().mockResolvedValue({ action: 'new' }),
}));

vi.mock('../../src/brain/decomposer.js', () => ({
  decompose: vi.fn().mockResolvedValue({
    tasks: [
      {
        id: 't1',
        name: 'task 1',
        kind: 'llm_call',
        depends_on: [],
        executor_hint: null,
        acceptance_criteria: null,
        model: null,
      },
    ],
  }),
}));

vi.mock('../../src/brain/executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/brain/executor.js')>();
  return {
    ...actual,
    executeWorkflow: vi.fn().mockResolvedValue({
      id: 'wf_new_001',
      status: 'completed',
      workspace: 'internal',
      objective: 'test',
      pattern_id: null,
    }),
  };
});

describe('runWorkflowTool idempotency (Bug B)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns existing workflow when one is already executing', async () => {
    const { findExecutingWorkflow, loadWorkflowTasks } = await import(
      '../../src/db/persist.js'
    );
    vi.mocked(findExecutingWorkflow).mockReturnValue({
      id: 'wf_already_running_123',
      workspace: 'internal',
      objective: 'do the thing',
      pattern_id: null,
      status: 'executing',
      started_at: 1_000_000,
      completed_at: null,
      created_at: 1_000_000,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    });
    vi.mocked(loadWorkflowTasks).mockReturnValue([
      {
        id: 'tk_001',
        workflow_id: 'wf_already_running_123',
        name: 'existing',
        kind: 'llm_call',
        input_json: null,
        output_json: null,
        status: 'running',
        depends_on: [],
        executor_hint: null,
        timeout_seconds: 300,
        max_retries: 3,
        retry_count: 0,
        retry_policy: 'exponential',
        started_at: null,
        completed_at: null,
        created_at: 1_000_000,
        acceptance_criteria: null,
        refine_count: 0,
        max_refine: 2,
        refine_feedback: null,
        model: null,
        hitl: false,
      },
    ]);

    const { runWorkflowTool } = await import(
      '../../src/mcp/tools/run_workflow.js'
    );
    const result = await runWorkflowTool({
      workspace: 'internal',
      objective: 'do the thing',
    });

    const parsed = JSON.parse(result);
    expect(parsed.workflow_id).toBe('wf_already_running_123');
    expect(parsed.already_running).toBe(true);
    expect(parsed.status).toBe('executing');
    expect(parsed.task_count).toBe(1);

    // Decompose must NOT have been called when an existing workflow was found
    const { decompose } = await import('../../src/brain/decomposer.js');
    expect(vi.mocked(decompose)).not.toHaveBeenCalled();

    const { executeWorkflow } = await import('../../src/brain/executor.js');
    expect(vi.mocked(executeWorkflow)).not.toHaveBeenCalled();
  });

  it('creates new workflow when no existing one matches', async () => {
    const { findExecutingWorkflow } = await import('../../src/db/persist.js');
    vi.mocked(findExecutingWorkflow).mockReturnValue(null);

    const { runWorkflowTool } = await import(
      '../../src/mcp/tools/run_workflow.js'
    );
    const result = await runWorkflowTool({
      workspace: 'internal',
      objective: 'brand new objective',
    });

    const parsed = JSON.parse(result);
    // Bloco 5.3 made run_workflow non-blocking: it pre-inserts a new wf row
    // (UUID) and returns immediately, before the background executeWorkflow
    // mock would otherwise emit 'wf_new_001'. Assert UUID shape, not literal.
    expect(parsed.workflow_id).toMatch(/^wf_[0-9a-f-]{36}$/);
    expect(parsed.status).toBe('started');
    expect(parsed.already_running).toBeUndefined();

    const { decompose } = await import('../../src/brain/decomposer.js');
    expect(vi.mocked(decompose)).toHaveBeenCalled();
  });

  it('rejects MCP auto_approve unless explicitly enabled by env', async () => {
    const previous = process.env.OMNIFORGE_MCP_ALLOW_AUTO_APPROVE;
    delete process.env.OMNIFORGE_MCP_ALLOW_AUTO_APPROVE;
    const { findExecutingWorkflow } = await import('../../src/db/persist.js');
    vi.mocked(findExecutingWorkflow).mockReturnValue(null);

    const { runWorkflowTool } = await import(
      '../../src/mcp/tools/run_workflow.js'
    );
    const result = await runWorkflowTool({
      workspace: 'internal',
      objective: 'dangerous auto approve',
      auto_approve: true,
    });

    const parsed = JSON.parse(result);
    expect(parsed.error).toMatch(/auto_approve/i);

    const { decompose } = await import('../../src/brain/decomposer.js');
    expect(vi.mocked(decompose)).not.toHaveBeenCalled();

    if (previous === undefined) delete process.env.OMNIFORGE_MCP_ALLOW_AUTO_APPROVE;
    else process.env.OMNIFORGE_MCP_ALLOW_AUTO_APPROVE = previous;
  });

  it('matches on workspace + objective (not one alone)', async () => {
    const { findExecutingWorkflow } = await import('../../src/db/persist.js');
    vi.mocked(findExecutingWorkflow).mockReturnValue(null);

    const { runWorkflowTool } = await import(
      '../../src/mcp/tools/run_workflow.js'
    );
    await runWorkflowTool({
      workspace: 'globex',
      objective: 'some task',
    });

    expect(vi.mocked(findExecutingWorkflow)).toHaveBeenCalledWith(
      mockDb,
      'globex',
      'some task',
    );
  });

  it('skips objective idempotency for explicit precomputed DAG runs', async () => {
    const { findExecutingWorkflow } = await import('../../src/db/persist.js');
    vi.mocked(findExecutingWorkflow).mockReturnValue({
      id: 'wf_old_same_objective',
      workspace: 'globex',
      objective: 'retry scoped task',
      pattern_id: null,
      status: 'executing',
      started_at: 1_000_000,
      completed_at: null,
      created_at: 1_000_000,
      created_by: null,
      estimated_cost_usd: null,
      actual_cost_usd: null,
      metadata: null,
    });

    const { runWorkflowTool } = await import(
      '../../src/mcp/tools/run_workflow.js'
    );
    const result = await runWorkflowTool({
      workspace: 'globex',
      objective: 'retry scoped task',
      precomputed_dag: JSON.stringify({
        tasks: [
          {
            id: 't0',
            name: 'Retry selected task',
            kind: 'llm_call',
            depends_on: [],
          },
        ],
      }),
    });

    const parsed = JSON.parse(result);
    expect(parsed.workflow_id).toMatch(/^wf_[0-9a-f-]{36}$/);
    expect(parsed.already_running).toBeUndefined();
    expect(vi.mocked(findExecutingWorkflow)).not.toHaveBeenCalled();

    const { decompose } = await import('../../src/brain/decomposer.js');
    expect(vi.mocked(decompose)).not.toHaveBeenCalled();
  });

  it('marks pre-inserted workflow failed when background execution throws before status is finalized', async () => {
    const { findExecutingWorkflow, insertEvent, setWorkflowDone } = await import(
      '../../src/db/persist.js'
    );
    vi.mocked(findExecutingWorkflow).mockReturnValue(null);

    const { executeWorkflow } = await import('../../src/brain/executor.js');
    vi.mocked(executeWorkflow).mockRejectedValueOnce(new Error('background boom'));

    const { runWorkflowTool } = await import(
      '../../src/mcp/tools/run_workflow.js'
    );
    const result = await runWorkflowTool({
      workspace: 'internal',
      objective: 'background failure objective',
    });

    const parsed = JSON.parse(result);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(setWorkflowDone)).toHaveBeenCalledWith(
      mockDb,
      parsed.workflow_id,
      'failed',
    );
    expect(vi.mocked(insertEvent)).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        workflow_id: parsed.workflow_id,
        type: 'workflow_background_error',
      }),
    );
  });
});
